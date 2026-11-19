import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpServerFixture } from "./helpers/acp-server-fixture.ts";
import { Adapter } from "../dist/adapter.js";
import { Runtime } from "../dist/runtime.js";
import { Session } from "../dist/session.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { captureEnvironmentFactory } from "./helpers/environments.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

async function savedAcpServer(
	t: import("node:test").TestContext,
	content: import("@earendil-works/pi-ai").UserMessage["content"] = "saved input",
) {
	const { persistenceFixture } = await import("./helpers/persistence.ts");
	const { UserEntry } = await import("@earendil-works/pi-durable");
	const { client } = await import("@agentclientprotocol/sdk");
	const f = await persistenceFixture(t);
	const fail = await captureStorageFailure(t);
	const saved = await f.runtime();
	const session = await f.track(saved.createSession(f.cwd));
	const conversation = session.conversation;
	await conversation.commit(async (tx) => {
		await tx.appendEntry(UserEntry, conversation.id, {
			model: [{ role: "user", content, timestamp: 0 }],
		});
	}, context);
	const id = session.id;
	await session.close();
	await saved.close();
	const runtime = await f.runtime();
	let selected: Session | undefined;
	const load = runtime.loadSession.bind(runtime);
	t.mock.method(runtime, "loadSession", async (id: string, cwd: string) => {
		selected = await f.track(load(id, cwd));
		return selected;
	});
	const acpServer = new AcpServerFixture(runtime);
	const connection = client().connect(acpServer.createApp());
	t.after(async () => {
		connection.close();
		await acpServer.close().catch(() => {});
	});
	return {
		...f,
		fail,
		id,
		createRuntime: f.runtime,
		runtime,
		acpServer,
		get selected() {
			return selected;
		},
		agent: connection.agent,
		load: () =>
			connection.agent.request("session/load", {
				sessionId: id,
				cwd: f.cwd,
				mcpServers: [],
			}),
	};
}

async function deferReplay(t: import("node:test").TestContext) {
	const { AgentContext } = await import("@agentclientprotocol/sdk");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const notify = t.mock.method(AgentContext.prototype, "notify", async () => {
		entered.resolve();
		await release.promise;
	});
	t.after(() => release.resolve());
	return { entered: entered.promise, release, notify };
}

async function captureStorageFailure(t: import("node:test").TestContext) {
	const { Harness } = await import("@earendil-works/pi-durable");
	const open = Harness.open;
	let report: import("@earendil-works/pi-durable").HarnessOptions["onReport"];
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		report = args[1].onReport;
		return open(...args);
	});
	return () => {
		assert.ok(report);
		report({
			error: new Error(
				"PRIVATE_STORAGE key=PRIVATE_KEY transcript=PRIVATE_INPUT",
			),
			kind: "storage_failed",
		});
	};
}

async function assertPending(promise: Promise<unknown>) {
	const { setImmediate } = await import("node:timers/promises");
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await setImmediate();
	assert.equal(settled, false);
}

async function assertAdmissionBlocked(
	f: Awaited<ReturnType<typeof savedAcpServer>>,
	loadOpening = true,
) {
	await assert.rejects(
		f.agent.request("session/prompt", {
			sessionId: f.id,
			prompt: [{ type: "text", text: "overlap" }],
		}),
		/Unknown session ID|not ready/,
	);
	await assert.rejects(
		f.agent.request("_session/steering", {
			sessionId: f.id,
			prompt: [{ type: "text", text: "overlap" }],
		}),
		/Unknown session ID|not ready/,
	);
	if (loadOpening)
		await assert.rejects(f.load(), /already attached or opening/);
}

