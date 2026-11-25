import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	Harness,
	MemoryStorage,
	createRegistry,
	defineExtension,
	AgentDoc,
	type Conversation,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createMcpToolName } from "@earendil-works/pi-mcp";
import { McpAdapter } from "../dist/mcp.js";
import {
	discoverMcpExtension,
	createCodingRegistry,
} from "../dist/conversation-resources.js";
import type { McpServer } from "../dist/mcp-config.js";
import { startMcpHttpFixture } from "./helpers/mcp-http-fixture.ts";
import { fixtureTool } from "./helpers/mcp-fixture.ts";
import { waitFor } from "./helpers/client.ts";

type Fixture = Awaited<ReturnType<typeof startMcpHttpFixture>>;
const server = (
	fixture: Fixture,
	name = "fixture",
	config: Record<string, unknown> = {},
): McpServer => ({
	kind: "http",
	name,
	config: { url: fixture.url, exposure: "codemode", timeout: 2, ...config },
});
const count = (fixture: Fixture, method: string) =>
	fixture.requests.filter(({ message }) => message.method === method).length;
async function httpFixture(
	t: TestContext,
	...args: Parameters<typeof startMcpHttpFixture>
) {
	const fixture = await startMcpHttpFixture(...args);
	t.after(() => fixture.close());
	return fixture;
}
async function setup(t: TestContext, servers: McpServer[]) {
	const cwd = await mkdtemp(join(tmpdir(), "pid-mcp-"));
	const env = new NodeExecutionEnv({ cwd });
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
	const adapter = new McpAdapter({ servers });
	let harness: Harness | undefined;
	const registry = createRegistry();
	registry.install(
		defineExtension({ name: "coding", tools: [createBashTool()] }),
	);
	t.after(async () => {
		await harness?.close(context);
		await adapter.close();
		await sandbox.close();
		await env.cleanup(context);
		await rm(cwd, { force: true, recursive: true });
	});
	const mcp = await discoverMcpExtension(adapter);
	registry.install(
		createCodemodeExtension({
			sandbox,
			namespaces: mcp?.namespaces ?? [],
			models: false,
		}),
	);
	if (mcp) registry.install(mcp.extension);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const environments = new Map<Conversation["id"], Promise<NodeExecutionEnv>>();
	harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			env: ({ conversationId }) => {
				let pending = environments.get(conversationId);
				if (!pending) {
					pending = adapter.prepare(conversationId, cwd).then(() => env);
					environments.set(conversationId, pending);
				}
				return pending;
			},
			settings: { retry: { enabled: false } },
		},
		context,
	);
	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { cwd, model: { provider: "faux", modelId: "faux-1" } },
		},
		context,
	);
	harness.resume();
	function responses(code: string) {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
	}
	async function history(target = conversation) {
		return JSON.stringify((await target.context(context)).messages);
	}
	async function run(code: string, target = conversation) {
		responses(code);
		const submission = await target.submit(
			{ type: "input", content: "fixture-only" },
			context,
		);
		await submission.wait(withAbortSignal(AbortSignal.timeout(5000), context));
		return history(target);
	}
	return {
		adapter,
		registry,
		harness,
		conversation,
		cwd,
		responses,
		run,
		history,
	};
}

test("async coding registry discovers temporary clients and composes codemode once", async (t) => {
	const fixture = await httpFixture(t);
	const adapter = new McpAdapter({ servers: [server(fixture)] });
	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
	t.after(async () => {
		await adapter.close();
		await sandbox.close();
	});
	const registry = await createCodingRegistry(sandbox, adapter);
	assert.deepEqual(
		registry
			.snapshot()
			.tools()
			.filter(({ tool }) => tool.name === "codemode")
			.map(({ tool }) => tool.name),
		["codemode"],
	);
	assert.equal(count(fixture, "initialize"), 1);
	assert.equal(
		fixture.deleted.length,
		1,
		"startup discovery client closes before Harness opens",
	);
	assert.equal(
		adapter.getStatus(1 as Conversation["id"])[0]?.status,
		"not connected",
	);
});

