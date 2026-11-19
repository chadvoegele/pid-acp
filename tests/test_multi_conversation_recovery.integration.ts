import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { client, type SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpServerFixture } from "./helpers/acp-server-fixture.ts";
import { assertChildrenStopped } from "./helpers/processes.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { FilesystemSessionStore } from "../dist/filesystem-session-store.js";
import { waitFor } from "./helpers/client.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	Harness,
	defineTask,
	defineExtension,
	type Registry,
	type Submission,
} from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../dist/runtime.js";
import { Adapter } from "../dist/adapter.js";
import { persistenceFixture } from "./helpers/persistence.ts";

test("accepted close joins A/B and unattached C bash before environment cleanup and lock release, then recovers without cancellation", {
	timeout: 10000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const provider = fauxProvider();
	provider.setResponses(
		Array.from({ length: 3 }, () => (request) => {
			const user = request.messages.findLast(
				(message) => message.role === "user",
			);
			assert.ok(typeof user?.content === "string");
			return fauxAssistantMessage(
				fauxToolCall("bash", {
					command: `echo $$ > ${user.content}.pid; sleep 60`,
				}),
				{ stopReason: "toolUse" },
			);
		}),
	);
	const models = createModels();
	models.setProvider(provider.provider);
	const launch = () =>
		Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{ instructionsPath: "", skillsDir: "" },
			f.sessions,
		);
	const runtime = await launch();
	const server = new AcpServerFixture(runtime);
	const connection = client().connect(server.createApp());
	t.after(async () => {
		connection.close();
		await server.close();
	});
	const [a, b] = await Promise.all(
		Array.from({ length: 2 }, () =>
			connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] }),
		),
	);
	assert.ok(a && b);
	const c = await runtime.createSession(f.cwd);
	const abort = t.mock.method(c.conversation, "abort");
	const pending = [a, b].map((session, index) =>
		assert.rejects(
			connection.agent.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: index === 0 ? "A" : "B" }],
			}),
			/Server stopped/,
		),
	);
	await c.conversation.submit({ type: "input", content: "C" }, context);
	await waitFor(() =>
		["A", "B", "C"].every((label) => existsSync(join(f.cwd, `${label}.pid`))),
	);
	const pids = await Promise.all(
		["A", "B", "C"].map(async (label) =>
			Number(await readFile(join(f.cwd, `${label}.pid`), "utf8")),
		),
	);
	const order: string[] = [];
	const nativeClose = c.harness.close.bind(c.harness);
	const closed = t.mock.method(
		c.harness,
		"close",
		async (ctx: Parameters<typeof nativeClose>[0]) => {
			await nativeClose(ctx);
			order.push("native joined");
		},
	);
	const cleanup = NodeExecutionEnv.prototype.cleanup;
	const cleaned = t.mock.method(
		NodeExecutionEnv.prototype,
		"cleanup",
		async function (
			this: NodeExecutionEnv,
			ctx: Parameters<typeof cleanup>[0],
		) {
			assert.equal(order[0], "native joined");
			await assertChildrenStopped(pids);
			await assert.rejects(launch(), /already owned/);
			order.push("environment");
			await cleanup.call(this, ctx);
		},
	);
	const storeClose = FilesystemSessionStore.prototype.close;
	const released = t.mock.method(
		FilesystemSessionStore.prototype,
		"close",
		async function (this: FilesystemSessionStore) {
			order.push("lock released");
			await storeClose.call(this);
		},
	);
	const closing = server.close();
	await assert.rejects(
		connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] }),
		/closing|shutting down|closed/i,
	);
	await closing;
	await Promise.all(pending);
	assert.equal(closed.mock.callCount(), 1);
	assert.equal(cleaned.mock.callCount(), 3);
	assert.equal(released.mock.callCount(), 1);
	assert.deepEqual(order, [
		"native joined",
		"environment",
		"environment",
		"environment",
		"lock released",
	]);
	assert.equal(abort.mock.callCount(), 0);
	cleaned.mock.restore();
	released.mock.restore();
	const recovered = Promise.withResolvers<void>();
	let answers = 0;
	provider.setResponses(
		Array.from({ length: 3 }, () => (request) => {
			assert.equal(request.messages.at(-1)?.role, "toolResult");
			if (++answers === 3) recovered.resolve();
			return fauxAssistantMessage("continued after shutdown");
		}),
	);
	const next = await launch();
	t.after(() => next.close());
	await recovered.promise;
	assert.equal(answers, 3);
});