test("ACP server closes owned harness and store when execution cleanup rejects", async (t) => {
	const createEnvironment = captureEnvironmentFactory(t);
	const f = await savedAcpServer(t);
	await f.load();
	const session = f.selected;
	assert.ok(session);
	const conversation = session.conversation;
	await createEnvironment(session, f.cwd);
	const close = t.mock.method(session.harness, "close");
	const cleanup = t.mock.method(
		NodeExecutionEnv.prototype,
		"cleanup",
		async () => {
			throw new Error("cleanup failed");
		},
	);
	const closed = f.acpServer.close();
	assert.equal(f.acpServer.close(), closed);
	await assert.rejects(closed, /Could not release shared/);
	t.mock.method(f.runtime, "close", async () => {});
	cleanup.mock.restore();
	assert.equal(close.mock.callCount(), 1);
	assert.equal(session.closed, true);
	await assert.rejects(conversation.agent(context));
	const other = await f.createRuntime();
	await f.track(other.loadSession(f.id, f.cwd));
	// The shutdown failure is stable; the fixture must observe that expected rejection too.
	t.mock.method(f.acpServer, "close", async () => {
		await assert.rejects(closed, /Could not release shared/);
	});
});

test("unknown cancellation is harmless and shutdown rejects new admission and prompts", async (t) => {
	const f = await savedAcpServer(t);
	await assert.rejects(
		f.agent.request("session/prompt", {
			sessionId: f.id,
			prompt: [{ type: "text", text: "before load" }],
		}),
		/Unknown session ID/,
	);
	await f.agent.notify("session/cancel", { sessionId: f.id });
	await f.load();
	await f.acpServer.close();
	await f.agent.notify("session/cancel", { sessionId: f.id });
	await assert.rejects(
		f.agent.request("session/new", { cwd: f.cwd, mcpServers: [] }),
		/Server is shutting down/,
	);
	await assert.rejects(
		f.agent.request("session/prompt", {
			sessionId: f.id,
			prompt: [{ type: "text", text: "after close" }],
		}),
		/Server is shutting down/,
	);
});

test("load holds admission through replay and returns only after delivery", async (t) => {
	const replay = await deferReplay(t);
	const f = await savedAcpServer(t);
	const loaded = f.load();
	await replay.entered;
	await assertPending(loaded);
	await assertAdmissionBlocked(f);
	const [method, params] = replay.notify.mock.calls[0]?.arguments ?? [];
	assert.equal(method, "session/update");
	assert.partialDeepStrictEqual(params, {
		sessionId: f.id,
		update: {
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "saved input" },
		},
	});
	replay.release.resolve();
	assert.deepEqual(await loaded, {});
	assert.equal(f.selected?.id, f.id);
	await assert.rejects(f.load(), /already attached or opening/);
});

test("ACP server routes prompt and cancel only after replay transfers the ready Session to Adapter", async (t) => {
	const replay = await deferReplay(t);
	const f = await savedAcpServer(t);
	const prompt = t.mock.method(Adapter.prototype, "prompt", async () => ({
		stopReason: "end_turn" as const,
	}));
	const cancel = t.mock.method(Adapter.prototype, "cancel", async () => {});
	const loaded = f.load();
	await replay.entered;
	await assertAdmissionBlocked(f);
	assert.equal(prompt.mock.callCount(), 0);
	replay.release.resolve();
	await loaded;
	const params = {
		sessionId: f.id,
		prompt: [
			{ type: "text" as const, text: "fresh" },
			{ type: "text" as const, text: "second block" },
		],
	};
	assert.deepEqual(await f.agent.request("session/prompt", params), {
		stopReason: "end_turn",
	});
	assert.equal(prompt.mock.callCount(), 1);
	assert.deepEqual(prompt.mock.calls[0]?.arguments, [
		f.id,
		"fresh\nsecond block",
	]);
	await f.agent.notify("session/cancel", { sessionId: f.id });
	const { setImmediate } = await import("node:timers/promises");
	await setImmediate();
	assert.equal(cancel.mock.callCount(), 1);
	assert.equal(cancel.mock.calls[0]?.arguments[0], f.id);
});

