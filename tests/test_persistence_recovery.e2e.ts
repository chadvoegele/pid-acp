import assert from "node:assert/strict";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { test } from "node:test";
import { mkdir, readFile, stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { join } from "node:path";
import { persistenceFixture } from "./helpers/persistence.ts";
import { waitFor } from "./helpers/client.ts";
import { readStatus, readText } from "./helpers/updates.ts";

for (const boundary of ["generation", "tool", "after-effect"] as const) {
	test(`SIGKILL during ${boundary} resumes natively before fresh input without duplicate effects`, {
		timeout: 15000,
	}, async (t) => {
		const f = await persistenceFixture(t);
		const ready = join(f.cwd, "ready");
		let shellPid: number | undefined;
		t.after(() => {
			if (shellPid) {
				try {
					process.kill(-shellPid, "SIGKILL");
				} catch {}
			}
		});
		const first = await f.client({ PID_TEST_READY: ready });
		const { sessionId } = await first.request("session/new", {
			cwd: f.cwd,
			mcpServers: [],
		});
		const command =
			boundary === "tool"
				? "printf effect >> effect; echo $$ > shell.pid; sleep 60"
				: "printf effect >> effect";
		const pending = first.prompt(
			boundary === "generation"
				? "block"
				: JSON.stringify({
						name: "bash",
						args: { command },
						blockAfterTool: boundary === "after-effect",
					}),
			sessionId,
		);
		void pending.catch(() => {});
		if (boundary === "tool")
			await waitFor(() =>
				first.updates.some((update) => update.sessionUpdate === "tool_call"),
			);
		await waitFor(
			asyncFileExists(boundary === "tool" ? join(f.cwd, "shell.pid") : ready),
		);
		if (boundary === "tool")
			shellPid = Number(await readFile(join(f.cwd, "shell.pid"), "utf8"));
		first.child.kill("SIGKILL");
		await first.exited;
		if (shellPid) {
			// The SDK's shell is detached; a hard server crash is not process supervision.
			try {
				process.kill(-shellPid, "SIGKILL");
			} catch {}
			shellPid = undefined;
		}
		const second = await f.client({
			PID_TEST_RECOVER: "1",
			PID_TEST_READY: join(f.cwd, "unexpected-generation"),
		});
		await second.request("session/load", {
			sessionId,
			cwd: f.cwd,
			mcpServers: [],
		});
		assert.ok(
			second.updates.some(
				(update) => update.sessionUpdate === "user_message_chunk",
			),
		);
		assert.equal(
			await readFile(join(f.cwd, "unexpected-generation"), "utf8").catch(
				() => "missing",
			),
			"missing",
		);
		if (boundary === "tool")
			await waitFor(() =>
				second.updates.some((update) =>
					readText(update).includes("Recovered answer."),
				),
			);
		const start = second.updates.length;
		assert.equal(
			(await second.prompt("context", sessionId)).stopReason,
			"end_turn",
		);
		await second.waitForAnswer((text) => {
			try {
				JSON.parse(text);
				return true;
			} catch {
				return false;
			}
		}, start);
		const history = JSON.parse(
			second.updates.slice(start).map(readText).join(""),
		) as {
			role: string;
			content: unknown;
			isError?: boolean;
		}[];
		assert.equal(
			history.filter((message) => message.role === "user").length,
			2,
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
			second.updates
				.slice(start)
				.every(
					(update) =>
						update.sessionUpdate === "agent_message_chunk" ||
						(update.sessionUpdate === "user_message_chunk" &&
							update.content.type === "text" &&
							update.content.text === "context"),
				),
		);
		if (boundary !== "generation")
			assert.equal(await readFile(join(f.cwd, "effect"), "utf8"), "effect");
	});
}

test("production restart settles A generation and C after-tool interruption while unattached B recovers unsafe bash", {
	timeout: 15000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const workspaces = ["a", "b", "c"].map((label) => join(f.root, label));
	const [, bCwd, cCwd] = workspaces;
	assert.ok(bCwd && cCwd);
	await Promise.all(workspaces.map((cwd) => mkdir(cwd)));
	const log = join(f.root, "first-requests");
	const first = await f.client({ PID_TEST_REQUEST_LOG: log });
	const sessions = await Promise.all(
		workspaces.map((cwd) =>
			first.request("session/new", { cwd, mcpServers: [] }),
		),
	);
	const [a, b, c] = sessions;
	assert.ok(a && b && c);
	const commands = [
		"block",
		JSON.stringify({
			name: "bash",
			args: {
				command: "printf effect >> effect; echo $$ > shell.pid; sleep 60",
			},
		}),
		JSON.stringify({
			name: "write",
			args: { path: "effect", content: "file-effect" },
			blockAfterTool: true,
		}),
	];
	let shellPid: number | undefined;
	t.after(() => {
		if (shellPid) {
			try {
				process.kill(-shellPid, "SIGKILL");
			} catch {}
		}
	});
	for (const [index, session] of sessions.entries()) {
		const command = commands[index];
		assert.ok(command);
		void first.prompt(command, session.sessionId).catch(() => {});
	}
	await waitFor(asyncFileExists(join(bCwd, "shell.pid")));
	shellPid = Number(await readFile(join(bCwd, "shell.pid"), "utf8"));
	let requests = "";
	await waitFor(() => {
		void readFile(log, "utf8").then((value) => {
			requests = value;
		});
		const records = requests
			.split("\n")
			.slice(0, -1)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { input: string; lastRole: string });
		return (
			commands.every((command) =>
				records.some((record) => record.input === command),
			) &&
			records.some(
				(record) =>
					record.input === commands[2] && record.lastRole === "toolResult",
			)
		);
	});
	first.child.kill("SIGKILL");
	await first.exited;
	try {
		process.kill(-shellPid, "SIGKILL");
	} catch {}
	shellPid = undefined;
	const recoveryLog = join(f.root, "recovery-requests");
	const second = await f.client({
		PID_TEST_RECOVER: "1",
		PID_TEST_REQUEST_LOG: recoveryLog,
	});
	// Only initialize has been sent: no client load/prompt/wait has enabled recovery.
	await waitFor(asyncFileExists(recoveryLog));
	let committed = false;
	await waitFor(() => {
		void readFile(join(f.sessions, "db", "main.jsonl"), "utf8").then(
			(value) => {
				committed = value.includes("Recovered answer.");
			},
		);
		return committed;
	});
	await second.close();
	const recoveredRequests = (await readFile(recoveryLog, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { input: string; lastRole: string });
	assert.deepEqual(recoveredRequests, [
		{ input: commands[1], lastRole: "toolResult" },
	]);
	assert.equal(await readFile(join(bCwd, "effect"), "utf8"), "effect");
	assert.equal(await readFile(join(cCwd, "effect"), "utf8"), "file-effect");
	const reader = await f.runtime();
	for (const [index, session] of sessions.entries()) {
		const cwd = workspaces[index];
		assert.ok(cwd);
		const saved = await reader.loadSession(session.sessionId, cwd);
		const history = JSON.stringify(
			(await saved.conversation.context(context)).messages,
		);
		assert.equal(history.includes("Recovered answer."), index === 1);
		const live = await saved.harness.snapshot(
			LiveDoc,
			saved.conversation.id,
			context,
		);
		if (index !== 1) assert.equal(live?.runFailure?.reason, "interrupted");
		assert.equal(
			(await saved.conversation.context(context)).messages.filter(
				(message) => message.role === "user",
			).length,
			1,
		);
	}
	assert.equal(reader.failed, false);
});

function asyncFileExists(path: string) {
	let exists = false;
	return () => {
		void stat(path).then(
			() => {
				exists = true;
			},
			() => {},
		);
		return exists;
	};
}

for (const ending of ["cancel", "provider-error", "EOF", "SIGTERM"] as const) {
	test(`settled ${ending} stays resumable after restart`, {
		timeout: 15000,
	}, async (t) => {
		const f = await persistenceFixture(t);
		const ready = join(f.cwd, "ready");
		const first = await f.client({ PID_TEST_READY: ready });
		const { sessionId } = await first.request("session/new", {
			cwd: f.cwd,
			mcpServers: [],
		});
		await first.prompt("settled baseline", sessionId);
		if (ending === "provider-error")
			await assert.rejects(
				first.prompt("provider-error", sessionId),
				/Prompt failed/,
			);
		else {
			const pending = first.prompt("block", sessionId);
			void pending.catch(() => {});
			await waitFor(asyncFileExists(ready));
			if (ending === "cancel") {
				await first.cancel(sessionId);
				assert.equal((await pending).stopReason, "cancelled");
			} else if (ending === "SIGTERM") {
				first.child.kill("SIGTERM");
				await first.exited;
			}
		}
		await first.close();
		assert.ok(!first.stderr.includes("PRIVATE_PROVIDER_ERROR"));
		assert.doesNotMatch(JSON.stringify(first.wire), /PRIVATE_PROVIDER_ERROR/);
		if (ending === "provider-error")
			assert.equal(
				first.stderr,
				"pid-acp: Prompt failed; check provider connectivity, model configuration and credentials.\n",
			);
		const second = await f.client({ PID_TEST_RECOVER: "1" });
		await second.request("session/load", {
			sessionId,
			cwd: f.cwd,
			mcpServers: [],
		});
		assert.ok(
			second.updates.some(
				(update) => update.sessionUpdate === "user_message_chunk",
			),
		);
		assert.equal(
			(await second.prompt("continuation", sessionId)).stopReason,
			"end_turn",
		);
	});
}

test("cancelled native bash retains its terminal tool result and stops its process group", {
	timeout: 15000,
}, async (t) => {
	const { assertChildrenStopped } = await import("./helpers/processes.ts");
	const f = await persistenceFixture(t);
	const first = await f.client();
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const pending = first.prompt(
		JSON.stringify({
			name: "bash",
			args: { command: "echo $$ > shell.pid; sleep 60" },
		}),
		sessionId,
	);
	await waitFor(asyncFileExists(join(f.cwd, "shell.pid")));
	const pid = Number(await readFile(join(f.cwd, "shell.pid"), "utf8"));
	await first.cancel(sessionId);
	assert.equal((await pending).stopReason, "cancelled");
	await assertChildrenStopped([pid]);
	await first.close();
	const next = await f.client();
	await next.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.ok(next.updates.some((update) => readStatus(update) === "failed"));
	await next.prompt("after cancellation", sessionId);
});

test("shutdown deadline leaves interrupted state reopenable without scheduling", {
	timeout: 15000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const ready = join(f.cwd, "ready");
	const first = await f.client({ PID_TEST_READY: ready });
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const pending = first.prompt("uncooperative", sessionId);
	void pending.catch(() => {});
	await waitFor(asyncFileExists(ready));
	const started = Date.now();
	first.child.kill("SIGTERM");
	const [code] = await first.exited;
	assert.equal(code, 1);
	assert.ok(Date.now() - started >= 3500 && Date.now() - started < 6000);
	assert.match(first.stderr, /Shutdown deadline exceeded/);
	const dormant = join(f.cwd, "unexpected-dormant-generation");
	const next = await f.client({ PID_TEST_READY: dormant });
	await next.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.equal(next.updates.length, 1);
	assert.equal(next.updates[0]?.sessionUpdate, "user_message_chunk");
	await next.close();
	assert.equal(
		await stat(dormant).then(
			() => true,
			() => false,
		),
		false,
	);
});

test("restart restores instruction/catalog snapshots before first generation and skill bodies stay live", {
	timeout: 15000,
}, async (t) => {
	const { mkdir, writeFile } = await import("node:fs/promises");
	const f = await persistenceFixture(t);
	await writeFile(join(f.cwd, "AGENTS.md"), "ORIGINAL_INSTRUCTIONS");
	const skillDir = join(f.cwd, ".agents", "skills", "snapshot");
	await mkdir(skillDir, { recursive: true });
	const skill = join(skillDir, "SKILL.md");
	await writeFile(
		skill,
		"---\nname: snapshot\ndescription: ORIGINAL_SKILL_DESCRIPTION\n---\nORIGINAL_BODY",
	);
	const first = await f.client();
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await first.close();
	await writeFile(join(f.cwd, "AGENTS.md"), "CHANGED_INSTRUCTIONS");
	await writeFile(skill, "MALFORMED_METADATA\nCHANGED_SKILL_BODY");
	const next = await f.client({ PID_TEST_RESOURCE_SNAPSHOT: "1" });
	await next.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.equal(next.updates.length, 0, "Resources are not ACP history");
	assert.equal(
		(await next.prompt("check snapshots", sessionId)).stopReason,
		"end_turn",
	);
	assert.equal(
		(
			await next.prompt(
				JSON.stringify({ name: "read", args: { path: skill } }),
				sessionId,
			)
		).stopReason,
		"end_turn",
	);
	assert.ok(
		next.updates.some(
			(update) =>
				readStatus(update) === "completed" &&
				JSON.stringify(update).includes("CHANGED_SKILL_BODY"),
		),
	);
	assert.equal(next.stderr, "");
});

for (const blocked of ["missing_task", "restart_limit"] as const) {
	test(`startup recovers ${blocked}; prompt ${blocked === "missing_task" ? "rejects blocked work" : "accepts after native settlement"}`, {
		timeout: 10000,
	}, async (t) => {
		const { defineTask } = await import("@earendil-works/pi-durable");
		const { BACKGROUND_CONTEXT: context } = await import(
			"@earendil-works/chord/context"
		);
		const f = await persistenceFixture(t);
		const { Harness } = await import("@earendil-works/pi-durable");
		const open = Harness.open;
		t.mock.method(
			Harness,
			"open",
			async (...args: Parameters<typeof open>) => {
				const native = await open(...args);
				t.mock.method(native, "resume", () => {});
				return native;
			},
			{ times: 1 },
		);
		const first = await f.runtime();
		const session = await f.track(first.createSession(f.cwd));
		const root = session.conversation;
		const token = defineTask({
			name: blocked === "missing_task" ? "test.unavailable" : "pi.generation",
			version: 1,
			initial: () => ({ phase: "prepare" as const }),
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "aborted" } }),
					ctx,
				);
			},
			phases: {
				prepare: async () => {
					throw new Error("must not run");
				},
			},
		});
		const taskId = await root.commit(
			(tx) => tx.createTask(token, {}, { ownership: { kind: "conversation" } }),
			context,
		);
		const sessionId = session.id;
		assert.ok(sessionId);
		await session.close();
		await first.close();
		if (blocked === "restart_limit")
			await f.edit(async (storage) => {
				const task = await storage.task(taskId, context);
				assert.ok(task);
				await commitWrites(
					storage,
					[{ type: "task", value: { ...task, restarts: 5 } }],
					context,
				);
			});
		const next = await f.client();
		await assert.rejects(
			next.request("session/resume", { sessionId, cwd: f.cwd, mcpServers: [] }),
			/Method not found/,
		);
		await next.request("session/load", {
			sessionId,
			cwd: f.cwd,
			mcpServers: [],
		});
		assert.equal(next.updates.length, 0);
		if (blocked === "missing_task") {
			await assert.rejects(
				next.prompt("must not be submitted", sessionId),
				/Saved work is blocked/,
			);
			assert.equal(next.updates.length, 0);
		} else {
			assert.equal(
				(await next.prompt("fresh input", sessionId)).stopReason,
				"end_turn",
			);
		}
		await next.close();
		const reader = await f.runtime();
		const saved = await f.track(reader.loadSession(sessionId, f.cwd));
		const inspection = await saved.harness.inspect(context);
		assert.equal(inspection.scheduling, "running");
		if (blocked === "missing_task") {
			assert.ok(
				inspection.tasks.some(
					(task) =>
						task.state.kind === "blocked" && task.state.reason === blocked,
				),
			);
			assert.equal(
				(await saved.conversation.context(context)).messages.length,
				0,
			);
		} else {
			const task = await saved.harness.getTask(taskId, context);
			assert.equal(task?.state.status, "terminal");
			assert.match(JSON.stringify(task), /restart_limit/);
		}
	});
}