test("load during restart recovery replays before returning and hands off real tool results while B/C finish unattached", {
	timeout: 10000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const entered = Promise.withResolvers<void>();
	let count = 0;
	const provider = fauxProvider();
	provider.setResponses(
		Array.from({ length: 3 }, () => async (_request, options) => {
			if (++count === 3) entered.resolve();
			return await new Promise<never>((_resolve, reject) => {
				if (options?.signal?.aborted) return reject(new Error("close"));
				options?.signal?.addEventListener(
					"abort",
					() => reject(new Error("close")),
					{ once: true },
				);
			});
		}),
	);
	const models = createModels();
	models.setProvider(provider.provider);
	const launch = () =>
		Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{ instructionsPath: "", skillsDir: "" },
			f.sessions,
		);
	const first = await launch();
	const sessions = await Promise.all(
		Array.from({ length: 3 }, () => first.createSession(f.cwd)),
	);
	for (const [index, session] of sessions.entries())
		await session.conversation.submit(
			{ type: "input", content: `recovered-${index}` },
			context,
		);
	await entered.promise;
	await first.close();
	const recovering = Promise.withResolvers<void>();
	const execute = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	let started = 0;
	let completed = 0;
	provider.setResponses(
		Array.from({ length: 6 }, () => async (request) => {
			const user = request.messages.findLast(
				(message) => message.role === "user",
			);
			assert.ok(typeof user?.content === "string");
			if (request.messages.at(-1)?.role === "toolResult") {
				if (++completed === 3) finished.resolve();
				return fauxAssistantMessage(`answer-${user.content}`);
			}
			if (++started === 3) recovering.resolve();
			await execute.promise;
			return fauxAssistantMessage(
				fauxToolCall(
					"write",
					{ path: user.content, content: user.content },
					{ id: "same-recovered-tool" },
				),
				{ stopReason: "toolUse" },
			);
		}),
	);
	const next = await launch();
	t.after(() => next.close());
	await recovering.promise;
	const a = sessions[0];
	assert.ok(a);
	const attached = await next.loadSession(a.id, f.cwd);
	const adapter = new Adapter(attached);
	const replaying = Promise.withResolvers<void>();
	const replayRelease = Promise.withResolvers<void>();
	const updates: SessionUpdate[] = [];
	let returned = false;
	const loading = adapter
		.attach(async (update) => {
			updates.push(update);
			if (update.sessionUpdate === "user_message_chunk") {
				replaying.resolve();
				await replayRelease.promise;
			}
		}, true)
		.then(() => {
			returned = true;
		});
	t.after(async () => {
		execute.resolve();
		replayRelease.resolve();
		await loading;
		await adapter.close();
	});
	await replaying.promise;
	execute.resolve();
	await finished.promise;
	for (const sibling of sessions.slice(1)) {
		const conversation = await attached.harness.conversation(
			sibling.conversation.id,
			context,
		);
		assert.ok(conversation);
		await conversation.waitForIdle(context);
		assert.match(
			JSON.stringify((await conversation.context(context)).messages),
			/answer-recovered-/,
		);
	}
	assert.equal(returned, false, "replay delivery must precede successful load");
	for (const index of [0, 1, 2])
		assert.equal(
			await readFile(join(f.cwd, `recovered-${index}`), "utf8"),
			`recovered-${index}`,
		);
	replayRelease.resolve();
	await loading;
	await waitFor(() =>
		updates.some(
			(update) =>
				update.sessionUpdate === "agent_message_chunk" &&
				update.content.type === "text" &&
				update.content.text.includes("answer-recovered-0"),
		),
	);
	assert.equal(
		updates.filter((update) => update.sessionUpdate === "user_message_chunk")
			.length,
		1,
	);
	assert.equal(
		updates.filter((update) => update.sessionUpdate === "tool_call").length,
		1,
	);
	assert.equal(
		updates.filter(
			(update) =>
				update.sessionUpdate === "tool_call_update" &&
				update.status === "completed",
		).length,
		1,
	);
	const text = updates
		.flatMap((update) =>
			update.sessionUpdate === "agent_message_chunk" &&
			update.content.type === "text"
				? [update.content.text]
				: [],
		)
		.join("");
	assert.equal(text, "answer-recovered-0");
	assert.doesNotMatch(JSON.stringify(updates), /recovered-[12]/);
});

