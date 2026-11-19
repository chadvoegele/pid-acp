import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	BACKGROUND_CONTEXT as context,
	withAbortSignal,
} from "@earendil-works/chord/context";
import { Harness, AgentDoc } from "@earendil-works/pi-durable";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { Runtime } from "../dist/runtime.js";
import { FilesystemSessionStore } from "../dist/filesystem-session-store.js";
import { loadMcpConfig } from "../dist/mcp-config.js";
import { persistenceFixture } from "./helpers/persistence.ts";
import { assertChildrenStopped } from "./helpers/processes.ts";
import { captureEnvironmentFactory } from "./helpers/environments.ts";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { AgentContext, client as acpClient } from "@agentclientprotocol/sdk";
import { AcpServerFixture } from "./helpers/acp-server-fixture.ts";

async function fixture(t: TestContext) {
	const runtimes: Runtime[] = [];
	t.after(async () => {
		for (const runtime of runtimes) await runtime.close().catch(() => {});
	});
	const f = await persistenceFixture(t);
	const configPath = join(f.root, "mcp.json");
	const logPath = join(f.root, "mcp.log");
	await writeFile(logPath, "");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	async function configure(tools = "value,hold") {
		await writeFile(
			configPath,
			JSON.stringify({
				mcpServers: {
					fixture: {
						command: process.execPath,
						args: [resolve("tests/helpers/mcp-stdio-fixture.ts")],
						env: { MCP_FIXTURE_LOG: logPath, MCP_FIXTURE_TOOLS: tools },
					},
				},
			}),
			{ mode: 0o600 },
		);
		return loadMcpConfig({ path: configPath, required: true }, {});
	}
	async function open(
		tools = "value,hold",
		extensionPaths?: readonly string[],
	) {
		const runtime = await Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{},
			f.sessions,
			await configure(tools),
			extensionPaths,
		);
		runtimes.push(runtime);
		return runtime;
	}
	async function records() {
		return (await readFile(logPath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as { event: string; pid: number; cwd: string },
			);
	}
	async function waitForEvent(event: string) {
		const deadline = Date.now() + 5000;
		while (!(await records()).some((record) => record.event === event)) {
			assert.ok(Date.now() < deadline, `missing fixture event ${event}`);
			await delay(10);
		}
	}
	function responses(code: string) {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
	}
	return { ...f, open, records, responses, waitForEvent };
}

test("Runtime prepares current tools before native resume, load is presentation-only and saved filters stay unchanged", async (t) => {
	const f = await fixture(t);
	let runtime = await f.open();
	const session = await runtime.createSession(f.cwd);
	f.responses(
		'text(await describeNamespace("mcp__fixture")); text(await tools.mcp__fixture__value({}));',
	);
	const submission = await session.conversation.submit(
		{ type: "input", content: "fixture" },
		context,
	);
	await submission.wait(withAbortSignal(AbortSignal.timeout(5000), context));
	assert.match(
		JSON.stringify(await session.conversation.context(context)),
		/stdio-fixture/,
	);
	assert.match(
		JSON.stringify(await session.conversation.context(context)),
		/MCP server fixture/,
	);
	await session.conversation.commit(async (tx) => {
		(await tx.doc(AgentDoc, session.conversation.id)).tools = [
			"codemode",
			"mcp__fixture__value",
		];
	}, context);
	await session.close();
	await runtime.close();
	const firstRecords = await f.records();
	assert.ok(firstRecords.some((record) => record.event === "call:value"));
	await assertChildrenStopped(
		firstRecords
			.filter((record) => record.event === "start")
			.map((record) => record.pid),
	);
	const open = Harness.open;
	let resumed = false;
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		const harness = await open(...args);
		const resume = harness.resume.bind(harness);
		t.mock.method(harness, "resume", () => {
			assert.deepEqual(
				args[1].registry
					.snapshot()
					.extension("mcp")
					?.tools?.map((tool) => tool.name),
				["mcp__fixture__current", "mcp__fixture__value"],
			);
			const section = args[1].registry.snapshot().extension("codemode")
				?.sections?.[0];
			assert.ok(section);
			const tool = args[1].registry.snapshot().extension("mcp")?.tools?.[0];
			assert.ok(tool);
			const rendered = section.render(
				{
					agent: { callable: [{ ...tool, deferred: false }] },
				} as unknown as Parameters<typeof section.render>[0],
				context,
			);
			assert.ok(typeof rendered === "string");
			assert.match(rendered, /mcp__fixture/);
			assert.match(rendered, /MCP server fixture/);
			resumed = true;
			resume();
		});
		return harness;
	});
	runtime = await f.open("value,current");
	assert.ok(resumed);
	const beforeLoad = await f.records();
	const loaded = await runtime.loadSession(session.id, f.cwd);
	assert.deepEqual(
		await f.records(),
		beforeLoad,
		"load itself performs no discovery or connection setup",
	);
	assert.match(
		JSON.stringify(await loaded.conversation.context(context)),
		/stdio-fixture/,
	);
	assert.deepEqual(
		(await loaded.harness.snapshot(AgentDoc, loaded.conversation.id, context))
			?.tools,
		["codemode", "mcp__fixture__value"],
	);
	const starts = (await f.records()).filter(
		(record) => record.event === "start",
	);
	assert.deepEqual(
		starts.map((record) => record.cwd),
		[process.cwd(), f.cwd, process.cwd()],
	);
	assert.equal(
		starts.length,
		3,
		"restart discovers once, without dormant execution clients",
	);
});

