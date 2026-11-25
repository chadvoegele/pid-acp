import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { McpAdapter } from "../dist/mcp.js";

const id = 1 as ConversationId;

test("disabled MCP returns empty discovery and status without setup", async () => {
	const adapter = new McpAdapter({ servers: [] });
	assert.equal(adapter.enabled, false);
	assert.deepEqual(await adapter.discover("/unused"), {
		tools: [],
		namespaces: [],
	});
	assert.deepEqual(adapter.getStatus(id), []);
	await adapter.close();
});

test("configuration issues enable status guidance without creating clients", async () => {
	const adapter = new McpAdapter({
		servers: [
			{
				kind: "blocked",
				name: "fixture",
				issue: "missing environment variable",
			},
		],
	});
	assert.equal(adapter.enabled, true);
	assert.deepEqual(adapter.getStatus(id), [
		{
			name: "fixture",
			description: "",
			status: "missing environment variable",
		},
	]);
	assert.deepEqual(await adapter.discover("/unused"), {
		tools: [],
		namespaces: [],
	});
	await adapter.prepare(id, "/unused");
	assert.equal(
		adapter.getStatus(id)[0]?.status,
		"missing environment variable",
	);
	adapter.stopAdmission();
	await assert.rejects(adapter.prepare(id, "/unused"), /closing/);
	const closing = adapter.close();
	assert.equal(adapter.close(), closing);
	await closing;
});