test("startup drains persisted queued inputs for three conversations without client activation", {
	timeout: 10000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const entered = Promise.withResolvers<void>();
	let calls = 0;
	const provider = fauxProvider();
	provider.setResponses(
		Array.from({ length: 3 }, () => async (_request, options) => {
			if (++calls === 3) entered.resolve();
			return await new Promise<never>((_resolve, reject) => {
				if (options?.signal?.aborted) return reject(new Error("closed"));
				options?.signal?.addEventListener(
					"abort",
					() => reject(new Error("closed")),
					{ once: true },
				);
			});
		}),
	);
	const models = createModels();
	models.setProvider(provider.provider);
	const launch = () =>
		Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{ instructionsPath: "", skillsDir: "" },
			f.sessions,
		);
	const seed = await launch();
	const sessions = await Promise.all(
		Array.from({ length: 3 }, () => seed.createSession(f.cwd)),
	);
	for (const session of sessions)
		await session.conversation.submit(
			{ type: "input", content: `initial-${session.id}` },
			context,
		);
	await entered.promise;
	const queued: Submission[] = [];
	for (const session of sessions)
		queued.push(
			await session.conversation.submit(
				{ type: "input", content: `queued-${session.id}` },
				context,
			),
		);
	await seed.close();
	const recovered = Promise.withResolvers<void>();
	const seen: string[] = [];
	provider.setResponses(
		Array.from({ length: 6 }, () => (request) => {
			const user = request.messages.findLast((m) => m.role === "user");
			assert.equal(typeof user?.content, "string");
			seen.push(user?.content as string);
			if (seen.length === 6) recovered.resolve();
			return fauxAssistantMessage("native continuation");
		}),
	);
	const open = Harness.open;
	let native: Harness | undefined;
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		native = await open(...args);
		return native;
	});
	const runtime = await launch();
	t.after(() => runtime.close());
	await recovered.promise;
	assert.ok(native);
	for (const [index, session] of sessions.entries()) {
		assert.ok(
			seen.indexOf(`initial-${session.id}`) <
				seen.indexOf(`queued-${session.id}`),
		);
		assert.equal(
			seen.filter((text) => text === `queued-${session.id}`).length,
			1,
		);
		const queuedSubmission = queued[index];
		assert.ok(queuedSubmission);
		const receipt = await native.submission(queuedSubmission.id, context);
		assert.ok(receipt);
		assert.equal((await receipt.wait(context)).status, "done");
	}
});