test("attachment close does not abort MCP; explicit cancellation does, and Runtime joins native work before disposal", async (t) => {
	const f = await fixture(t);
	const runtime = await f.open();
	const session = await runtime.createSession(f.cwd);
	f.responses("await tools.mcp__fixture__hold({});");
	const submission = await session.conversation.submit(
		{ type: "input", content: "hold" },
		context,
	);
	await f.waitForEvent("call:hold");
	await session.close();
	assert.ok(
		!(await f.records())
			.filter((record) => record.cwd === f.cwd)
			.some((record) => ["cancelled", "close"].includes(record.event)),
	);
	await session.conversation.abort(context);
	await submission.wait(context);
	await f.waitForEvent("cancelled");
	assert.ok(
		!(await f.records()).some(
			(record) => record.cwd === f.cwd && record.event === "close",
		),
	);
	const close = session.harness.close.bind(session.harness);
	const entered = Promise.withResolvers<void>();
	const join = Promise.withResolvers<void>();
	t.after(() => join.resolve());
	t.mock.method(
		session.harness,
		"close",
		async (...args: Parameters<typeof close>) => {
			entered.resolve();
			await join.promise;
			await close(...args);
		},
	);
	const closing = runtime.close();
	await entered.promise;
	assert.ok(
		!(await f.records()).some(
			(record) => record.cwd === f.cwd && record.event === "close",
		),
	);
	join.resolve();
	await closing;
	await assertChildrenStopped(
		(await f.records())
			.filter((record) => record.event === "start")
			.map((record) => record.pid),
	);
});

test("failed ACP load replay leaves detached MCP work and same-cwd sibling connections alive", async (t) => {
	const f = await fixture(t);
	const runtime = await f.open();
	const session = await runtime.createSession(f.cwd);
	const sibling = await runtime.createSession(f.cwd);
	f.responses("text(await tools.mcp__fixture__value({}));");
	const completed = await session.conversation.submit(
		{ type: "input", content: "history" },
		context,
	);
	await completed.wait(withAbortSignal(AbortSignal.timeout(5000), context));
	f.responses("await tools.mcp__fixture__hold({});");
	const pending = await session.conversation.submit(
		{ type: "input", content: "detached" },
		context,
	);
	await f.waitForEvent("call:hold");
	await session.close();
	const acpServer = new AcpServerFixture(runtime);
	const connection = acpClient().connect(acpServer.createApp());
	t.after(() => connection.close());
	const notify = t.mock.method(AgentContext.prototype, "notify", async () => {
		throw new Error("PRIVATE_REPLAY_TRANSPORT");
	});
	await assert.rejects(
		connection.agent.request("session/load", {
			sessionId: session.id,
			cwd: f.cwd,
			mcpServers: [],
		}),
		(error: Error) => {
			assert.match(error.message, /Could not load saved session/);
			assert.doesNotMatch(error.message, /PRIVATE_REPLAY_TRANSPORT/);
			return true;
		},
	);
	notify.mock.restore();
	assert.deepEqual(
		(await f.records())
			.filter((record) => record.cwd === f.cwd)
			.filter((record) => ["close", "cancelled"].includes(record.event)),
		[],
	);
	assert.equal(
		(await f.records()).filter((record) => record.event === "start").length,
		2,
	);
	await connection.agent.request("session/load", {
		sessionId: session.id,
		cwd: f.cwd,
		mcpServers: [],
	});
	await session.conversation.abort(context);
	await pending.wait(withAbortSignal(AbortSignal.timeout(5000), context));
	await f.waitForEvent("cancelled");
	f.responses("text(await tools.mcp__fixture__value({}));");
	const next = await sibling.conversation.submit(
		{ type: "input", content: "sibling remains usable" },
		context,
	);
	await next.wait(withAbortSignal(AbortSignal.timeout(5000), context));
	assert.match(
		JSON.stringify(await sibling.conversation.context(context)),
		/stdio-fixture/,
	);
	assert.equal(
		(await f.records()).filter((record) => record.event === "cancelled").length,
		1,
	);
	await acpServer.close();
	await assertChildrenStopped(
		(await f.records())
			.filter((record) => record.event === "start")
			.map((record) => record.pid),
	);
});