test("load awaits every update from a message in order before responding", async (t) => {
	const { AgentContext } = await import("@agentclientprotocol/sdk");
	const entered = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	const release = [
		Promise.withResolvers<void>(),
		Promise.withResolvers<void>(),
	];
	t.after(() => {
		for (const gate of release) gate.resolve();
	});
	let index = 0;
	const notify = t.mock.method(AgentContext.prototype, "notify", async () => {
		const current = index++;
		entered[current]?.resolve();
		await release[current]?.promise;
	});
	const f = await savedAcpServer(t, [
		{ type: "text", text: "first" },
		{ type: "text", text: "second" },
	]);
	const loaded = f.load();
	for (const current of [0, 1]) {
		await entered[current]?.promise;
		await assertPending(loaded);
		assert.equal(notify.mock.callCount(), current + 1);
		const [, params] = notify.mock.calls[current]?.arguments ?? [];
		assert.partialDeepStrictEqual(params, {
			sessionId: f.id,
			update: {
				content: { type: "text", text: current === 0 ? "first" : "second" },
			},
		});
		release[current]?.resolve();
	}
	assert.deepEqual(await loaded, {});
});

test("close unblocks replay and releases the attachment without waiting for the client", async (t) => {
	const replay = await deferReplay(t);
	const f = await savedAcpServer(t);
	const loaded = assert.rejects(f.load(), /Could not load saved session/);
	await replay.entered;
	const session = f.selected;
	assert.ok(session);
	const close = t.mock.method(session, "close");
	const abort = t.mock.method(session.conversation, "abort");
	const nativeClose = t.mock.method(session.harness, "close");
	assert.equal(close.mock.callCount(), 0);
	assert.equal(nativeClose.mock.callCount(), 0);
	await assertAdmissionBlocked(f);
	const closed = f.acpServer.close();
	assert.equal(f.acpServer.close(), closed);
	await assert.rejects(
		f.agent.request("session/prompt", {
			sessionId: f.id,
			prompt: [{ type: "text", text: "after close" }],
		}),
		/shutting down/,
	);
	await assert.rejects(
		f.agent.request("_session/steering", {
			sessionId: f.id,
			prompt: [{ type: "text", text: "after close" }],
		}),
		/shutting down/,
	);
	await Promise.all([closed, loaded]);
	replay.release.resolve();
	assert.equal(close.mock.callCount(), 1);
	assert.equal(nativeClose.mock.callCount(), 1);
	assert.equal(abort.mock.callCount(), 0);
	assert.equal(session.closed, true);
	await assert.rejects(f.load(), /shutting down/);
	const other = await f.createRuntime();
	await f.track(other.loadSession(f.id, f.cwd));
});

test("replay transport failure releases attachment ownership without closing the sandbox and permits a clean retry", async (t) => {
	const replay = await deferReplay(t);
	const cleanup = Promise.withResolvers<void>();
	t.after(() => cleanup.resolve());
	const f = await savedAcpServer(t);
	const sandboxClose = t.mock.method(CodemodeSandbox.prototype, "close");
	const loaded = assert.rejects(f.load(), (error: Error) => {
		assert.match(error.message, /Could not load saved session/);
		assert.doesNotMatch(error.message, /PRIVATE_TRANSPORT/);
		return true;
	});
	await replay.entered;
	const session = f.selected;
	assert.ok(session);
	const discarding = Promise.withResolvers<void>();
	const close = session.close.bind(session);
	t.mock.method(session, "close", async () => {
		discarding.resolve();
		await cleanup.promise;
		await close();
	});
	replay.release.reject(new Error("PRIVATE_TRANSPORT"));
	await discarding.promise;
	await assertPending(loaded);
	await assertAdmissionBlocked(f);
	const independent = await f.agent.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});

	assert.equal(session.closed, false);
	cleanup.resolve();
	await loaded;
	assert.equal(session.closed, true);
	// Attachment rollback retains shared execution and the process lock.
	const reopened = await f.track(f.runtime.loadSession(f.id, f.cwd));
	await reopened.close();
	assert.equal(sandboxClose.mock.callCount(), 0);
	replay.notify.mock.restore();
	await assert.rejects(
		f.agent.request("session/load", {
			sessionId: independent.sessionId,
			cwd: f.cwd,
			mcpServers: [],
		}),
		/already attached or opening/,
	);
	assert.deepEqual(await f.load(), {});
	assert.equal(f.selected?.id, f.id);
	await f.acpServer.close();
	assert.equal(f.selected?.closed, true);
});