test("real MCP registrations are codemode-only, unsafe, deferred, hidden and discoverable with native bash", async (t) => {
	const fixture = await httpFixture(t);
	fixture.setTools(["a-b", "a_b", "hidden", "x".repeat(100)].map(fixtureTool));
	const f = await setup(t, [
		server(fixture, "fixture", {
			description: "Fixture namespace",
			toolExposure: { hidden: "hidden" },
		}),
	]);
	const tools = f.registry.snapshot().extension("mcp")?.tools;
	assert.equal(tools?.length, 3);
	assert.equal(new Set(tools?.map((tool) => tool.name)).size, 3);
	assert.ok(
		tools?.every(
			(tool) =>
				tool.name.startsWith("mcp__fixture__") && tool.name.length <= 64,
		),
	);
	for (const tool of tools ?? []) {
		assert.deepEqual(tool.callers, ["tools"]);
		assert.equal(tool.replay, "unsafe");
		assert.equal(tool.deferred, true);
	}
	assert.deepEqual(
		(await f.conversation.agent(context)).tools.map((tool) => tool.name),
		["bash", "codemode"],
	);
	const output = await f.run(
		'text(await describeNamespace("mcp__fixture")); text(ALL_TOOLS); text(await tools.bash({ command: "printf real-bash" }));',
	);
	assert.match(output, /Fixture namespace/);
	assert.match(output, /real-bash/);
	assert.doesNotMatch(output, /mcp__fixture__hidden/);
	assert.equal(
		(await f.harness.snapshot(AgentDoc, f.conversation.id, context))?.tools,
		undefined,
	);
	assert.equal(
		count(fixture, "initialize"),
		2,
		"discovery plus lazy execution client",
	);
	assert.equal(count(fixture, "tools/list"), 2, "only discovery paginates");
});

test("public naming helper disambiguates cross-server generated names and routes original names", async (t) => {
	const first = await httpFixture(t, "first-server");
	first.setTools([fixtureTool("b__c")]);
	const second = await httpFixture(t, "second-server");
	second.setTools([fixtureTool("c")]);
	const f = await setup(t, [server(first, "a"), server(second, "a__b")]);
	const tools = f.registry.snapshot().extension("mcp")?.tools ?? [];
	assert.equal(new Set(tools.map((tool) => tool.name)).size, 2);
	const output = await f.run(
		tools.map((tool) => `text(await tools.${tool.name}({}));`).join("\n"),
	);
	assert.match(output, /first-server/);
	assert.match(output, /second-server/);
	assert.equal(
		(
			first.requests.find((r) => r.message.method === "tools/call")?.message
				.params as { name: string }
		).name,
		"b__c",
	);
	assert.equal(
		(
			second.requests.find((r) => r.message.method === "tools/call")?.message
				.params as { name: string }
		).name,
		"c",
	);
});

for (const length of [33, 80]) {
	test(`long names follow upstream naming without a local prefix policy: ${length}`, async (t) => {
		const fixture = await httpFixture(t);
		fixture.setTools([fixtureTool("value")]);
		const name = "a".repeat(length);
		const f = await setup(t, [server(fixture, name)]);
		assert.equal(
			f.registry.snapshot().extension("mcp")?.tools?.[0]?.name,
			createMcpToolName(name, "value"),
		);
	});
}

test("duplicate original definitions fail public registry installation", async (t) => {
	const fixture = await httpFixture(t);
	fixture.setTools([fixtureTool("duplicate"), fixtureTool("duplicate")]);
	await assert.rejects(setup(t, [server(fixture)]), /duplicate/i);
	assert.equal(fixture.deleted.length, 1);
});

for (const malformed of ["cursor", "schema"] as const) {
	test(`invalid startup ${malformed} fails discovery atomically and closes temporary clients`, async (t) => {
		const fixture = await httpFixture(
			t,
			"fixture",
			malformed === "cursor"
				? {
						pages: [
							{ tools: [fixtureTool("partial")], nextCursor: "1" },
							{ tools: [fixtureTool("loop")], nextCursor: "1" },
						],
					}
				: {},
		);
		if (malformed === "schema")
			fixture.setTools([
				fixtureTool("partial"),
				{
					name: "invalid",
					inputSchema: {
						type: "object",
						properties: { value: { $ref: "#/$defs/missing" } },
					},
				},
			]);
		await assert.rejects(
			setup(t, [server(fixture)]),
			/startup discovery failed/,
		);
		assert.equal(fixture.deleted.length, 1);
	});
}

