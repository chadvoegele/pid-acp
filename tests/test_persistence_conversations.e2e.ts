import type { SessionUpdate } from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { persistenceFixture } from "./helpers/persistence.ts";
import { waitFor } from "./helpers/client.ts";
import { readText, readToolId } from "./helpers/updates.ts";

test("scripted HTTP provider sees prior user, answer and real tool results exactly once after JSONL restart", {
	timeout: 20000,
}, async (t) => {
	const f = await persistenceFixture(t);
	type Request = {
		messages: { role: string; content: string; tool_calls?: unknown[] }[];
	};
	const requests: Request[] = [];
	const endpoint = createServer(async (req, res) => {
		let body = "";
		for await (const part of req) body += part;
		const request = JSON.parse(body) as Request;
		requests.push(request);
		const last = request.messages.at(-1);
		const tools =
			last?.role === "user" && last.content === "initial HTTP prompt";
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const delta = tools
			? {
					tool_calls: [
						{
							index: 0,
							id: "http-write",
							type: "function",
							function: {
								name: "write",
								arguments: JSON.stringify({
									path: "http-file",
									content: "HTTP_NATIVE_FILE",
								}),
							},
						},
						{
							index: 1,
							id: "http-bash",
							type: "function",
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "printf HTTP_NATIVE_BASH",
								}),
							},
						},
					],
				}
			: {
					content:
						last?.role === "tool"
							? "HTTP saved answer."
							: "HTTP continued answer.",
				};
		res.end(
			`data: ${JSON.stringify({ id: "persistence", object: "chat.completion.chunk", model: "scripted-http", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "persistence", choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	endpoint.listen(0, "127.0.0.1");
	await once(endpoint, "listening");
	t.after(async () => {
		endpoint.closeAllConnections();
		await new Promise<void>((resolve) => endpoint.close(() => resolve()));
	});
	const address = endpoint.address();
	assert.ok(address && typeof address !== "string");
	const env = {
		PID_ACP_PROVIDERS: resolve("tests/helpers/llama-qwen.ts"),
		PID_ACP_MODEL: "scripted-http",
		PID_ACP_API_KEY: "fake-key",
		PID_ACP_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
	};
	const first = await f.client(env);
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await first.prompt("initial HTTP prompt", sessionId);
	assert.equal(requests.length, 2);
	assert.equal(
		await readFile(join(f.cwd, "http-file"), "utf8"),
		"HTTP_NATIVE_FILE",
	);
	await first.close();
	const next = await f.client(env);
	await next.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.equal(requests.length, 2, "Load must not call the model");
	assert.ok(
		next.updates.some((update) => update.sessionUpdate === "tool_call"),
	);
	await next.prompt("continue HTTP prompt", sessionId);
	assert.equal(requests.length, 3);
	const messages = requests[2]?.messages;
	assert.ok(messages);
	assert.equal(
		messages.filter(
			(message) =>
				message.role === "user" && message.content === "initial HTTP prompt",
		).length,
		1,
	);
	assert.equal(
		messages.filter(
			(message) =>
				message.role === "assistant" &&
				message.content === "HTTP saved answer.",
		).length,
		1,
	);
	assert.equal(messages.filter((message) => message.role === "tool").length, 2);
	assert.equal(
		messages.filter(
			(message) =>
				message.role === "tool" && message.content.includes("HTTP_NATIVE_BASH"),
		).length,
		1,
	);
	assert.equal(next.stderr, "");
});

test("Matrix-style client suppresses every load update and forwards only fresh prompt output", {
	timeout: 15000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const first = await f.client();
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await first.prompt("saved chat", sessionId);
	await first.prompt(
		JSON.stringify({
			name: "bash",
			args: { command: "printf effect >> effects" },
		}),
		sessionId,
	);
	await first.close();
	const loadingSessions = new Set<string>();
	const chat: SessionUpdate[] = [];
	const next = await f.client({}, (id, update) => {
		if (loadingSessions.has(id)) return;
		chat.push(update);
	});
	loadingSessions.add(sessionId);
	try {
		await next.request("session/load", {
			sessionId,
			cwd: f.cwd,
			mcpServers: [],
		});
	} finally {
		loadingSessions.delete(sessionId);
	}
	for (const kind of [
		"user_message_chunk",
		"agent_message_chunk",
		"agent_thought_chunk",
		"tool_call",
		"tool_call_update",
	])
		assert.ok(next.updates.some((update) => update.sessionUpdate === kind));
	assert.deepEqual(chat, []);
	const start = next.updates.length;
	await next.prompt("fresh chat", sessionId);
	await next.waitForAnswer((text) => text === "Answer: fresh chat", start);
	assert.deepEqual(chat, next.updates.slice(start));
	assert.equal(chat.map(readText).join(""), "Answer: fresh chat");
	assert.ok(chat.every((update) => readToolId(update) === undefined));
	assert.equal(await readFile(join(f.cwd, "effects"), "utf8"), "effect");
});

test("production ACP runs independent sessions concurrently and cancel leaves its sibling usable", {
	timeout: 15000,
}, async (t) => {
	const { existsSync } = await import("node:fs");
	const f = await persistenceFixture(t);
	const updates: { sessionId: string; update: SessionUpdate }[] = [];
	const host = await f.client({}, (sessionId, update) => {
		updates.push({ sessionId, update });
	});
	const [a, b] = await Promise.all([
		host.request("session/new", { cwd: f.cwd, mcpServers: [] }),
		host.request("session/new", { cwd: f.cwd, mcpServers: [] }),
	]);
	const pending = host.prompt(
		JSON.stringify({
			name: "bash",
			args: { command: "echo $$ > a.pid; sleep 60" },
		}),
		a.sessionId,
	);
	await waitFor(() => existsSync(join(f.cwd, "a.pid")));
	assert.equal(
		(
			await host.prompt(
				JSON.stringify({
					name: "bash",
					args: { command: "printf B > b.txt; cat b.txt" },
				}),
				b.sessionId,
			)
		).stopReason,
		"end_turn",
	);
	await host.cancel(a.sessionId);
	assert.equal((await pending).stopReason, "cancelled");
	assert.equal(
		(await host.prompt("B again", b.sessionId)).stopReason,
		"end_turn",
	);
	assert.equal(
		(await host.prompt("A again", a.sessionId)).stopReason,
		"end_turn",
	);
	assert.equal(await readFile(join(f.cwd, "b.txt"), "utf8"), "B");
	for (const id of [a.sessionId, b.sessionId]) {
		const own = updates
			.filter((item) => item.sessionId === id)
			.map((item) => item.update);
		const calls = own.filter((update) => update.sessionUpdate === "tool_call");
		assert.equal(calls.length, 1);
		assert.equal(
			own.filter(
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					(update.status === "completed" || update.status === "failed"),
			).length,
			1,
		);
	}
	await host.close();
	const next = await f.client();
	await Promise.all([
		next.request("session/load", {
			sessionId: a.sessionId,
			cwd: f.cwd,
			mcpServers: [],
		}),
		next.request("session/load", {
			sessionId: b.sessionId,
			cwd: f.cwd,
			mcpServers: [],
		}),
	]);
	assert.equal(
		(await next.prompt("context", b.sessionId)).stopReason,
		"end_turn",
	);
});
