import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { compile } from "@earendil-works/pi-schema";
import {
	convertMcpResult,
	describeMcpTool,
	MCP_ENVELOPE_SCHEMA,
} from "../dist/mcp-tools.js";

for (const value of [null, [1, "two"], { _meta: { application: true } }]) {
	test(`structured MCP result preserves ${JSON.stringify(value)} and removes only protocol metadata`, async () => {
		const result = await convertMcpResult({
			content: [],
			structuredContent: value,
			_meta: { secret: "protocol" },
		});
		assert.deepEqual(result.structuredOutput, {
			content: [],
			structuredContent: value,
		});
		assert.deepEqual(result.output, [
			{ type: "text", text: JSON.stringify(value, null, 2) },
		]);
		assert.ok(compile(MCP_ENVELOPE_SCHEMA).check(result.structuredOutput));
	});
}

test("MCP raw content survives while public presentation unwraps resources and replaces unsupported media", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () => {
		throw new Error("Resource links must never be fetched");
	});
	const raw: CallToolResult = {
		content: [
			{ type: "text", text: "text", _meta: { private: true } },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			{
				type: "resource",
				resource: {
					uri: "fixture:text",
					text: "embedded",
					_meta: { private: true },
				},
				_meta: { private: true },
			},
			{
				type: "resource",
				resource: {
					uri: "fixture:image",
					blob: "aW1hZ2U=",
					mimeType: "image/png",
				},
			},
			{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
			{
				type: "resource",
				resource: {
					uri: "fixture:binary",
					blob: "Ymlu",
					mimeType: "application/octet-stream",
				},
			},
			{
				type: "resource_link",
				uri: "https://never-fetch.invalid/",
				name: "link",
			},
		],
	};
	const result = await convertMcpResult(raw);
	assert.doesNotMatch(JSON.stringify(result.structuredOutput), /_meta|private/);
	assert.match(JSON.stringify(result.structuredOutput), /audio|resource_link/);
	assert.match(JSON.stringify(result.output), /embedded|audio|binary|link/);
	assert.equal(
		result.output?.filter((block) => block.type === "image").length,
		2,
	);
	assert.equal(fetch.mock.callCount(), 0);
	assert.ok(
		raw.content[0]?._meta,
		"conversion does not mutate the server result",
	);
});

test("structured and empty errors remain unchanged valid envelopes", async () => {
	const structured = await convertMcpResult({
		content: [],
		structuredContent: { why: "fixture" },
		isError: true,
	});
	assert.equal(structured.isError, true);
	assert.deepEqual(structured.structuredOutput, {
		content: [],
		structuredContent: { why: "fixture" },
		isError: true,
	});
	const empty = await convertMcpResult({ content: [], isError: true });
	assert.equal(empty.isError, true);
	assert.deepEqual(empty.structuredOutput, { content: [], isError: true });
});

test("presentation is bounded independently of the complete structured envelope", async () => {
	const text = "x".repeat(100_000);
	const result = await convertMcpResult({ content: [{ type: "text", text }] });
	assert.deepEqual(result.structuredOutput, {
		content: [{ type: "text", text }],
	});
	assert.ok(JSON.stringify(result.output).length < text.length);
});

for (const result of [
	{ content: [{ type: "text", text: 1 }] },
	{ content: [{ type: "unknown" }] },
	{ content: [{ type: "resource", resource: { uri: "fixture" } }] },
	{ content: [], isError: "true" },
]) {
	test(`malformed wire MCP result rejects: ${String(result.isError ?? "content")}`, async () => {
		await assert.rejects(convertMcpResult(result as unknown as CallToolResult));
	});
}

test("input normalization preserves definitions, local references and constraints", () => {
	const descriptor = describeMcpTool({
		name: "bounded",
		inputSchema: {
			$defs: { value: { type: "integer", minimum: 3 } },
			properties: { value: { $ref: "#/$defs/value" } },
			required: ["value"],
			additionalProperties: false,
		},
		outputSchema: { type: "array" },
	});
	const validator = compile(descriptor.parameters);
	assert.ok(validator.check({ value: 3 }));
	assert.equal(validator.check({ value: 2 }), false);
	assert.equal(validator.check({ value: "3" }), false);
	assert.equal(validator.check({ value: 3, extra: true }), false);
	assert.match(descriptor.description, /documentation only.*array/);
	assert.match(descriptor.description, /check isError/);
	assert.deepEqual((descriptor.parameters as { $defs: object }).$defs, {
		value: { type: "integer", minimum: 3 },
	});
});

for (const inputSchema of [
	{ type: "array" },
	{
		type: "object",
		properties: { remote: { $ref: "https://never-fetch.invalid/schema" } },
	},
	{ type: "object", properties: { missing: { $ref: "#/$defs/missing" } } },
	{ type: "object", properties: { value: { pattern: "[" } } },
]) {
	test(`unsupported schema rejects before registration: ${JSON.stringify(inputSchema)}`, () => {
		assert.throws(() => describeMcpTool({ name: "invalid", inputSchema }));
	});
}