for (const outcome of ["success", "failure"] as const) {
	test(`history snapshot ${outcome} releases the session once`, async (t) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		t.after(() => release.resolve());
		const f = await savedAcpServer(t);
		const load = f.runtime.loadSession.bind(f.runtime);
		let candidate: Session | undefined;
		t.mock.method(
			f.runtime,
			"loadSession",
			async (id: string, cwd: string) => {
				candidate = await load(id, cwd);
				const snapshot = candidate.conversation.context.bind(
					candidate.conversation,
				);
				t.mock.method(
					candidate.conversation,
					"context",
					async (...args: Parameters<typeof snapshot>) => {
						entered.resolve();
						await release.promise;
						if (outcome === "failure") throw new Error("PRIVATE_HISTORY");
						return snapshot(...args);
					},
				);
				return candidate;
			},
			{ times: 1 },
		);
		const request = f.load();
		const loaded =
			outcome === "success"
				? request
				: assert.rejects(request, (error: Error) => {
						assert.match(error.message, /Could not load saved session/);
						assert.doesNotMatch(error.message, /PRIVATE_HISTORY/);
						return true;
					});
		await entered.promise;
		assert.ok(candidate);
		const close = t.mock.method(candidate, "close");

		assert.equal(close.mock.callCount(), 0);
		assert.equal(candidate.closed, false);
		await assertAdmissionBlocked(f);
		release.resolve();
		await loaded;
		assert.equal(candidate.closed, outcome === "failure");
		await f.acpServer.close();
		assert.equal(candidate.closed, true);
		assert.equal(close.mock.callCount(), 1);
		const other = await f.createRuntime();
		await f.track(other.loadSession(f.id, f.cwd));
	});
}

for (const operation of ["createSession", "loadSession"] as const) {
	for (const outcome of ["success", "failure"] as const) {
		test(`close waits for shared ${operation} ${outcome} without attaching`, async (t) => {
			const f = await savedAcpServer(t);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			t.after(() => release.resolve());
			const select = f.runtime[operation].bind(f.runtime);
			const nativeClose = t.mock.method(
				(await f.runtime.loadSession(f.id, f.cwd)).harness,
				"close",
			);
			t.mock.method(f.runtime, operation, async (...args: [string, string]) => {
				entered.resolve();
				await release.promise;
				if (outcome === "failure") throw new Error("PRIVATE_SELECTION");
				return select(...args);
			});
			const request = f.agent.request(
				operation === "createSession" ? "session/new" : "session/load",
				{ cwd: f.cwd, sessionId: f.id, mcpServers: [] },
			);
			const selected = assert.rejects(
				request,
				outcome === "success" ? /shutting down/ : /Could not (create|load)/,
			);
			const attach = t.mock.method(Adapter.prototype, "attach");
			const close = t.mock.method(Session.prototype, "close");
			await entered.promise;

			const closed = f.acpServer.close();
			await assertPending(closed);
			await assert.rejects(f.load(), /shutting down/);
			assert.equal(nativeClose.mock.callCount(), 0);
			release.resolve();
			await Promise.all([selected, closed]);
			assert.equal(attach.mock.callCount(), 0);
			assert.equal(close.mock.callCount(), outcome === "success" ? 1 : 0);
			assert.equal(nativeClose.mock.callCount(), 1);
		});
	}
}

test("failed rollback is sanitized and releases opening admission for close", async (t) => {
	const replay = await deferReplay(t);
	const f = await savedAcpServer(t);
	const loaded = assert.rejects(f.load(), (error: Error) => {
		assert.match(
			error.message,
			/Could not release session storage.*Close the server/,
		);
		assert.doesNotMatch(error.message, /PRIVATE_/);
		return true;
	});
	await replay.entered;
	const session = f.selected;
	assert.ok(session);
	const close = session.close.bind(session);
	t.mock.method(
		session,
		"close",
		async () => {
			await close();
			throw new Error("PRIVATE_CLEANUP");
		},
		{ times: 1 },
	);

	replay.release.reject(new Error("PRIVATE_TRANSPORT"));
	await loaded;
	await assert.rejects(f.acpServer.close(), /Could not release shared/);
	await assert.rejects(f.load(), /shutting down/);
	assert.equal(session.closed, true);
	const other = await f.createRuntime();
	await f.track(other.loadSession(f.id, f.cwd));
});

