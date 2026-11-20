import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { client, type SessionUpdate } from "@agentclientprotocol/sdk";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AcpServerFixture } from "./helpers/acp-server-fixture.ts";
import { Runtime } from "../dist/runtime.js";
import type { Session } from "../dist/session.js";

const steering = (sessionId: string, text: string, metadata = false) => ({
	sessionId,
	prompt: [{ type: "text", text }],
	...(metadata
		? { _meta: { steering: { idleBehavior: "promptRequired" } } }
		: {}),
});

test("ACP steering dispatch validates requests and idle never creates input or a turn", {
	timeout: 5000,
}, async (t) => {
	const provider = fauxProvider();
	let calls = 0;
	provider.setResponses([
		async (request) => {
			calls++;
			assert.equal(request.messages.at(-1)?.content, "normal\nsecond block");
			return fauxAssistantMessage("normal answer");
		},
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	const runtime = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
	);
	let session: Session | undefined;
	const createSession = runtime.createSession.bind(runtime);
	t.mock.method(
		runtime,
		"createSession",
		async (...args: Parameters<typeof createSession>) => {
			session = await createSession(...args);
			return session;
		},
	);
	const server = new AcpServerFixture(runtime);
	const connection = client().connect(server.createApp());
	t.after(async () => {
		connection.close();
		await server.close();
	});
	const agent = connection.agent;
	const init = await agent.request("initialize", {
		protocolVersion: 1,
		clientInfo: { name: "test", version: "1" },
		clientCapabilities: {},
	});
	assert.deepEqual(init._meta?.steering, { supported: true });
	const { sessionId } = await agent.request("session/new", {
		cwd: tmpdir(),
		mcpServers: [],
	});
	const request = (params: unknown) =>
		agent.request("_session/steering", params);
	for (const params of [
		undefined,
		{},
		{ sessionId: "", prompt: [{ type: "text", text: "a" }] },
		{ sessionId },
		{ sessionId, prompt: [] },
		{ sessionId, prompt: [{ type: "text", text: "  " }] },
		{ sessionId, prompt: [{ type: "text", text: "" }] },
		{
			sessionId,
			prompt: [
				{ type: "text", text: "ok" },
				{ type: "text", text: " " },
				{ type: "image" },
			],
		},
		{ sessionId, prompt: [{ type: "image", data: "x" }] },
		{ sessionId, prompt: [{ type: "text", text: 42 }] },
		{
			...steering(sessionId, "a"),
			_meta: { steering: { idleBehavior: "startedNewTurn" } },
		},
	])
		await assert.rejects(request(params), (error: Error) =>
			/-32602|invalid params|requires|supported/i.test(error.message),
		);
	for (const prompt of [
		undefined,
		[],
		[{ type: "text", text: "" }],
		[{ type: "text", text: "  " }],
		[{ type: "image", data: "x" }],
		[{ type: "text", text: 42 }],
		[
			{ type: "text", text: "ok" },
			{ type: "image", data: "x" },
		],
	])
		await assert.rejects(
			agent.request("session/prompt", { sessionId, prompt }),
			/text|invalid params/i,
		);
	await assert.rejects(request(steering("unknown", "a")), /Unknown session/);
	await assert.rejects(
		agent.request("_steer", steering(sessionId, "a")),
		/method|not found/i,
	);
	assert.ok(session);
	const before = (await session.conversation.context(context)).entries.length;
	for (const params of [
		steering(sessionId, "idle"),
		steering(sessionId, "idle meta", true),
	])
		assert.deepEqual(await request(params), {
			outcome: "promptRequired",
			reason: "noRunningTurn",
		});
	assert.equal(
		(await session.conversation.context(context)).entries.length,
		before,
	);
	assert.equal(calls, 0);
	assert.deepEqual(
		await agent.request("session/prompt", {
			sessionId,
			prompt: [
				{ type: "text", text: "normal" },
				{ type: "text", text: "second block" },
			],
		}),
		{ stopReason: "end_turn" },
	);
	assert.equal(calls, 1);
});

test("steering a running ACP turn returns before generation and uses the ordinary watch", {
	timeout: 8000,
}, async (t) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const next = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const provider = fauxProvider();
	provider.setResponses([
		async () => {
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage(
				fauxToolCall("bash", { command: "printf ok" }, { id: "steer-tool" }),
				{ stopReason: "toolUse" },
			);
		},
		async (request) => {
			assert.ok(
				request.messages.some(
					(message) =>
						message.role === "user" &&
						message.content === "steer now\nsecond block",
				),
			);
			next.resolve();
			return fauxAssistantMessage("steered answer");
		},
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	const runtime = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
	);
	let session: Session | undefined;
	const createSession = runtime.createSession.bind(runtime);
	t.mock.method(
		runtime,
		"createSession",
		async (...args: Parameters<typeof createSession>) => {
			session = await createSession(...args);
			return session;
		},
	);
	const server = new AcpServerFixture(runtime);
	const updates: SessionUpdate[] = [];
	const connection = client()
		.onNotification("session/update", ({ params }) => {
			updates.push(params.update);
		})
		.connect(server.createApp());
	t.after(async () => {
		release.resolve();
		connection.close();
		await server.close();
	});
	const agent = connection.agent;
	const { sessionId } = await agent.request("session/new", {
		cwd: tmpdir(),
		mcpServers: [],
	});
	const original = agent.request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: "start" }],
	});
	await entered.promise;
	assert.deepEqual(
		await agent.request("_session/steering", {
			...steering(sessionId, "steer now", true),
			prompt: [
				{ type: "text", text: "steer now" },
				{ type: "text", text: "second block" },
			],
		}),
		{ outcome: "injected" },
	);
	let finished = false;
	void original.then(() => {
		finished = true;
	});
	assert.equal(finished, false);
	release.resolve();
	await next.promise;
	assert.deepEqual(await original, { stopReason: "end_turn" });
	assert.ok(session);
	const messages = (await session.conversation.context(context)).messages;
	assert.equal(
		messages.filter(
			(m) => m.role === "user" && m.content === "steer now\nsecond block",
		).length,
		1,
	);
	// Watch output may follow the prompt response; observe it independently.
	for (
		let i = 0;
		i < 50 &&
		!updates.some(
			(u) =>
				u.sessionUpdate === "user_message_chunk" &&
				u.content.type === "text" &&
				u.content.text === "steer now\nsecond block",
		);
		i++
	)
		await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(
		updates.filter(
			(u) =>
				u.sessionUpdate === "user_message_chunk" &&
				u.content.type === "text" &&
				u.content.text === "steer now\nsecond block",
		).length,
		1,
	);
	assert.deepEqual(
		await agent.request(
			"_session/steering",
			steering(sessionId, "after completion"),
		),
		{ outcome: "promptRequired", reason: "noRunningTurn" },
	);
});

