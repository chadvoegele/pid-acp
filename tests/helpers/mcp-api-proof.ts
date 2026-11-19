import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	Harness,
	createRegistry,
	defineExtension,
	defineTool,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	McpClient,
	createMcpToolName,
	mcpNamespace,
	normalizeMcpInputSchema,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";

const root = process.argv[2];
const phase = process.argv[3];
assert.ok(root && (phase === "seed" || phase === "recover"));
const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
const registry = createRegistry();
registry.install(
	defineExtension({ name: "coding", tools: [createWriteTool()] }),
);
registry.install(
	createCodemodeExtension({ sandbox, namespaces: [], models: false }),
);
const faux = fauxProvider();
faux.setResponses([
	fauxAssistantMessage(
		[
			fauxToolCall(
				"codemode",
				{
					code: `
text(await tools.mcp__fixture__value({}));
try { await tools.mcp__fixture__hold({}); } catch (e) { text(String(e)); }
try { await tools.mcp__fixture__value({}); } catch (e) { text(String(e)); }
await tools.write({ path: "recovered.txt", content: "recovered without attachment" });
`,
				},
				{ id: "proof-parent" },
			),
		],
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage("done"),
]);
if (phase === "recover") faux.setResponses([fauxAssistantMessage("recovered")]);
const models = createModels();
models.setProvider(faux.provider);
const env = new NodeExecutionEnv({ cwd: root });
const harness = await Harness.open(
	await openNodeJsonlStorage(join(root, "db"), context),
	{ models, registry, env: () => env, settings: { retry: { enabled: false } } },
	context,
);

assert.equal((await harness.inspect(context)).scheduling, "paused");
if (phase === "recover") {
	const saved = await harness.commit(
		(tx) => tx.scanConversations({}, 100),
		context,
	);
	assert.equal(saved.items.length, 1);
	assert.ok(saved.items[0]);
	const conversation = await harness.conversation(saved.items[0].id, context);
	assert.ok(conversation);
	assert.equal((await conversation.agent(context)).cwd, root);
}
const pair = createInMemoryTransportPair();
const client = new McpClient({ name: "api-proof", version: "1" });
const externalCalls: string[] = [];
pair.server.onMessage(async (message) => {
	if (!("method" in message) || !("id" in message)) return;
	let result: unknown;
	if (message.method === "initialize")
		result = {
			protocolVersion: "2025-11-25",
			capabilities: { tools: {} },
			serverInfo: { name: "fixture", version: "1" },
		};
	else if (message.method === "tools/list")
		result = {
			tools:
				phase === "seed"
					? ["value", "hold"].map((name) => ({
							name,
							inputSchema: { type: "object", properties: {} },
						}))
					: [],
		};
	else if (message.method === "tools/call") {
		const params = message.params as { name: string };
		externalCalls.push(params.name);
		if (params.name === "hold") {
			process.send?.({ kind: "intent", externalCalls });
			return;
		}
		result = {
			content: [],
			structuredContent: { token: "completed-before-crash" },
		};
	} else throw new Error("Unexpected fixture request");
	await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
});
await pair.server.start();
await client.connect(pair.client);
assert.ok(client.serverCapabilities?.tools);
const discovered = await client.listTools();
const tools: ToolRegistration[] = discovered.map((tool) =>
	defineTool({
		name: createMcpToolName("fixture", tool.name, () => false),
		description: "Fixture only",
		parameters: normalizeMcpInputSchema(tool.inputSchema),
		structuredOutputSchema: { type: "object", additionalProperties: true },
		callers: ["tools"],
		deferred: true,
		replay: "unsafe",
		async execute(args, _api, ctx) {
			const value = await client.callTool(
				tool.name,
				args as Record<string, unknown>,
				{ signal: ctx.abortSignal },
			);
			return {
				output: [],
				structuredOutput: JSON.parse(JSON.stringify(value)) as JsonValue,
			};
		},
	}),
);
registry.install(defineExtension({ name: "mcp", tools }));
// Public replacement supplies current namespace metadata without mutating an extension or replacing the sandbox.
const ns = mcpNamespace("fixture");
registry.install(
	createCodemodeExtension({
		sandbox,
		namespaces: discovered.length
			? [{ name: ns, prefix: `${ns}__`, description: "Fixture namespace" }]
			: [],
		models: false,
	}),
);
assert.equal(
	registry
		.snapshot()
		.tools()
		.filter(({ tool }) => tool.name === "codemode").length,
	1,
);
if (phase === "seed") {
	const conversation = await harness.root(context, {
		agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: root },
	});
	assert.deepEqual(
		(await conversation.agent(context)).tools.map((tool) => tool.name),
		["write", "codemode"],
	);
	await conversation.submit({ type: "input", content: "proof" }, context);
	harness.resume();
} else {
	harness.resume();
	await harness.waitForIdle(context);
	const conversation = await harness.root(context);
	assert.ok(conversation);
	const history = await conversation.context(context);
	const serialized = JSON.stringify(history);
	assert.match(serialized, /completed-before-crash/);
	assert.match(serialized, /interrupted/i);
	assert.match(serialized, /not available/);
	assert.deepEqual(externalCalls, []);
	assert.ok(
		!(await harness.inspect(context)).tasks
			.filter((task) => task.record.conversationId === conversation.id)
			.some((task) => task.state.kind === "blocked"),
	);
	await harness.close(context);
	await client.close();
	await sandbox.close();
	await env.cleanup(context);
	process.send?.({ kind: "recovered" });
}
