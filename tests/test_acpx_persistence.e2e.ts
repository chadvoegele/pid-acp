import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
	acpxFixture,
	acpxUpdates as updates,
	assertAcpxLoad as assertLoad,
} from "./helpers/acpx.ts";
import { waitFor } from "./helpers/client.ts";
import { readText, readToolId } from "./helpers/updates.ts";

test("acpx session/load retains ID and context once with replay before response and no tool reexecution", {
	timeout: 60000,
}, async (t) => {
	const f = await acpxFixture(t);
	const id = await f.create();
	const createPid = f.readTrace()[0]?.pid;
	assert.match(id, /^[0-9a-f-]{36}$/);
	await f.prompt("remember acpx context");
	for (const tool of [
		{ name: "write", args: { path: "file", content: "saved file" } },
		{
			name: "bash",
			args: { command: "printf 'effect\\n' >> effects; printf bash-result" },
		},
		{ name: "bash", args: { command: "printf failed-result; exit 3" } },
	])
		await f.prompt(JSON.stringify(tool));
	const before = f.readTrace();
	// Each prompt uses a new owner after the short acpx queue TTL expires.
	const starts = before.filter((item) => item.message.method === "started");
	assert.equal(starts.length, 5);
	assert.equal(new Set(starts.map((item) => item.pid)).size, 5);
	assert.notEqual(starts.at(-1)?.pid, createPid);
	const start = before.length;
	await f.prompt("context");
	const allStarts = f
		.readTrace()
		.filter((item) => item.message.method === "started");
	assert.equal(allStarts.length, 6);
	assert.equal(new Set(allStarts.map((item) => item.pid)).size, 6);
	const continued = f.readTrace().slice(start);
	const { response, history: replay } = assertLoad(continued, id);
	for (const kind of [
		"user_message_chunk",
		"agent_message_chunk",
		"agent_thought_chunk",
		"tool_call",
		"tool_call_update",
	])
		assert.ok(replay.some((update) => update.sessionUpdate === kind));
	assert.equal(
		replay.filter((update) => update.sessionUpdate === "tool_call_update")
			.length,
		3,
	);
	assert.equal(
		replay.filter(
			(update) =>
				update.sessionUpdate === "user_message_chunk" &&
				"content" in update &&
				!Array.isArray(update.content) &&
				update.content?.type === "text" &&
				update.content.text === "remember acpx context",
		).length,
		1,
	);
	const newOutput = updates(continued.slice(response + 1));
	const transcript = JSON.parse(newOutput.map(readText).join("")) as {
		role: string;
		content: unknown;
	}[];
	assert.equal(
		transcript.filter(
			(message) =>
				message.role === "user" && message.content === "remember acpx context",
		).length,
		1,
	);
	assert.equal(
		transcript.filter(
			(message) =>
				message.role === "assistant" &&
				JSON.stringify(message.content).includes(
					"Answer: remember acpx context",
				),
		).length,
		1,
	);
	assert.equal(
		transcript.filter((message) => message.role === "toolResult").length,
		3,
	);
	assert.ok(newOutput.every((update) => readToolId(update) === undefined));
	assert.equal(await readFile(join(f.cwd, "file"), "utf8"), "saved file");
	assert.equal(await readFile(join(f.cwd, "effects"), "utf8"), "effect\n");
	assert.deepEqual((await readdir(f.sessions)).sort(), ["db", "owner.lock"]);
	assert.ok(!continued.some((item) => item.message.method === "session/new"));
	t.diagnostic(
		`acpx 0.20.0; ${starts.length + 1} distinct production processes; retained UUID; load replay before response; no resume/new fallback; context once; effect once`,
	);
});

