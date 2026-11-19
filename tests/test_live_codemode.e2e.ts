import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { startClient, waitFor } from "./helpers/client.ts";
import { requireLiveProvider } from "./helpers/live-provider.ts";
import { summarizeLiveUpdates } from "./helpers/live-diagnostics.ts";
import { readNativeToolTrace } from "./helpers/native-tool-trace.ts";
import { assertChildrenStopped, readActivePid } from "./helpers/processes.ts";

function collectToolUpdates(updates: SessionUpdate[]) {
	return updates.filter(
		(update) =>
			update.sessionUpdate === "tool_call" ||
			update.sessionUpdate === "tool_call_update",
	);
}

async function requireParent(
	updates: SessionUpdate[],
	start: number,
	status: "completed" | "failed",
) {
	await waitFor(() =>
		collectToolUpdates(updates.slice(start)).some(
			(update) => update.status === status,
		),
	);
	const tools = collectToolUpdates(updates.slice(start));
	const call = tools[0];
	assert.ok(call?.sessionUpdate === "tool_call");
	const input = call.rawInput as { code?: unknown } | undefined;
	assert.equal(typeof input?.code, "string");
	const actualCode = input?.code as string;
	const native = await readNativeToolTrace(
		join(cwd, "sessions"),
		call.toolCallId,
	);
	assert.equal(native.call.name, "codemode");
	assert.deepEqual(call.rawInput, native.call.arguments);
	assert.deepEqual(call, {
		sessionUpdate: "tool_call",
		toolCallId: call.toolCallId,
		title: "codemode",
		kind: "other",
		status: "in_progress",
		rawInput: { code: actualCode },
	});
	assert.equal(
		tools.filter((update) => update.sessionUpdate === "tool_call").length,
		1,
		"Only the ordinary codemode parent row is presented.",
	);
	assert.ok(tools.every((update) => update.toolCallId === call.toolCallId));
	const terminal = tools.at(-1);
	assert.ok(terminal?.sessionUpdate === "tool_call_update");
	assert.equal(terminal.status, status);
	assert.deepEqual(Object.keys(terminal).sort(), [
		"content",
		"rawOutput",
		"sessionUpdate",
		"status",
		"toolCallId",
	]);
	assert.equal(tools.filter((update) => update.status === status).length, 1);
	return { call, terminal, native };
}

function createPrompt(code: string, instruction: string) {
	return `This is an explicit codemode acceptance test in a disposable workspace. Call codemode exactly once to perform the operations shown in this JavaScript example. Do not issue any other tool calls in the same response or afterward: no discovery, direct bash, read or filesystem inspection. After codemode returns, answer directly from its output without additional tools. Then ${instruction}\n\n${code}`;
}

const evidence = { ...(await requireLiveProvider()), checks: [] as object[] };
const cwd = await mkdtemp(join(tmpdir(), "pid-acp-live-codemode-"));
let client: Awaited<ReturnType<typeof startClient>> | undefined;
let shellPid: number | undefined;
function record(
	name: string,
	started: number,
	parent: Awaited<ReturnType<typeof requireParent>>,
	details: Record<string, unknown> = {},
) {
	const check = {
		name,
		durationMs: Date.now() - started,
		toolCallId: parent.call.toolCallId,
		rawInput: parent.call.rawInput,
		status: parent.terminal.status,
		parentRows: 1,
		nestedRows: 0,
		...details,
	};
	evidence.checks.push(check);
	process.stdout.write(`${JSON.stringify(check)}\n`);
}

