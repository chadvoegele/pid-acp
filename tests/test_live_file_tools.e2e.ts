import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClient, waitFor } from "./helpers/client.ts";
import { requireLiveProvider } from "./helpers/live-provider.ts";
import {
	readStatus,
	readText,
	readToolId,
	requireToolUpdate,
} from "./helpers/updates.ts";

const evidence = { ...(await requireLiveProvider()), checks: [] as object[] };
const cwd = await mkdtemp(join(tmpdir(), "pid-acp-live-files-"));
const usedIds = new Set<string>();
let client: Awaited<ReturnType<typeof startClient>> | undefined;

async function performOperation(
	active: Awaited<ReturnType<typeof startClient>>,
	operation: string,
	instruction: string,
	answerMatches: (text: string) => boolean = (text) => text.trim().length > 0,
) {
	const started = Date.now();
	const updateStart = active.updates.length;
	const wireStart = active.wire.length;
	assert.equal(
		(
			await active.prompt(
				`${instruction} Use filesystem tools to perform the operation, then briefly report the result. Work only in the fixture workspace.`,
			)
		).stopReason,
		"end_turn",
	);
	await waitFor(() => {
		const updates = active.updates.slice(updateStart);
		const calls = updates.filter((u) => u.sessionUpdate === "tool_call");
		if (
			!calls.length ||
			!calls.every((call) =>
				updates.some(
					(u) =>
						readToolId(u) === call.toolCallId &&
						["completed", "failed"].includes(readStatus(u) ?? ""),
				),
			)
		)
			return false;
		const terminal = updates.findLastIndex((u) =>
			["completed", "failed"].includes(readStatus(u) ?? ""),
		);
		return answerMatches(
			updates
				.slice(terminal + 1)
				.map(readText)
				.join(""),
		);
	});
	const updates = active.updates.slice(updateStart);
	const tools = updates.filter((update) => readToolId(update) !== undefined);
	const initials = tools.filter(
		(update) => update.sessionUpdate === "tool_call",
	);
	assert.ok(initials.length > 0, "The operation must actually use tools.");
	const wire = active.wire.slice(wireStart);
	const responseIndex = wire.findIndex(
		(m) => m.result?.stopReason === "end_turn",
	);
	assert.ok(responseIndex >= 0);
	const calls = initials.map((initial) => {
		assert.ok(initial.toolCallId);
		assert.ok(!usedIds.has(initial.toolCallId), "New calls need fresh IDs.");
		usedIds.add(initial.toolCallId);
		assert.equal(initial.status, "in_progress");
		const callUpdates = tools.filter(
			(u) => readToolId(u) === initial.toolCallId,
		);
		assert.equal(callUpdates[0], initial);
		assert.equal(
			callUpdates.filter((u) => u.sessionUpdate === "tool_call").length,
			1,
		);
		const terminals = callUpdates.filter((u) =>
			["completed", "failed"].includes(readStatus(u) ?? ""),
		);
		assert.equal(terminals.length, 1);
		const final = requireToolUpdate(terminals[0]);
		assert.equal(final.sessionUpdate, "tool_call_update");
		assert.equal(callUpdates.at(-1), final);
		assert.ok(updates.indexOf(final) > updates.indexOf(initial));
		assert.ok(Array.isArray(final.rawOutput));
		assert.deepEqual(
			final.content,
			final.rawOutput.map((content) => ({ type: "content", content })),
		);
		const terminalIndex = wire.findIndex(
			(message) =>
				message.params?.update?.sessionUpdate === "tool_call_update" &&
				readToolId(message.params.update) === initial.toolCallId &&
				readStatus(message.params.update) === final.status,
		);
		assert.ok(
			terminalIndex >
				wire.findIndex(
					(message) =>
						message.params?.update?.sessionUpdate === "tool_call" &&
						readToolId(message.params.update) === initial.toolCallId,
				),
			"Every terminal notification must follow its announcement, independently of the prompt response.",
		);
		return {
			input: JSON.stringify(initial.rawInput),
			output: final.rawOutput
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
			status: final.status,
			title: initial.title,
		};
	});
	assert.ok(
		tools.every((u) => initials.some((i) => i.toolCallId === readToolId(u))),
		"Updates must belong to an announced call.",
	);
	const lastTerminalIndex = updates.findLastIndex((u) =>
		["completed", "failed"].includes(readStatus(u) ?? ""),
	);
	const answer = updates
		.slice(lastTerminalIndex + 1)
		.map(readText)
		.join("")
		.trim();
	assert.ok(answer, "Model must answer after the tool results.");
	const result = {
		operation,
		calls: calls.map(({ title, status }) => ({ title, status })),
		durationMs: Date.now() - started,
		stableToolIds: true,
		consistentPayloads: true,
		orderedEventualTerminals: true,
	};
	evidence.checks.push(result);
	process.stdout.write(`${JSON.stringify(result)}\n`);
	return { calls, answer, output: calls.map((call) => call.output).join("\n") };
}

try {
	client = await startClient({ live: true, cwd });
	// The token is available only through an actual filesystem read.
	const token = randomUUID();
	await writeFile(join(cwd, "seed.txt"), `first\n${token}\nlast\n`);
	const read = await performOperation(
		client,
		"read",
		"Read seed.txt and report the code on its second line.",
		(text) => text.includes(token),
	);
	assert.ok(read.output.includes(token));
	assert.ok(read.answer.includes(token));

	const path = "nested/round-trip.txt";
	const content = "alpha\nbeta\ngamma\n";
	await performOperation(
		client,
		"create",
		`Create ${path}, including its parent directory, with three physical lines: alpha, beta, gamma. End each line with a newline character, not the literal characters backslash and n.`,
	);
	assert.equal(await readFile(join(cwd, path), "utf8"), content);
	await performOperation(
		client,
		"replace",
		`In ${path}, replace beta with BETA, leaving all other bytes unchanged.`,
	);
	const edited = "alpha\nBETA\ngamma\n";
	assert.equal(await readFile(join(cwd, path), "utf8"), edited);

	const absent = `absent-${randomUUID().slice(0, 12)}`;
	const replacement = `unexpected-${randomUUID().slice(0, 12)}`;
	const failure = await performOperation(
		client,
		"missing replacement",
		`Use the native edit tool on ${path} with an edit whose oldText is ${absent} and newText is ${replacement}. Invoke edit even though the target may be absent; do not use grep, a precheck, or another replacement. Leave the file unchanged if edit fails. Report the tool failure afterward.`,
	);
	assert.ok(
		failure.calls.some(
			(call) =>
				[path, absent, replacement].every((value) =>
					call.input.includes(value),
				) &&
				(call.status === "failed" ||
					/not found|no match|absent|missing|error|fail/i.test(call.output)),
		),
		`A replacement call must contain the target and both operands and expose failure evidence: ${JSON.stringify(failure.calls)}`,
	);
	assert.equal(await readFile(join(cwd, path), "utf8"), edited);
	const recovered = await performOperation(
		client,
		"recovery read",
		`Use the native read tool to read ${path} again and report its contents.`,
	);
	assert.ok(recovered.output.includes(edited.trim()));
	assert.equal(await readFile(join(cwd, path), "utf8"), edited);
	await client.close();
	assert.equal(client.child.exitCode, 0);
	assert.equal(client.stderr, "");
	process.stdout.write(
		`${JSON.stringify({ ...evidence, filesystemVerified: true, failedEditUnchanged: true, sameSessionRecovery: true, passed: true }, null, 2)}\n`,
	);
} finally {
	await client?.close();
	await rm(cwd, { recursive: true, force: true });
}