for (const boundary of ["admission", "validation"] as const) {
	test(`fatal storage failure at ${boundary} prevents native opening`, async (t) => {
		const f = await savedAcpServer(t);
		const fail = f.fail;
		const seed = await f.track(f.runtime.loadSession(f.id, f.cwd));
		await seed.close();
		const { Harness } = await import("@earendil-works/pi-durable");
		const open = t.mock.method(Harness, "open");
		const load = t.mock.method(f.runtime, "loadSession");
		const create = t.mock.method(f.runtime, "createSession");
		const close = t.mock.method(Session.prototype, "close");
		if (boundary === "admission") fail();
		else {
			const fs = (await import("node:fs/promises")).default;
			const { syncBuiltinESMExports } = await import("node:module");
			const stat = fs.stat;
			const validation = t.mock.method(fs, "stat", async (path: string) => {
				const result = await stat(path);
				if (path === f.cwd) fail();
				return result;
			});
			syncBuiltinESMExports();
			t.after(() => {
				validation.mock.restore();
				syncBuiltinESMExports();
			});
		}
		await assert.rejects(f.load(), (error: Error) => {
			assert.match(
				error.message,
				boundary === "admission" ? /shutting down/ : /Session storage failed/,
			);
			assert.doesNotMatch(error.message, /PRIVATE_/);
			return true;
		});
		await f.runtime.failure;
		assert.equal(f.runtime.failed, true);
		await assert.rejects(
			f.agent.request("session/new", { cwd: "relative", mcpServers: [] }),
			/shutting down/,
		);
		assert.equal(load.mock.callCount(), boundary === "admission" ? 0 : 1);
		assert.equal(create.mock.callCount(), 0);
		assert.equal(open.mock.callCount(), 0);
		assert.equal(close.mock.callCount(), 0);
	});
}

for (const method of ["session/new", "session/load"] as const) {
	test(`fatal storage failure during ${method} prevents replay/publication and holds admission through rollback`, async (t) => {
		const { AgentContext } = await import("@agentclientprotocol/sdk");
		const f = await savedAcpServer(t);
		const fail = f.fail;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const discarding = Promise.withResolvers<void>();
		const cleanup = Promise.withResolvers<void>();
		t.after(() => {
			release.resolve();
			cleanup.resolve();
		});
		let candidate: Session | undefined;
		const hold = async (session: Session) => {
			candidate = session;
			entered.resolve();
			await release.promise;
			return session;
		};
		if (method === "session/new") {
			const create = f.runtime.createSession.bind(f.runtime);
			t.mock.method(f.runtime, "createSession", async (cwd: string) =>
				hold(await f.track(create(cwd))),
			);
		} else {
			const load = f.runtime.loadSession.bind(f.runtime);
			t.mock.method(f.runtime, "loadSession", async (id: string, cwd: string) =>
				hold(await load(id, cwd)),
			);
		}
		const notify = t.mock.method(
			AgentContext.prototype,
			"notify",
			async () => {},
		);
		const selected = assert.rejects(
			f.agent.request(method, { sessionId: f.id, cwd: f.cwd, mcpServers: [] }),
			(error: Error) => {
				assert.match(
					error.message,
					/Session storage failed.*Restart the server/,
				);
				assert.doesNotMatch(error.message, /PRIVATE_/);
				return true;
			},
		);
		await entered.promise;
		assert.ok(candidate);
		const id = candidate.id;
		const snapshot = t.mock.method(candidate.conversation, "context");
		const close = candidate.close.bind(candidate);
		const rollback = t.mock.method(candidate, "close", async () => {
			discarding.resolve();
			await cleanup.promise;
			await close();
		});
		fail();
		await f.runtime.failure;
		assert.equal(candidate.failed, true);
		assert.equal(f.runtime.failed, true);

		assert.equal(rollback.mock.callCount(), 0);
		release.resolve();
		await discarding.promise;
		const draining = f.acpServer.detach();
		await assertPending(draining);
		await assertPending(selected);

		await assert.rejects(f.load(), /shutting down/);
		assert.equal(candidate.closed, false);
		cleanup.resolve();
		await Promise.all([selected, draining]);
		assert.equal(candidate.closed, true);
		assert.equal(rollback.mock.callCount(), 1);
		assert.equal(snapshot.mock.callCount(), 0);
		assert.equal(notify.mock.callCount(), 0);
		await f.acpServer.close();
		assert.equal(rollback.mock.callCount(), 1);
		const other = await f.createRuntime();
		await f.track(other.loadSession(id, f.cwd));
	});
}