test("Runtime resumes unfinished codemode without attachment using current tools and native unsafe recovery", async (t) => {
	const f = await fixture(t);
	let runtime = await f.open();
	const session = await runtime.createSession(f.cwd);
	f.responses(`text(await tools.mcp__fixture__value({}));
	try { await tools.mcp__fixture__hold({}); } catch (error) { text(String(error)); }
	try { await tools.mcp__fixture__value({}); } catch (error) { text(String(error)); }
	await tools.write({ path: "recovered.txt", content: "recovered-with-current-tools" });`);
	await session.conversation.submit(
		{ type: "input", content: "recover" },
		context,
	);
	await f.waitForEvent("call:hold");
	await session.close();
	await runtime.close();
	const nativeOpen = Harness.open;
	let recoveredHarness: Harness | undefined;
	t.mock.method(
		Harness,
		"open",
		async (...args: Parameters<typeof nativeOpen>) => {
			recoveredHarness = await nativeOpen(...args);
			return recoveredHarness;
		},
	);
	runtime = await f.open("current");
	const deadline = Date.now() + 5000;
	while (
		(await readFile(join(f.cwd, "recovered.txt"), "utf8").catch(() => "")) !==
		"recovered-with-current-tools"
	) {
		assert.ok(
			Date.now() < deadline,
			"unattached native recovery did not finish",
		);
		await delay(10);
	}
	assert.ok(recoveredHarness);
	await recoveredHarness.waitForIdle(
		withAbortSignal(AbortSignal.timeout(5000), context),
	);
	const records = await f.records();
	assert.equal(
		records.filter((record) => record.event === "call:hold").length,
		1,
	);
	assert.equal(
		records.filter((record) => record.event === "call:value").length,
		1,
		"completed envelope is reused and the removed tool is not redispatched",
	);
	const loaded = await runtime.loadSession(session.id, f.cwd);
	const history = JSON.stringify(await loaded.conversation.context(context));
	assert.match(history, /stdio-fixture/);
	assert.match(history, /interrupted/i);
	assert.match(history, /not available/);
	assert.ok(
		!(await loaded.harness.inspect(context)).tasks.some(
			(task) =>
				task.record.conversationId === loaded.conversation.id &&
				task.state.kind === "blocked",
		),
	);
});

test("workspace repair allocates MCP on the next native invocation, never on load", async (t) => {
	const f = await fixture(t);
	let runtime = await f.open();
	const session = await runtime.createSession(f.cwd);
	await runtime.close();
	await rm(f.cwd, { recursive: true });
	runtime = await f.open();
	const before = await f.records();
	await mkdir(f.cwd);
	const loaded = await runtime.loadSession(session.id, f.cwd);
	assert.deepEqual(await f.records(), before);
	f.responses("text(await tools.mcp__fixture__value({}));");
	const submitted = await loaded.conversation.submit(
		{ type: "input", content: "repaired" },
		context,
	);
	await submitted.wait(withAbortSignal(AbortSignal.timeout(5000), context));
	assert.match(
		JSON.stringify(await loaded.conversation.context(context)),
		/stdio-fixture/,
	);
	assert.equal(
		(await f.records()).filter((record) => record.event === "start").length,
		3,
	);
});

test("late native environment allocation during close neither opens MCP nor escapes cleanup", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await fixture(t);
	const runtime = await f.open();
	const session = await runtime.createSession(f.cwd);
	const before = await f.records();
	const close = session.harness.close.bind(session.harness);
	t.mock.method(
		session.harness,
		"close",
		async (...args: Parameters<typeof close>) => {
			await environmentFor(session, f.cwd);
			assert.deepEqual(await f.records(), before);
			await close(...args);
		},
	);
	const cleanup = t.mock.method(NodeExecutionEnv.prototype, "cleanup");
	const abort = t.mock.method(session.conversation, "abort");
	await runtime.close();
	assert.equal(cleanup.mock.callCount(), 1);
	assert.equal(abort.mock.callCount(), 0);
	assert.equal(
		(await f.records()).filter((record) => record.event === "start").length,
		1,
	);
});