test("cancellation during native resumed generation admits no fresh input and preserves one-prompt admission", {
	timeout: 15000,
}, async (t) => {
	const { existsSync } = await import("node:fs");
	const f = await persistenceFixture(t);
	const first = await f.client();
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const old = first.prompt(
		JSON.stringify({
			name: "bash",
			args: { command: "echo $$ > shell.pid; sleep 60" },
			blockAfterTool: true,
		}),
		sessionId,
	);
	void old.catch(() => {});
	await waitFor(() => existsSync(join(f.cwd, "shell.pid")));
	const shellPid = Number(await readFile(join(f.cwd, "shell.pid"), "utf8"));
	t.after(() => {
		try {
			process.kill(-shellPid, "SIGKILL");
		} catch {}
	});
	first.child.kill("SIGKILL");
	await first.exited;
	try {
		process.kill(-shellPid, "SIGKILL");
	} catch {}
	const resumed = join(f.cwd, "resumed");
	const next = await f.client({ PID_TEST_READY: resumed });
	await next.request("session/load", { sessionId, cwd: f.cwd, mcpServers: [] });
	await waitFor(() => existsSync(resumed));
	assert.ok(next.updates.length > 1);
	await assert.rejects(
		next.prompt("not admitted", sessionId),
		/already active/,
	);
	await assert.rejects(next.prompt("overlap", sessionId), /already active/);
	await next.cancel(sessionId);
	// Cancel is a notification, so observe native settlement through retryable admission.
	await waitFor(() =>
		next.updates.some((update) => update.sessionUpdate === "tool_call_update"),
	);
	const replayCount = next.updates.length;
	let response: Awaited<ReturnType<typeof next.prompt>> | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			response = await next.prompt("context", sessionId);
			break;
		} catch (error) {
			assert.match(String(error), /already active/);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	assert.equal(response?.stopReason, "end_turn");
	await next.waitForAnswer((text) => {
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	}, replayCount);
	const history = JSON.parse(
		next.updates.slice(replayCount).map(readText).join(""),
	) as {
		role: string;
		content: unknown;
	}[];
	assert.ok(
		!history.some(
			(message) =>
				message.role === "user" &&
				["not admitted", "overlap"].includes(String(message.content)),
		),
	);
	assert.equal(history.filter((message) => message.role === "user").length, 2);
});