for (const boundary of ["snapshot", "first send", "last send"] as const) {
	test(`fatal storage failure during history ${boundary} prevents publication and releases the candidate`, async (t) => {
		const { AgentContext } = await import("@agentclientprotocol/sdk");
		const f = await savedAcpServer(t, [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		]);
		const fail = f.fail;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		t.after(() => release.resolve());
		const pause = async () => {
			entered.resolve();
			await release.promise;
		};
		const load = f.runtime.loadSession.bind(f.runtime);
		t.mock.method(f.runtime, "loadSession", async (id: string, cwd: string) => {
			const session = await load(id, cwd);
			const snapshot = session.conversation.context.bind(session.conversation);
			t.mock.method(
				session.conversation,
				"context",
				async (...args: Parameters<typeof snapshot>) => {
					const history = await snapshot(...args);
					if (boundary === "snapshot") await pause();
					return history;
				},
			);
			return session;
		});
		let sends = 0;
		const notify = t.mock.method(AgentContext.prototype, "notify", async () => {
			sends++;
			if (
				(boundary === "first send" && sends === 1) ||
				(boundary === "last send" && sends === 2)
			)
				await pause();
		});
		const loaded = assert.rejects(f.load(), (error: Error) => {
			assert.match(error.message, /Session storage failed.*Restart the server/);
			assert.doesNotMatch(error.message, /PRIVATE_/);
			return true;
		});
		await entered.promise;
		const candidate = f.selected;
		assert.ok(candidate);
		const close = t.mock.method(candidate, "close");
		fail();
		await f.runtime.failure;
		assert.equal(candidate.failed, true);
		assert.equal(f.runtime.failed, true);

		assert.equal(close.mock.callCount(), 0);
		const detached = f.acpServer.detach();
		release.resolve();
		await Promise.all([loaded, detached]);
		assert.equal(candidate.closed, true);
		assert.equal(close.mock.callCount(), 1);
		assert.equal(
			notify.mock.callCount(),
			boundary === "snapshot" ? 0 : boundary === "first send" ? 1 : 2,
		);
		await f.acpServer.close();
		assert.equal(close.mock.callCount(), 1);
		const other = await f.createRuntime();
		await f.track(other.loadSession(f.id, f.cwd));
	});
}

test("invalid cwd releases opening admission for retry", async (t) => {
	const f = await savedAcpServer(t);
	const load = t.mock.method(f.runtime, "loadSession");
	await assert.rejects(
		f.agent.request("session/load", {
			sessionId: f.id,
			cwd: "relative",
			mcpServers: [],
		}),
		/cwd must be an existing absolute directory/,
	);
	assert.equal(load.mock.callCount(), 0);
	assert.deepEqual(await f.load(), {});
	assert.equal(load.mock.callCount(), 1);
});

