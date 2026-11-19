import { readText, readStatus, readToolId } from "./helpers/updates.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startClient } from "./helpers/client.ts";

test("ACP stdio streams text, real bash cwd/output, and ordered terminal updates", {
	timeout: 15000,
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pid-acp-integration-"));
	const client = await startClient({ cwd });
	try {
		assert.equal(client.initialize.agentCapabilities?.loadSession, false);
		assert.equal(
			client.initialize.agentCapabilities?.mcpCapabilities?.http,
			false,
		);
		assert.equal((await client.prompt("hello")).stopReason, "end_turn");
		await client.waitForAnswer(
			(text) =>
				text === "A streamed answer with several distinct committed chunks.",
		);
		const chunks = client.updates.filter(
			(update) => update.sessionUpdate === "agent_message_chunk",
		);
		assert.ok(chunks.length > 1);
		const firstId = chunks[0]?.messageId;
		assert.ok(typeof firstId === "string" && firstId.length > 0);
		assert.ok(chunks.every((chunk) => chunk.messageId === firstId));
		assert.equal(
			chunks.map((chunk) => readText(chunk)).join(""),
			"A streamed answer with several distinct committed chunks.",
		);
		client.updates.length = 0;
		assert.equal((await client.prompt("Run pwd")).stopReason, "end_turn");
		await client.waitForAnswer((text) => text.includes(cwd));
		const start = client.updates.findIndex(
			(update) => update.sessionUpdate === "tool_call",
		);
		const terminal = client.updates.findIndex(
			(update) => readStatus(update) === "completed",
		);
		assert.ok(start >= 0 && terminal > start);
		const beforeTool = client.updates
			.slice(0, start)
			.filter((update) => update.sessionUpdate === "agent_message_chunk");
		const afterTool = client.updates
			.slice(terminal + 1)
			.filter((update) => update.sessionUpdate === "agent_message_chunk");
		const beforeId = beforeTool[0]?.messageId;
		const afterId = afterTool[0]?.messageId;
		assert.ok(typeof beforeId === "string" && beforeId.length > 0);
		assert.ok(typeof afterId === "string" && afterId.length > 0);
		assert.ok(beforeTool.every((chunk) => chunk.messageId === beforeId));
		assert.ok(afterTool.every((chunk) => chunk.messageId === afterId));
		assert.equal(new Set([firstId, beforeId, afterId]).size, 3);
		assert.ok(
			client.updates
				.filter(
					(update) =>
						update.sessionUpdate === "tool_call" ||
						update.sessionUpdate === "tool_call_update",
				)
				.every((update) => !("messageId" in update)),
		);
		assert.equal(
			readToolId(client.updates[start]),
			readToolId(client.updates[terminal]),
		);
		assert.ok(JSON.stringify(client.updates[terminal]).includes(cwd));
		assert.ok(
			client.updates
				.slice(terminal + 1)
				.filter((update) => update.sessionUpdate === "agent_message_chunk")
				.map((update) => readText(update))
				.join("")
				.includes(cwd),
		);
		const resultIndex = client.wire.findLastIndex(
			(message) => message.result?.stopReason === "end_turn",
		);
		const toolIndex = client.wire.findLastIndex(
			(message) =>
				(message.params?.update && readStatus(message.params.update)) ===
				"completed",
		);
		assert.ok(toolIndex >= 0 && resultIndex >= 0);
		assert.ok(
			client.wire.findIndex(
				(m) => m.params?.update?.sessionUpdate === "tool_call",
			) < toolIndex,
		);
		assert.equal(client.stderr, "");
	} finally {
		await client.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