test("MCP cleanup failure still closes sandbox and releases the namespace", async (t) => {
	const f = await fixture(t);
	const runtime = await f.open();
	const first = await runtime.createSession(f.cwd);
	const second = await runtime.createSession(f.cwd);
	for (const session of [first, second]) {
		f.responses("text(await tools.mcp__fixture__value({}));");
		const submission = await session.conversation.submit(
			{ type: "input", content: "allocate" },
			context,
		);
		await submission.wait(withAbortSignal(AbortSignal.timeout(5000), context));
	}
	const close = StdioTransport.prototype.close;
	const closing = t.mock.method(
		StdioTransport.prototype,
		"close",
		async function (this: StdioTransport) {
			await close.call(this);
			throw new Error("PRIVATE_TRANSPORT_CLOSE");
		},
	);
	const sandboxClose = t.mock.method(CodemodeSandbox.prototype, "close");
	await assert.rejects(runtime.close(), (error) => {
		assert.ok(error instanceof AggregateError);
		assert.doesNotMatch(String(error.errors), /PRIVATE_TRANSPORT_CLOSE/);
		return true;
	});
	assert.equal(closing.mock.callCount(), 2);
	assert.equal(sandboxClose.mock.callCount(), 1);
	await assertChildrenStopped(
		(await f.records())
			.filter((record) => record.event === "start")
			.map((record) => record.pid),
	);
	closing.mock.restore();
	await f.open();
});

test("installs built-ins, codemode, MCP, then user extensions before opening", async (t) => {
	const f = await fixture(t);
	const paths = [join(f.root, "z.mjs"), join(f.root, "a.mts")];
	await writeFile(paths[0], 'export default { name: "user.first" };');
	await writeFile(
		paths[1],
		'const name: string = "user.second"; export default { name };',
	);
	const open = Harness.open;
	const opening = t.mock.method(
		Harness,
		"open",
		async (...args: Parameters<typeof open>) => {
			assert.deepEqual(
				args[1].registry
					.snapshot()
					.installed()
					.map(({ name }) => name),
				["coding", "skills", "codemode", "mcp", "user.first", "user.second"],
			);
			return open(...args);
		},
	);
	await f.open("value", paths);
	assert.equal(opening.mock.callCount(), 1);
});

test("native extension registration failure releases startup resources before recovery", async (t) => {
	const f = await fixture(t);
	const path = join(f.root, "invalid.mjs");
	await writeFile(
		path,
		`export default {
		name: "invalid",
		tools: [{ name: "private-fixture-token" }, { name: "private-fixture-token" }]
	};`,
	);
	const storageOpen = t.mock.method(
		FilesystemSessionStore.prototype,
		"openStorage",
	);
	const storeClose = t.mock.method(FilesystemSessionStore.prototype, "close");
	const sandboxClose = t.mock.method(CodemodeSandbox.prototype, "close");
	const harnessOpen = t.mock.method(Harness, "open");

	await assert.rejects(f.open("value", [path]), (error) => {
		assert.ok(error instanceof Error);
		assert.match(
			error.message,
			/^PID_ACP_EXTENSIONS entry 1 \(registration\): Check/,
		);
		assert.equal(error.cause, undefined);
		assert.doesNotMatch(error.message, /private-fixture-token/);
		return true;
	});
	assert.equal(storageOpen.mock.callCount(), 0);
	assert.equal(harnessOpen.mock.callCount(), 0);
	assert.equal(storeClose.mock.callCount(), 1);
	assert.equal(sandboxClose.mock.callCount(), 1);
	const starts = (await f.records()).filter(
		(record) => record.event === "start",
	);
	assert.equal(starts.length, 1);
	await assertChildrenStopped(starts.map((record) => record.pid));
	await f.open("value");
});

test("failed Runtime startup still closes discovered clients, sandbox and namespace", async (t) => {
	const f = await fixture(t);
	const runtime = await f.open();
	await runtime.createSession(f.cwd);
	await runtime.close();
	const open = Harness.open;
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		const harness = await open(...args);
		t.mock.method(harness, "resume", () => {
			throw new Error("PRIVATE_FAILED_RESUME");
		});
		return harness;
	});
	const closeSandbox = t.mock.method(CodemodeSandbox.prototype, "close");
	await assert.rejects(f.open(), /Could not open shared session storage/);
	assert.equal(closeSandbox.mock.callCount(), 1);
	const records = await f.records();
	assert.equal(records.filter((record) => record.event === "start").length, 2);
	await assertChildrenStopped(
		records
			.filter((record) => record.event === "start")
			.map((record) => record.pid),
	);
});