test("acpx explicit resume rejects missing sessions and mismatched cwd without fallback or transcript changes", {
	timeout: 30000,
}, async (t) => {
	const f = await acpxFixture(t);
	const id = await f.create();
	await f.prompt("baseline");
	const path = join(f.sessions, "db", "main.jsonl");
	const before = await readFile(path);
	for (const kind of ["missing", "mismatched-cwd"] as const) {
		const start = f.readTrace().length;
		const result = await f.run([
			...(kind === "mismatched-cwd" ? ["--cwd", f.root] : []),
			"sessions",
			"new",
			"--name",
			kind,
			"--resume-session",
			kind === "missing" ? randomUUID() : id,
		]);
		assert.notEqual(result.code, 0);
		await f.stopped();
		const trace = f.readTrace().slice(start);
		assert.ok(trace.some((item) => item.message.method === "session/load"));
		assert.match(
			JSON.stringify(trace.find((item) => item.message.error)?.message.error),
			kind === "missing"
				? /Unknown saved session/
				: /Saved conversation configuration is missing or incompatible/,
		);
		assert.ok(
			!trace.some((item) =>
				["session/resume", "session/new", "session/prompt"].includes(
					item.message.method ?? "",
				),
			),
		);
		assert.equal(updates(trace).length, 0);
		assert.deepEqual(await readFile(path), before);
		assert.deepEqual((await readdir(f.sessions)).sort(), ["db", "owner.lock"]);
	}
	assert.equal(
		await f.create("resumed", id, { PID_ACP_THINKING: "medium" }),
		id,
		"Saved thinking settings must not need to match new-session launch defaults.",
	);
});

test("acpx cancel stops real bash children and loads history before continuation", {
	timeout: 30000,
}, async (t) => {
	const { assertChildrenStopped } = await import("./helpers/processes.ts");
	const f = await acpxFixture(t);
	const id = await f.create();
	const active = f.start([
		"prompt",
		"--session",
		"acceptance",
		JSON.stringify({
			name: "bash",
			args: {
				command:
					"echo $$ > shell.pid; sleep 60 & echo $! > sleep.pid; printf cancel-ready; wait",
			},
		}),
	]);
	await waitFor(
		() =>
			updates(f.readTrace()).some(
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					JSON.stringify(update.content).includes("cancel-ready"),
			),
		15000,
	);
	const pids = await Promise.all(
		["shell.pid", "sleep.pid"].map(async (file) =>
			Number(await readFile(join(f.cwd, file), "utf8")),
		),
	);
	const started = Date.now();
	const cancelled = await f.run(["cancel", "--session", "acceptance"]);
	assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
	await active.done;
	await waitFor(() =>
		f
			.readTrace()
			.some((item) => item.message.result?.stopReason === "cancelled"),
	);
	assert.ok(Date.now() - started < 5000);
	assert.ok(
		f.readTrace().some((item) => item.message.method === "session/cancel"),
	);
	assert.ok(
		f
			.readTrace()
			.some((item) => item.message.result?.stopReason === "cancelled"),
	);
	await assertChildrenStopped(pids);
	const closed = await f.run(["sessions", "close", "acceptance"]);
	assert.equal(closed.code, 0, closed.stdout + closed.stderr);
	await f.stopped();
	const start = f.readTrace().length;
	assert.equal(await f.create("after-cancel", id), id);
	await f.prompt("after cancellation", "after-cancel");
	assertLoad(f.readTrace().slice(start), id);
});