test("steering admission and cancellation are ordered without waiting for generation", {
	timeout: 8000,
}, async (t) => {
	const entered = Promise.withResolvers<void>();
	const provider = fauxProvider();
	provider.setResponses([
		async (_request, options) => {
			entered.resolve();
			await new Promise<void>((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
			throw new Error("aborted");
		},
		fauxAssistantMessage("later turn"),
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	const runtime = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
	);
	const server = new AcpServerFixture(runtime);
	const connection = client().connect(server.createApp());
	t.after(async () => {
		connection.close();
		await server.close();
	});
	const agent = connection.agent;
	const { sessionId } = await agent.request("session/new", {
		cwd: tmpdir(),
		mcpServers: [],
	});
	const prompt = (text: string) =>
		agent.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text }],
		});
	const original = prompt("start");
	await entered.promise;
	assert.deepEqual(
		await agent.request(
			"_session/steering",
			steering(sessionId, "accepted before cancel"),
		),
		{ outcome: "injected" },
	);
	await agent.notify("session/cancel", { sessionId });
	assert.deepEqual(await original, { stopReason: "cancelled" });
	// Native abort may discard accepted steering; it must not lock out future turns.
	assert.deepEqual(
		await agent.request("_session/steering", steering(sessionId, "idle again")),
		{ outcome: "promptRequired", reason: "noRunningTurn" },
	);
	assert.deepEqual(await prompt("later"), { stopReason: "end_turn" });
});