test("startup wakes a due sleep with blocked and restart-limited siblings, before any attachment", {
	timeout: 10000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const woke = Promise.withResolvers<void>();
	const requests: string[] = [];
	const provider = fauxProvider();
	provider.setResponses(
		Array.from({ length: 4 }, () => (request) => {
			const user = request.messages.findLast((m) => m.role === "user");
			assert.equal(typeof user?.content, "string");
			requests.push(user?.content as string);
			return fauxAssistantMessage(`answer ${user?.content}`);
		}),
	);
	const models = createModels();
	models.setProvider(provider.provider);
	const sleeper = defineTask({
		name: "test.due-sleep",
		version: 1,
		initial: () => ({ phase: "wake" as const }),
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				ctx,
			);
		},
		phases: {
			wake: async (_task, runtime, ctx) => {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "completed", result: {} },
					}),
					ctx,
				);
				woke.resolve();
			},
		},
	});
	const missing = defineTask({ ...sleeper.definition, name: "test.missing" });
	const limited = defineTask({
		name: "pi.generation",
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
				throw new Error("seed must not execute");
			},
		},
	});
	const open = Harness.open;
	let native: Harness | undefined;
	let opening = 0;
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		(args[1].registry as Registry).install(
			defineExtension({ name: "sleep-probe", tasks: [sleeper] }),
		);
		native = await open(...args);
		if (++opening === 1) t.mock.method(native, "resume", () => {});
		return native;
	});
	const launch = () =>
		Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{ instructionsPath: "", skillsDir: "" },
			f.sessions,
		);
	const seed = await launch();
	const [a, b, c, d] = await Promise.all(
		Array.from({ length: 4 }, () => seed.createSession(f.cwd)),
	);
	assert.ok(a && b && c && d);
	const sleepId = await b.conversation.commit(
		(tx) => tx.createTask(sleeper, {}, { ownership: { kind: "conversation" } }),
		context,
	);
	const missingId = await c.conversation.commit(
		(tx) => tx.createTask(missing, {}, { ownership: { kind: "conversation" } }),
		context,
	);
	const limitedId = await d.conversation.commit(
		(tx) => tx.createTask(limited, {}, { ownership: { kind: "conversation" } }),
		context,
	);
	assert.equal((await a.harness.inspect(context)).scheduling, "paused");
	assert.deepEqual(requests, []);
	await seed.close();
	await f.edit(async (storage) => {
		const sleep = await storage.task(sleepId, context);
		const limit = await storage.task(limitedId, context);
		assert.ok(sleep && limit);
		await commitWrites(
			storage,
			[
				{
					type: "task",
					value: {
						...sleep,
						state: {
							status: "sleeping",
							until: Date.now() - 1000,
							checkpoint: { phase: "wake" },
						},
					},
				},
				{ type: "task", value: { ...limit, restarts: 5 } },
			],
			context,
		);
	});
	const runtime = await launch();
	t.after(() => runtime.close());
	// Neither waitForIdle, load, submit nor abort is allowed to activate this proof.
	await woke.promise;
	assert.deepEqual(requests, []);
	assert.ok(native);
	assert.equal(
		(await native.getTask(sleepId, context))?.state.status,
		"terminal",
	);
	const limitedConversation = await native.conversation(
		d.conversation.id,
		context,
	);
	assert.ok(limitedConversation);
	await limitedConversation.waitForIdle(context);
	assert.match(
		JSON.stringify(await native.getTask(limitedId, context)),
		/restart_limit/,
	);
	assert.ok(
		(await native.inspect(context)).tasks.some(
			(task) => task.record.id === missingId && task.state.kind === "blocked",
		),
	);
	const blocked = new Adapter(await runtime.loadSession(c.id, f.cwd));
	await blocked.attach(async () => {});
	await assert.rejects(
		blocked.prompt(c.id, "must-not-queue"),
		/Saved work is blocked/,
	);
	await assert.rejects(
		blocked.steer(c.id, "must-not-steer"),
		/Saved work is blocked/,
	);
	const savedBlocked = await native.conversation(c.conversation.id, context);
	assert.ok(savedBlocked);
	assert.equal((await savedBlocked.context(context)).messages.length, 0);
	const healthy = new Adapter(await runtime.loadSession(a.id, f.cwd));
	await healthy.attach(async () => {});
	assert.deepEqual(await healthy.steer(a.id, "idle sibling"), {
		outcome: "promptRequired",
		reason: "noRunningTurn",
	});
	assert.equal(
		(await healthy.prompt(a.id, "healthy-followup")).stopReason,
		"end_turn",
	);
	assert.equal(runtime.failed, false);
	await Promise.all([blocked.close(), healthy.close()]);
});
