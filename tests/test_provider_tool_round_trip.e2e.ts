import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startClient } from "./helpers/client.ts";
import { once } from "node:events";
import { readText, readStatus, readToolId } from "./helpers/updates.ts";

test("production executable uses configured OpenAI-compatible HTTP provider over ACP stdio", {
	timeout: 15000,
}, async () => {
	const { createServer } = await import("node:http");
	const requests = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const data of req) body += data;
		const parsed = JSON.parse(body) as {
			model: string;
			tools: {
				function: {
					name: string;
					parameters: {
						properties: Record<string, unknown>;
						required: string[];
					};
				};
			}[];
			messages: { role: string; content: string }[];
		};
		requests.push(parsed);
		assert.equal(req.headers.authorization, "Bearer fake-key");
		assert.equal(parsed.model, "scripted-http");
		assert.deepEqual(
			parsed.tools.map((tool) => tool.function.name),
			["bash", "read", "edit", "write", "codemode"],
		);
		for (const [index, required] of [
			[0, ["command"]],
			[1, ["path"]],
			[2, ["path", "edits"]],
			[3, ["path", "content"]],
			[4, ["code"]],
		] as const) {
			const schema = parsed.tools[index]?.function.parameters;
			assert.ok(schema);
			assert.deepEqual(schema.required, required);
			for (const key of required) assert.ok(key in schema.properties);
		}
		assert.ok(!parsed.messages.some((message) => message.role === "developer"));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const send = (delta: Record<string, unknown>) =>
			res.write(
				`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "scripted-http", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
			);
		const last = parsed.messages.at(-1);
		assert.ok(last);
		if (last.role === "tool") {
			assert.ok(last.content.includes(cwd));
			for (const text of ["The directory is ", cwd, "."]) {
				send({ content: text });
				await new Promise((resolve) => setTimeout(resolve, 40));
			}
		} else
			send({
				tool_calls: [
					{
						index: 0,
						id: "http-bash",
						type: "function",
						function: { name: "bash", arguments: '{"command":"pwd"}' },
					},
				],
			});
		res.write(
			`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: last.role === "tool" ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
		);
		res.end();
	});
	const cwd = await mkdtemp(join(tmpdir(), "pid-acp-http-"));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	let client: Awaited<ReturnType<typeof startClient>> | undefined;
	try {
		client = await startClient({
			live: true,
			cwd,
			env: {
				PID_ACP_PROVIDERS: resolve("tests/helpers/llama-qwen.ts"),
				PID_ACP_THINKING: "off",
				PID_ACP_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
				PID_ACP_MODEL: "scripted-http",
				PID_ACP_API_KEY: "fake-key",
			},
		});
		assert.equal((await client.prompt("Run pwd")).stopReason, "end_turn");
		await client.waitForAnswer((text) => text === `The directory is ${cwd}.`);
		assert.equal(requests.length, 2);
		const chunks = client.updates.filter(
			(update) => update.sessionUpdate === "agent_message_chunk",
		);
		assert.ok(chunks.length > 1);
		assert.equal(
			chunks.map((update) => readText(update)).join(""),
			`The directory is ${cwd}.`,
		);
		assert.ok(
			client.updates.some(
				(update) =>
					readToolId(update) === "http-bash" &&
					readStatus(update) === "completed",
			),
		);
		assert.equal(client.stderr, "");
	} finally {
		await client?.close();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(cwd, { recursive: true, force: true });
	}
});