try {
	const left = randomUUID();
	const right = randomUUID();
	const expected = `${left} -> ${right}`;
	await writeFile(join(cwd, "left.txt"), left);
	await writeFile(join(cwd, "right.txt"), right);
	client = await startClient({
		live: true,
		cwd,
		env: { PID_ACP_SESSIONS_DIR: join(cwd, "sessions") },
	});
	let started = Date.now();
	const code = `const batch = await Promise.all([
  tools.read({ path: "left.txt" }),
  tools.read({ path: "right.txt" }),
  tools.bash({ command: "pwd" })
]);
await tools.write({ path: "combined.txt", content: batch.slice(0, 2).join(":") });
await tools.edit({ path: "combined.txt", oldText: ":", newText: " -> " });
text(await tools.read({ path: "combined.txt" }));
text(batch[2]);`;
	assert.equal(
		(
			await client.prompt(
				createPrompt(
					code,
					"report the combined file contents from the tool result verbatim.",
				),
			)
		).stopReason,
		"end_turn",
	);
	await client.waitForAnswer((text) => text.includes(expected));
	const parent = await requireParent(client.updates, 0, "completed");
	assert.deepEqual(parent.native.nested.map(({ call }) => call.name).sort(), [
		"bash",
		"edit",
		"read",
		"read",
		"read",
		"write",
	]);
	assert.ok(
		parent.native.nested.every(
			({ state }) =>
				state.status === "terminal" && state.outcome.status === "completed",
		),
	);
	assert.ok(JSON.stringify(parent.terminal.rawOutput).includes(expected));
	assert.ok(JSON.stringify(parent.terminal.rawOutput).includes(cwd));
	assert.equal(await readFile(join(cwd, "combined.txt"), "utf8"), expected);
	record("batch-dependent-native-calls", started, parent, {
		filesystemVerified: true,
		modelReceivedUnpromptedTokens: true,
		stopReason: "end_turn",
	});

	const errorStart = client.updates.length;
	started = Date.now();
	assert.equal(
		(
			await client.prompt(
				createPrompt(
					'text(await tools.read({ path: "missing.txt" }));',
					"explain the tool failure without retrying.",
				),
			)
		).stopReason,
		"end_turn",
	);
	const failed = await requireParent(client.updates, errorStart, "failed");
	assert.match(JSON.stringify(failed.terminal.rawOutput), /missing.txt/);
	assert.deepEqual(
		failed.native.nested.map(({ call }) => call.name),
		["read"],
	);
	record("native-error-parent", started, failed);

	const cancelStart = client.updates.length;
	started = Date.now();
	const cancelCode =
		'await tools.bash({ command: "echo $$ > shell.pid; sleep 60 & echo $! > sleep.pid; wait" });';
	const pending = client.prompt(
		createPrompt(
			cancelCode,
			"report completion only if it finishes; the client will cancel the running command.",
		),
	);
	void pending.catch(() => {});
	shellPid = await readActivePid(cwd, "shell.pid", pending);
	const sleepPid = await readActivePid(cwd, "sleep.pid", pending);
	const cancellationStarted = Date.now();
	await client.cancel();
	assert.equal((await pending).stopReason, "cancelled");
	const cancelMs = Date.now() - cancellationStarted;
	await assertChildrenStopped([shellPid, sleepPid]);
	const cancelled = await requireParent(client.updates, cancelStart, "failed");
	record("codemode-cancellation", started, cancelled, {
		cancelMs,
		childrenStopped: true,
		stopReason: "cancelled",
	});

	const recoveryStart = client.updates.length;
	started = Date.now();
	const recoveryCode = 'text(await tools.read({ path: "combined.txt" }));';
	assert.equal(
		(
			await client.prompt(
				createPrompt(recoveryCode, "report the file contents verbatim."),
			)
		).stopReason,
		"end_turn",
	);
	await client.waitForAnswer((text) => text.includes(expected), recoveryStart);
	const recovered = await requireParent(
		client.updates,
		recoveryStart,
		"completed",
	);
	assert.ok(JSON.stringify(recovered.terminal.rawOutput).includes(expected));
	record("next-prompt-codemode", started, recovered, {
		stopReason: "end_turn",
	});
	await client.close();
	assert.equal(client.child.exitCode, 0);
	assert.equal(client.stderr, "");
	process.stdout.write(
		`${JSON.stringify({ ...evidence, passed: true }, null, 2)}\n`,
	);
} catch (error) {
	process.stderr.write(
		`${JSON.stringify({ author: "Chad's Agent", passed: false, completedChecks: evidence.checks, updates: client && summarizeLiveUpdates(client.updates, [cwd]) }).slice(0, 65536)}\n`,
	);
	throw error;
} finally {
	try {
		await client?.close();
	} finally {
		if (shellPid) {
			try {
				process.kill(-shellPid, "SIGKILL");
			} catch {}
		}
		await rm(cwd, { recursive: true, force: true });
	}
}
