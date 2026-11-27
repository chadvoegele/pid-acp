import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { acpxFixture, acpxUpdates, assertAcpxLoad } from "./helpers/acpx.ts";
import { requireLiveProvider } from "./helpers/live-provider.ts";
import { readStatus, readText, readToolId } from "./helpers/updates.ts";

test("real provider with acpx retains remembered context and native tool history across fresh server processes", {
	timeout: 120000,
}, async (t) => {
	const evidence = await requireLiveProvider();
	const f = await acpxFixture(t, true);
	const started = Date.now();
	const id = await f.create();
	const code = `RECALL_${randomUUID().slice(0, 8)}`;
	const firstStart = f.readTrace().length;
	await f.prompt(
		`Remember this test code for a later question: ${code}. Say SAVED without using tools.`,
	);
	await f.prompt(
		"Use the write tool to create saved.txt containing exactly FILE_SAVED. Do not use bash. Then say SAVED.",
	);
	await f.prompt(
		"Use bash to execute exactly: printf 'effect\\n' >> effects.txt\nRun that bash command once only. Then say SAVED.",
	);
	const first = f.readTrace().slice(firstStart);
	const original = acpxUpdates(
		first.slice(assertAcpxLoad(first, id).response + 1),
	);
	const calls = original.filter(
		(update) => update.sessionUpdate === "tool_call",
	);
	for (const title of ["write", "bash"])
		assert.ok(calls.some((call) => "title" in call && call.title === title));
	for (const call of calls)
		assert.ok(
			original.some(
				(update) =>
					readToolId(update) === readToolId(call) &&
					readStatus(update) === "completed",
			),
		);
	assert.equal(await readFile(join(f.cwd, "saved.txt"), "utf8"), "FILE_SAVED");
	assert.equal(await readFile(join(f.cwd, "effects.txt"), "utf8"), "effect\n");
	const restartStart = f.readTrace().length;
	await f.prompt(
		"What test code did I ask you to remember earlier? Answer with only that code. Do not use any tools or read files.",
	);
	const restarted = f.readTrace().slice(restartStart);
	const { response, history } = assertAcpxLoad(restarted, id);
	assert.ok(
		history.some((update) => update.sessionUpdate === "user_message_chunk"),
	);
	assert.deepEqual(
		new Set(
			history
				.filter((update) => update.sessionUpdate === "tool_call_update")
				.map(readToolId),
		),
		new Set(calls.map(readToolId)),
	);
	assert.notEqual(first[0]?.pid, restarted[0]?.pid);
	const continuation = acpxUpdates(restarted.slice(response + 1));
	assert.equal(continuation.map(readText).join("").trim(), code);
	assert.ok(continuation.every((update) => readToolId(update) === undefined));
	assert.equal(await readFile(join(f.cwd, "effects.txt"), "utf8"), "effect\n");
	t.diagnostic(
		JSON.stringify({
			...evidence,
			client: "acpx 0.20.0",
			durationMs: Date.now() - started,
			retainedSessionId: true,
			freshServer: true,
			rememberedContext: true,
			replayBeforeLoadResponse: true,
			effectCount: 1,
		}),
	);
});

test("real Qwen interrupted bash resumes through Durable without repeating its effect or streaming old work", {
	timeout: 120000,
}, async (t) => {
	const { existsSync } = await import("node:fs");
	const { startClient, waitFor } = await import("./helpers/client.ts");
	const evidence = await requireLiveProvider();
	const f = await acpxFixture(t, true);
	const id = await f.create();
	const code = `RECALL_${randomUUID().slice(0, 8)}`;
	await f.prompt(
		`Remember this code in conversation only: ${code}. Say SAVED without using tools.`,
	);
	let shellPid: number | undefined;
	t.after(() => {
		if (shellPid) {
			try {
				process.kill(-shellPid, "SIGKILL");
			} catch {}
		}
	});
	const active = f.start([
		"prompt",
		"--session",
		"acceptance",
		`Use bash to execute exactly: echo $$ > shell.pid; printf effect >> effects; printf crash-ready; sleep 60\nThe test client will interrupt this foreground command. Run it once only; after an interrupted tool result, say INTERRUPTED without making another tool call.`,
	]);
	await waitFor(
		() =>
			acpxUpdates(f.readTrace()).some(
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					JSON.stringify(update.content).includes("crash-ready"),
			),
		30000,
	);
	assert.equal(existsSync(join(f.cwd, "shell.pid")), true);
	shellPid = Number(await readFile(join(f.cwd, "shell.pid"), "utf8"));
	const owner = f
		.readTrace()
		.findLast((item) => item.message.method === "started");
	assert.ok(owner);
	process.kill(owner.pid, "SIGKILL");
	await active.done;
	await f.stopped();
	try {
		process.kill(-shellPid, "SIGKILL");
	} catch {}
	shellPid = undefined;
	const recovery = await startClient({
		live: true,
		inheritPidAcpEnv: true,
		env: { PID_ACP_SESSIONS_DIR: f.sessions },
	});
	try {
		await recovery.request("session/load", {
			sessionId: id,
			cwd: f.cwd,
			mcpServers: [],
		});
		await waitFor(
			() => recovery.updates.map(readText).join("").includes("INTERRUPTED"),
			30000,
		);
	} finally {
		await recovery.close();
	}
	assert.equal(recovery.stderr, "");
	const reconnect = f.readTrace().length;
	await f.create("recovered", id);
	const { history } = assertAcpxLoad(f.readTrace().slice(reconnect), id);
	assert.ok(
		history.some(
			(update) =>
				update.sessionUpdate === "user_message_chunk" &&
				update.content.type === "text" &&
				update.content.text.includes(code),
		),
	);
	assert.ok(
		history.some((update) => update.sessionUpdate === "tool_call"),
		"Historical tool calls must replay before the load response.",
	);
	assert.equal(await readFile(join(f.cwd, "effects"), "utf8"), "effect");
	const restart = f.readTrace().length;
	await f.prompt(
		"What code did I ask you to remember? Respond with that code only and use no tools.",
		"recovered",
	);
	const trace = f.readTrace().slice(restart);
	const { response } = assertAcpxLoad(trace, id);
	const output = acpxUpdates(trace.slice(response + 1));
	assert.equal(output.map(readText).join("").trim(), code);
	assert.ok(output.every((update) => readToolId(update) === undefined));
	assert.ok(!output.map(readText).join("").includes("INTERRUPTED"));
	assert.equal(await readFile(join(f.cwd, "effects"), "utf8"), "effect");
	t.diagnostic(
		JSON.stringify({
			...evidence,
			client: "acpx 0.20.0",
			nativeInterruptedBash: true,
			recoveryClient: "ACP SDK attachment held until recovered answer",
			replayClient: "fresh acpx processes after recovery",
			replayBeforeLoadResponse: true,
			effectCount: 1,
			resumedModelContext: true,
		}),
	);
});