for (const boundary of ["generation", "tool", "after-effect"] as const) {
	test(`acpx crash during ${boundary} loads history and recovers natively and no duplicate effect`, {
		timeout: 45000,
	}, async (t) => {
		const f = await acpxFixture(t);
		const id = await f.create();
		const ready = join(f.root, "ready");
		let shellPid: number | undefined;
		t.after(() => {
			if (shellPid) {
				try {
					process.kill(-shellPid, "SIGKILL");
				} catch {}
			}
		});
		const active = f.start(
			[
				"prompt",
				"--session",
				"acceptance",
				boundary === "generation"
					? "block"
					: JSON.stringify({
							name: "bash",
							args: {
								command:
									boundary === "tool"
										? "echo $$ > shell.pid; printf effect >> effects; printf crash-ready; sleep 60"
										: "printf effect >> effects",
							},
							blockAfterTool: boundary === "after-effect",
						}),
			],
			{ PID_TEST_READY: ready },
		);
		await waitFor(
			() =>
				boundary === "tool"
					? updates(f.readTrace()).some(
							(update) =>
								update.sessionUpdate === "tool_call_update" &&
								JSON.stringify(update.content).includes("crash-ready"),
						)
					: existsSync(ready),
			15000,
		);
		if (boundary === "tool")
			shellPid = Number(await readFile(join(f.cwd, "shell.pid"), "utf8"));
		const startOwner = f
			.readTrace()
			.findLast((item) => item.message.method === "started");
		assert.ok(startOwner);
		const lockStart = f.readTrace().length;
		const loser = await f.run([
			"sessions",
			"new",
			"--name",
			"contender",
			"--resume-session",
			id,
		]);
		assert.notEqual(loser.code, 0);
		const rejected = f
			.readTrace()
			.slice(lockStart)
			.filter((item) => item.pid !== startOwner.pid);
		assert.match(loser.stdout + loser.stderr, /AGENT_STARTUP_FAILED/);
		assert.ok(
			!rejected.some((item) =>
				[
					"session/load",
					"session/resume",
					"session/new",
					"session/prompt",
				].includes(item.message.method ?? ""),
			),
		);
		assert.equal(updates(rejected).length, 0);
		process.kill(startOwner.pid, "SIGKILL");
		await active.done;
		await f.stopped();
		if (shellPid) {
			try {
				process.kill(-shellPid, "SIGKILL");
			} catch {}
			shellPid = undefined;
		}
		const start = f.readTrace().length;
		assert.equal(
			await f.create("interrupted", id, { PID_TEST_RECOVER: "1" }),
			id,
		);
		assertLoad(f.readTrace().slice(start), id, { allowLiveUpdates: true });
		const continued = f.readTrace().length;
		const result = await f.run(
			["prompt", "--session", "interrupted", "context"],
			{ PID_TEST_RECOVER: "1" },
		);
		assert.equal(result.code, 0, result.stdout + result.stderr);
		await f.stopped();
		const trace = f.readTrace().slice(continued);
		const { response } = assertLoad(trace, id);
		const output = updates(trace.slice(response + 1));
		const history = JSON.parse(output.map(readText).join("")) as {
			role: string;
			content: unknown;
			isError?: boolean;
		}[];
		assert.equal(
			history.filter((message) => message.role === "user").length,
			2,
		);
		assert.equal(
			history.filter((message) => message.role === "toolResult").length,
			boundary === "generation" ? 0 : 1,
		);
		if (boundary === "tool") {
			const result = history.find((message) => message.role === "toolResult");
			assert.equal(result?.isError, true);
			assert.match(JSON.stringify(result), /interrupted/);
		}
		assert.equal(
			history.some(
				(message) =>
					message.role === "assistant" &&
					JSON.stringify(message.content).includes("Recovered answer."),
			),
			boundary === "tool",
			"An interrupted in-flight generation ends without retry; a recovered tool round can still generate its answer.",
		);
		assert.ok(
			output.every(
				(update) =>
					update.sessionUpdate === "agent_message_chunk" ||
					(update.sessionUpdate === "user_message_chunk" &&
						update.content.type === "text" &&
						update.content.text === "context"),
			),
		);
		if (boundary !== "generation")
			assert.equal(await readFile(join(f.cwd, "effects"), "utf8"), "effect");
	});
}

test("acpx stateless SIGINT still cancels and leaves a persistent session resumable", {
	timeout: 30000,
}, async (t) => {
	const { assertChildrenStopped } = await import("./helpers/processes.ts");
	const f = await acpxFixture(t);
	const active = f.start([
		"exec",
		JSON.stringify({
			name: "bash",
			args: {
				command:
					"echo $$ > shell.pid; sleep 60 & echo $! > sleep.pid; printf sigint-ready; wait",
			},
		}),
	]);
	await waitFor(
		() =>
			updates(f.readTrace()).some(
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					JSON.stringify(update.content).includes("sigint-ready"),
			),
		15000,
	);
	const pids = await Promise.all(
		["shell.pid", "sleep.pid"].map(async (file) =>
			Number(await readFile(join(f.cwd, file), "utf8")),
		),
	);
	const id = f.readTrace().find((item) => item.message.result?.sessionId)
		?.message.result?.sessionId;
	assert.ok(id);
	const started = Date.now();
	active.child.kill("SIGINT");
	await active.done;
	await f.stopped();
	assert.ok(Date.now() - started < 5000);
	assert.ok(
		f.readTrace().some((item) => item.message.method === "session/cancel"),
	);
	assert.ok(
		f
			.readTrace()
			.some((item) => item.message.result?.stopReason === "cancelled"),
	);
	await assertChildrenStopped(pids);
	const start = f.readTrace().length;
	assert.equal(await f.create("after-sigint", id), id);
	assertLoad(f.readTrace().slice(start), id);
	await f.prompt("after SIGINT", "after-sigint");
});
