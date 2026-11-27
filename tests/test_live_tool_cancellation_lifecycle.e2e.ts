import { requireLiveProvider } from "./helpers/live-provider.ts";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
	readText,
	readStatus,
	readToolId,
	requireToolUpdate,
} from "./helpers/updates.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClient, waitFor } from "./helpers/client.ts";

const evidence = {
	...(await requireLiveProvider()),
	checks: [] as Record<string, unknown>[],
};
const cwd = await mkdtemp(join(tmpdir(), "pid-acp-live-"));
let client: Awaited<ReturnType<typeof startClient>> | undefined;
const record = (
	name: string,
	started: number,
	details: Record<string, unknown>,
) => {
	const result = { name, durationMs: Date.now() - started, ...details };
	evidence.checks.push(result);
	process.stdout.write(`${JSON.stringify(result)}\n`);
};
const collectText = (updates: SessionUpdate[]) =>
	updates
		.filter((update) => update.sessionUpdate === "agent_message_chunk")
		.map((update) => readText(update))
		.join("");
const shellPrompt =
	"Use the bash tool to run `sleep 60` now. This is a cancellation test in a disposable workspace; the client will stop the command as soon as it starts. Do not answer without calling bash.";
async function readDescendants(pid: number): Promise<number[]> {
	const children = (
		await readFile(`/proc/${pid}/task/${pid}/children`, "utf8").catch(() => "")
	)
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(Number);
	return [
		...children,
		...(await Promise.all(children.map(readDescendants))).flat(),
	];
}
async function waitForSleep(
	client: Awaited<ReturnType<typeof startClient>>,
	prompt: Promise<unknown>,
) {
	assert.ok(client.child.pid);
	let settled = false;
	void prompt.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		if (settled)
			throw new Error(
				`Prompt settled without a sleep child; tool statuses: ${JSON.stringify(client.updates.filter((update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update").map((update) => ({ kind: update.sessionUpdate, status: update.status })))}`,
			);
		const pids = await readDescendants(client.child.pid);
		const names = await Promise.all(
			pids.map((pid) => readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")),
		);
		if (names.some((name) => name.trim() === "sleep")) return pids;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Model did not start a real sleep child.");
}
async function assertStopped(pids: number[]) {
	for (const pid of pids) {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
		assert.ok(
			!stat || /^\d+ \(.*\) Z /.test(stat),
			"Shell child must stop after cancellation/shutdown.",
		);
	}
}
try {
	client = await startClient({ live: true, inheritPidAcpEnv: true, cwd });
	let started = Date.now();
	assert.equal(
		(
			await client.prompt(
				"Run pwd using the shell tool, then tell me the directory.",
			)
		).stopReason,
		"end_turn",
	);
	await client.waitForAnswer((text) => text.includes(cwd));
	const call = client.updates.find(
		(update) => update.sessionUpdate === "tool_call",
	);
	assert.ok(call);
	assert.ok(
		call.rawInput &&
			typeof call.rawInput === "object" &&
			"command" in call.rawInput &&
			typeof call.rawInput.command === "string" &&
			call.rawInput.command.includes("pwd"),
	);
	const terminal = client.updates.findIndex(
		(update) =>
			readToolId(update) === call.toolCallId &&
			readStatus(update) === "completed",
	);
	assert.ok(terminal > client.updates.indexOf(call));
	assert.ok(
		JSON.stringify(
			requireToolUpdate(client.updates[terminal]).content,
		).includes(cwd),
	);
	assert.ok(collectText(client.updates.slice(terminal + 1)).includes(cwd));
	const chunks = client.updates.filter(
		(update) => update.sessionUpdate === "agent_message_chunk",
	).length;
	assert.ok(chunks > 1);
	assert.ok(
		client.wire.some((message) => message.result?.stopReason === "end_turn"),
	);
	assert.ok(
		client.wire.findIndex(
			(message) => message.params?.update?.sessionUpdate === "tool_call",
		) <
			client.wire.findLastIndex(
				(message) =>
					message.params?.update &&
					readStatus(message.params.update) === "completed",
			),
	);
	record("pwd-tool-answer", started, {
		chunks,
		stableToolId: true,
		orderedEventualTerminal: true,
		cwdVerified: true,
	});

	client.updates.length = 0;
	started = Date.now();
	const shellPending = client.prompt(shellPrompt);
	const children = await waitForSleep(client, shellPending);
	for (const pid of children) process.kill(pid, 0);
	const cancelStart = Date.now();
	await client.cancel();
	assert.equal((await shellPending).stopReason, "cancelled");
	const cancelMs = Date.now() - cancelStart;
	assert.ok(cancelMs < 5000);
	await assertStopped(children);
	await waitFor(
		() =>
			client?.updates.some((update) => readStatus(update) === "failed") ??
			false,
	);
	assert.ok(client.updates.some((update) => readStatus(update) === "failed"));
	assert.equal(
		(
			await client.prompt(
				"Reply with exactly: recovered after shell cancellation",
			)
		).stopReason,
		"end_turn",
	);
	await client.waitForAnswer((text) =>
		text.includes("recovered after shell cancellation"),
	);
	record("shell-cancel-recovery", started, {
		cancelMs,
		childrenStopped: true,
		subsequentPrompt: "end_turn",
	});

	client.updates.length = 0;
	started = Date.now();
	let finished = false;
	const modelPending = client
		.prompt(
			"Write the integers 1 through 3000, one per line, without tools or explanations. Continue until all are written.",
		)
		.finally(() => {
			finished = true;
		});
	await waitFor(
		() =>
			client?.updates.some(
				(update) => update.sessionUpdate === "agent_message_chunk",
			) ?? false,
		60000,
	);
	assert.equal(finished, false, "Model must still be active when cancelled.");
	const modelCancelStart = Date.now();
	await client.cancel();
	assert.equal((await modelPending).stopReason, "cancelled");
	const modelCancelMs = Date.now() - modelCancelStart;
	assert.ok(modelCancelMs < 5000);
	const recoveryStart = client.updates.length;
	assert.equal(
		(
			await client.prompt(
				"Reply with exactly: recovered after model cancellation",
			)
		).stopReason,
		"end_turn",
	);
	await client.waitForAnswer(
		(text) => text.includes("recovered after model cancellation"),
		recoveryStart,
	);
	record("model-cancel-recovery", started, {
		cancelMs: modelCancelMs,
		subsequentPrompt: "end_turn",
	});
	await client.close();

	client = await startClient({ live: true, inheritPidAcpEnv: true, cwd });
	started = Date.now();
	const pending = client.prompt(shellPrompt).catch((error) => error);
	const eofChildren = await waitForSleep(client, pending);
	for (const pid of eofChildren) process.kill(pid, 0);
	const eofStart = Date.now();
	await client.close();
	await pending;
	assert.equal(client.child.exitCode, 0);
	await assertStopped(eofChildren);
	record("EOF-shell-cleanup", started, {
		shutdownMs: Date.now() - eofStart,
		childrenStopped: true,
	});
	assert.equal(client.stderr, "");
	process.stdout.write(
		`${JSON.stringify({ ...evidence, passed: true }, null, 2)}\n`,
	);
} finally {
	await client?.close();
	await rm(cwd, { recursive: true, force: true });
}