for (const outcome of ["success", "failure", "drain"] as const) {
	test(`cwd validation racing detach: ${outcome}`, async (t) => {
		const fs = (await import("node:fs/promises")).default;
		const { syncBuiltinESMExports } = await import("node:module");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		t.after(() => release.resolve());
		const f = await savedAcpServer(t);
		const stat = fs.stat;
		const validation = t.mock.method(fs, "stat", async (path: string) => {
			if (path === f.cwd) {
				entered.resolve();
				await release.promise;
				if (outcome === "failure") throw new Error("PRIVATE_VALIDATION");
			}
			return stat(path);
		});
		syncBuiltinESMExports();
		t.after(() => {
			validation.mock.restore();
			syncBuiltinESMExports();
		});
		const load = t.mock.method(f.runtime, "loadSession");
		const close = t.mock.method(Session.prototype, "close");
		const request = f.load();
		const loaded =
			outcome === "success"
				? request
				: assert.rejects(
						request,
						outcome === "failure"
							? /cwd must be an existing absolute directory/
							: /shutting down/,
					);
		await entered.promise;

		assert.equal(close.mock.callCount(), 0);
		await assertAdmissionBlocked(f);
		const draining = outcome === "drain" ? f.acpServer.detach() : undefined;
		release.resolve();
		await Promise.all([loaded, draining]);
		await f.acpServer.close();
		assert.equal(load.mock.callCount(), outcome === "failure" ? 0 : 1);
		assert.equal(close.mock.callCount(), outcome === "failure" ? 0 : 1);
		assert.equal(f.selected?.closed, outcome === "failure" ? undefined : true);
	});
}

test("transient runtime owns native resources before session admission", async () => {
	const runtime = await Runtime.open(createModels(), {
		provider: "unused",
		modelId: "unused",
	});
	assert.equal(runtime.persistent, false);
	const acpServer = new AcpServerFixture(runtime);
	await acpServer.close();
	assert.equal("harness" in runtime, true);
});

test("shutdown attempts every attachment and closes Runtime once when one attachment fails", async (t) => {
	const f = await savedAcpServer(t);
	await f.load();
	const first = f.selected;
	assert.ok(first);
	let sibling: Session | undefined;
	const create = f.runtime.createSession.bind(f.runtime);
	t.mock.method(
		f.runtime,
		"createSession",
		async (...args: Parameters<typeof create>) => {
			sibling = await create(...args);
			return sibling;
		},
	);
	await f.agent.request("session/new", { cwd: f.cwd, mcpServers: [] });
	assert.ok(sibling);
	const siblingClose = t.mock.method(sibling, "close");
	t.mock.method(first, "close", async () => {
		throw new Error("PRIVATE_RELEASE");
	});
	const nativeClose = t.mock.method(f.runtime, "close");
	const closed = f.acpServer.close();
	assert.equal(f.acpServer.close(), closed);
	await assert.rejects(closed, /Could not release shared/);
	assert.equal(siblingClose.mock.callCount(), 1);
	assert.equal(nativeClose.mock.callCount(), 1);
	t.mock.method(f.acpServer, "close", async () => {
		await assert.rejects(closed, /Could not release shared/);
	});
	t.mock.method(first, "close", async () => {});
});

test("new reserves its ACP session ID before native creation publishes", {
	timeout: 5000,
}, async (t) => {
	const f = await savedAcpServer(t);
	const entered = Promise.withResolvers<string>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const create = f.runtime.createSession.bind(f.runtime);
	t.mock.method(
		f.runtime,
		"createSession",
		async (cwd: string, requestedSessionId?: string) => {
			assert.ok(requestedSessionId);
			entered.resolve(requestedSessionId);
			await release.promise;
			return create(cwd, requestedSessionId);
		},
	);
	const pending = f.agent.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const id = await entered.promise;
	await assert.rejects(
		f.agent.request("session/prompt", {
			sessionId: id,
			prompt: [{ type: "text", text: "too early" }],
		}),
		/not ready/,
	);
	await assert.rejects(
		f.agent.request("session/load", {
			sessionId: id,
			cwd: f.cwd,
			mcpServers: [],
		}),
		/already attached or opening/,
	);

	release.resolve();
	assert.equal((await pending).sessionId, id);
	await f.acpServer.close();
});

