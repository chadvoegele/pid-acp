import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startClient } from "./helpers/client.ts";
import { readText } from "./helpers/updates.ts";

for (const [level, effort] of [
	["off", "none"],
	["minimal", "low"],
	["low", "low"],
	["medium", "medium"],
	["high", "xhigh"],
	["xhigh", "xhigh"],
	["max", "xhigh"],
]) {
	const thinking = level !== "off";
	test(`production thinking=${level} configures Qwen and separates ACP thoughts`, {
		timeout: 15000,
	}, async () => {
		const requests: {
			chat_template_kwargs: { enable_thinking: boolean };
			reasoning_effort: string;
		}[] = [];
		const server = createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			requests.push(JSON.parse(body));
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			const send = (
				delta: Record<string, unknown>,
				finish_reason: string | null = null,
			) =>
				res.write(
					`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
				);
			if (thinking) {
				send({ reasoning_content: "Consider " });
				await new Promise((resolve) => setTimeout(resolve, 60));
				send({ reasoning_content: "the question." });
			}
			send({ content: "42" });
			send({}, "stop");
			res.end("data: [DONE]\n\n");
		});
		const cwd = await mkdtemp(join(tmpdir(), "pid-thinking-"));
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
					PID_ACP_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
					PID_ACP_MODEL: "scripted-qwen",
					PID_ACP_API_KEY: "fake-key",
					PID_ACP_THINKING: level,
				},
			});
			assert.equal(
				(await client.prompt("What is the answer?")).stopReason,
				"end_turn",
			);
			await client.waitForAnswer((text) => text === "42");
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.chat_template_kwargs.enable_thinking, thinking);
			assert.equal(requests[0]?.reasoning_effort, effort);
			assert.equal(client.updates.map(readText).join(""), "42");
			const thoughts = client.updates.filter(
				(u) => u.sessionUpdate === "agent_thought_chunk",
			);
			assert.equal(
				thoughts
					.map((u) => (u.content.type === "text" ? u.content.text : ""))
					.join(""),
				thinking ? "Consider the question." : "",
			);
			if (thinking) {
				assert.ok(thoughts.length > 1);
				assert.equal(new Set(thoughts.map((u) => u.messageId)).size, 1);
				assert.equal(
					client.updates.find((u) => u.sessionUpdate !== "user_message_chunk")
						?.sessionUpdate,
					"agent_thought_chunk",
				);
			}
			assert.equal(client.stderr, "");
		} finally {
			await client?.close();
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			await rm(cwd, { recursive: true, force: true });
		}
	});
}
