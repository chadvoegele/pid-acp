import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { summarizeLiveUpdates } from "./helpers/live-diagnostics.ts";

test("live fixture diagnostics redact keys across answer chunks and replace fixture paths", () => {
	const previous = process.env.PID_ACP_API_KEY;
	process.env.PID_ACP_API_KEY = "synthetic-api-key";
	try {
		const updates: SessionUpdate[] = [
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "synthetic-api-" },
			},
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "key /tmp/fixture/result" },
			},
			{
				sessionUpdate: "user_message_chunk",
				content: { type: "text", text: "synthetic-api-key" },
			},
			{
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "excluded thought" },
			},
			{
				sessionUpdate: "tool_call",
				toolCallId: "call",
				title: "write",
				rawInput: { path: "/tmp/fixture/result", content: "synthetic-api-key" },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call",
				status: "completed",
				rawOutput: "synthetic-api-key",
			},
		];
		const summary = summarizeLiveUpdates(updates, ["/tmp/fixture"]);
		assert.equal(summary.updateCount, updates.length);
		assert.equal(summary.answer, "<redacted> <fixture>/result");
		assert.deepEqual(summary.inputs, ["<redacted>"]);
		assert.equal(summary.tools.length, 2);
		const json = JSON.stringify(summary);
		for (const excluded of [
			"synthetic-api-key",
			"/tmp/fixture",
			"excluded thought",
		])
			assert.ok(!json.includes(excluded));
	} finally {
		if (previous === undefined) delete process.env.PID_ACP_API_KEY;
		else process.env.PID_ACP_API_KEY = previous;
	}
});

test("live fixture diagnostics bound text fields and tolerate absent tool data", () => {
	const summary = summarizeLiveUpdates([
		{
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "a".repeat(5000) },
		},
		{ sessionUpdate: "tool_call", toolCallId: "call", title: "bash" },
		{
			sessionUpdate: "tool_call_update",
			toolCallId: "call",
			status: "in_progress",
		},
	]);
	assert.equal(summary.answer.length, 4000);
	const call = summary.tools[0];
	const result = summary.tools[1];
	assert.ok(call && "input" in call);
	assert.ok(result && "output" in result);
	assert.equal(call.input, "");
	assert.equal(result.output, "");
});