test("blocked replay reserves only its ID while independent new/load and rollback proceed", {
	timeout: 5000,
}, async (t) => {
	const f = await savedAcpServer(t);
	const second = await f.runtime.createSession(f.cwd);
	const { AgentContext } = await import("@agentclientprotocol/sdk");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	t.mock.method(
		AgentContext.prototype,
		"notify",
		async (_method: string, params: { sessionId: string }) => {
			if (params.sessionId !== f.id) return;
			entered.resolve();
			await release.promise;
		},
	);
	const loaded = f.load();
	await entered.promise;
	await assertAdmissionBlocked(f);
	await f.agent.request("session/load", {
		sessionId: second.id,
		cwd: f.cwd,
		mcpServers: [],
	});
	const created = await f.agent.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.notEqual(created.sessionId, second.id);
	await assert.rejects(
		f.agent.request("session/load", {
			sessionId: "stale",
			cwd: f.cwd,
			mcpServers: [],
		}),
		/Invalid session ID/,
	);

	release.resolve();
	await loaded;
	await assert.rejects(f.load(), /already attached or opening/);
	await f.acpServer.close();
});

test("replay hands off coalesced commits beyond the native watch window without gaps or duplicates", {
	timeout: 5000,
}, async (t) => {
	const { AgentContext } = await import("@agentclientprotocol/sdk");
	const { AssistantEntry } = await import("@earendil-works/pi-durable");
	const { fauxAssistantMessage } = await import(
		"@earendil-works/pi-ai/providers/faux"
	);
	const { waitFor } = await import("./helpers/client.ts");
	const f = await savedAcpServer(t);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const updates: import("@agentclientprotocol/sdk").SessionUpdate[] = [];
	t.mock.method(
		AgentContext.prototype,
		"notify",
		async (
			_method: string,
			params: {
				sessionId: string;
				update: import("@agentclientprotocol/sdk").SessionUpdate;
			},
		) => {
			assert.equal(params.sessionId, f.id);
			updates.push(params.update);
			if (updates.length === 1) {
				entered.resolve();
				await release.promise;
			}
		},
	);
	const loaded = f.load();
	await entered.promise;
	const conversation = f.selected?.conversation;
	assert.ok(conversation);
	await conversation.commit(async (tx) => {
		for (let index = 0; index < 250; index++)
			await tx.appendEntry(AssistantEntry, conversation.id, {
				model: [fauxAssistantMessage(`message-${index};`)],
			});
	}, context);
	release.resolve();
	await loaded;
	await waitFor(
		() =>
			updates.filter((update) => update.sessionUpdate === "agent_message_chunk")
				.length === 250,
	);
	const text = updates.flatMap((update) =>
		update.sessionUpdate === "agent_message_chunk" &&
		update.content.type === "text"
			? [update.content.text]
			: [],
	);
	assert.deepEqual(
		text,
		Array.from({ length: 250 }, (_, index) => `message-${index};`),
	);
	await f.acpServer.close();
});

test("load fills commits between its context snapshot and watch acquisition even with no later revision", {
	timeout: 5000,
}, async (t) => {
	const { AgentContext } = await import("@agentclientprotocol/sdk");
	const { AssistantEntry } = await import("@earendil-works/pi-durable");
	const { fauxAssistantMessage } = await import(
		"@earendil-works/pi-ai/providers/faux"
	);
	const f = await savedAcpServer(t);
	const load = f.runtime.loadSession.bind(f.runtime);
	t.mock.method(f.runtime, "loadSession", async (id: string, cwd: string) => {
		const session = await load(id, cwd);
		const snapshot = session.conversation.context.bind(session.conversation);
		t.mock.method(
			session.conversation,
			"context",
			async (...args: Parameters<typeof snapshot>) => {
				const before = await snapshot(...args);
				await session.conversation.commit(async (tx) => {
					await tx.appendEntry(AssistantEntry, session.conversation.id, {
						model: [fauxAssistantMessage("between snapshot and watch")],
					});
				}, context);
				return before;
			},
			{ times: 1 },
		);
		return session;
	});
	const updates: import("@agentclientprotocol/sdk").SessionUpdate[] = [];
	t.mock.method(
		AgentContext.prototype,
		"notify",
		async (
			_method: string,
			params: { update: import("@agentclientprotocol/sdk").SessionUpdate },
		) => {
			updates.push(params.update);
		},
	);
	await f.load();
	assert.equal(
		updates.filter(
			(update) =>
				update.sessionUpdate === "agent_message_chunk" &&
				update.content.type === "text" &&
				update.content.text === "between snapshot and watch",
		).length,
		1,
	);
	await f.acpServer.close();
});