test("structured errors resolve while protocol errors reject sanitized without killing execution client", async (t) => {
	const fixture = await httpFixture(t);
	const f = await setup(t, [server(fixture)]);
	const output = await f.run(
		"text(await tools.mcp__fixture__error({})); text(await tools.mcp__fixture__array({})); try { await tools.mcp__fixture__protocol({}); } catch (error) { text({ rejected: true, message: String(error) }); } text(await tools.mcp__fixture__value({}));",
	);
	assert.match(output, /isError/);
	assert.match(output, /application/);
	assert.match(output, /rejected/);
	assert.match(output, /inspect the external system/);
	assert.doesNotMatch(output, /PRIVATE_/);
	assert.equal(fixture.deleted.length, 1, "only discovery client closed");
});

test("servers without tools capability never receive tools/list", async (t) => {
	const fixture = await httpFixture(t, "fixture", { capabilities: {} });
	const f = await setup(t, [server(fixture)]);
	assert.equal(count(fixture, "tools/list"), 0);
	assert.equal(f.registry.snapshot().extension("mcp")?.tools?.length, 0);
});

test("tool calls never prepare missing owners; notifications do not rediscover or replace registry", async (t) => {
	const fixture = await httpFixture(t);
	const f = await setup(t, [server(fixture)]);
	const before = f.registry.snapshot();
	const tool = before.extension("mcp")?.tools?.[0];
	assert.ok(tool);
	await assert.rejects(
		tool.execute({}, { conversationId: 999 } as ToolExecutionApi, context),
		/unavailable/,
	);
	assert.equal(count(fixture, "initialize"), 1);
	await f.run("text(await tools.mcp__fixture__value({}));");
	fixture.changed();
	await f.run("text(await tools.mcp__fixture__value({}));");
	assert.equal(f.registry.snapshot(), before);
	assert.equal(count(fixture, "initialize"), 2);
	assert.equal(count(fixture, "tools/list"), 4);
});

test("failed execution setup leaves an already connected sibling usable without retry", async (t) => {
	const fixture = await httpFixture(t);
	const f = await setup(t, [server(fixture)]);
	await f.run("text(await tools.mcp__fixture__value({}));");
	fixture.setInitializeFailure(true);
	const other = await f.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { cwd: f.cwd, model: { provider: "faux", modelId: "faux-1" } },
		},
		context,
	);
	assert.match(
		await f.run(
			"try { await tools.mcp__fixture__value({}); } catch (error) { text(String(error)); }",
			other,
		),
		/unavailable/,
	);
	fixture.setInitializeFailure(false);
	assert.match(
		await f.run("text(await tools.mcp__fixture__value({}));"),
		/http-fixture/,
	);
	await f.run(
		"try { await tools.mcp__fixture__value({}); } catch (error) { text(String(error)); }",
		other,
	);
	assert.equal(count(fixture, "initialize"), 3, "no tool-triggered reconnect");
});

test("native codemode deadline cancels real HTTP request; late output cannot enter next prompt", async (t) => {
	const fixture = await httpFixture(t);
	const f = await setup(t, [server(fixture)]);
	await f.run(
		'// @options: {"timeout_ms": 200}\ntext(await tools.mcp__fixture__hold({}));',
	);
	await waitFor(() => fixture.cancellations.length === 1);
	const session = fixture.cancellations[0];
	assert.ok(session);
	fixture.release(session);
	const output = await f.run("text(await tools.mcp__fixture__value({}));");
	assert.match(output, /http-fixture/);
	assert.doesNotMatch(output, /held-complete|PRIVATE_PROGRESS_BODY/);
	assert.equal(fixture.deleted.length, 1);
});
