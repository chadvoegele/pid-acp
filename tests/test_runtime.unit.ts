import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Runtime } from "../dist/runtime.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	AgentDoc,
	Harness,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { ConversationDoc, MappingDoc } from "../dist/conversation-resources.js";
import { FilesystemSessionStore } from "../dist/filesystem-session-store.js";
import { persistenceFixture } from "./helpers/persistence.ts";
import { captureEnvironmentFactory } from "./helpers/environments.ts";

test("codemode and native tools are installed before Harness opening without auxiliary models", async (t) => {
	const f = await persistenceFixture(t);
	const open = Harness.open;
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		const registry = args[1].registry.snapshot();
		assert.deepEqual(
			registry.tools().map(({ tool }) => tool.name),
			["bash", "read", "edit", "write", "codemode"],
		);
		assert.deepEqual(
			registry.sections().map(({ section }) => section.key),
			["skills", "codemode"],
		);
		for (const name of ["bash", "read", "edit", "write"])
			assert.equal(
				registry.tools().find(({ tool }) => tool.name === name)?.tool.replay ??
					"unsafe",
				"unsafe",
			);
		const codemode = registry.extension("codemode")?.tools?.[0];
		assert.equal(codemode?.name, "codemode");
		assert.equal(codemode?.replay, "safe");
		assert.deepEqual(codemode?.callers, ["model"]);
		assert.doesNotMatch(codemode?.description ?? "", /models\.classify/);
		return open(...args);
	});
	const runtime = await f.runtime();
	const session = await runtime.createSession(f.cwd);
	assert.deepEqual(
		(await session.conversation.agent(context)).tools.map((tool) => tool.name),
		["bash", "read", "edit", "write", "codemode"],
	);
	assert.equal(
		(await session.harness.snapshot(AgentDoc, session.conversation.id, context))
			?.tools,
		undefined,
	);
});

test("loading preserves an explicit saved tool selection", async (t) => {
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const session = await runtime.createSession(f.cwd);
	await session.conversation.commit(async (tx) => {
		(await tx.doc(AgentDoc, session.conversation.id)).tools = ["read"];
	}, context);
	await session.close();
	await runtime.close();
	const reopened = await f.runtime();
	const loaded = await reopened.loadSession(session.id, f.cwd);
	assert.deepEqual(
		(await loaded.conversation.agent(context)).tools.map((tool) => tool.name),
		["read"],
	);
	assert.deepEqual(
		(await loaded.harness.snapshot(AgentDoc, loaded.conversation.id, context))
			?.tools,
		["read"],
	);
});

test("runtime joins Harness close before closing sandbox, environments and namespace", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const session = await runtime.createSession(f.cwd);
	const env = await environmentFor(session, f.cwd);
	assert.ok(env);
	const entered = Promise.withResolvers<void>();
	const joined = Promise.withResolvers<void>();
	t.after(() => joined.resolve());
	const order: string[] = [];
	const close = session.harness.close.bind(session.harness);
	t.mock.method(
		session.harness,
		"close",
		async (ctx: Parameters<typeof close>[0]) => {
			entered.resolve();
			await joined.promise;
			await close(ctx);
			order.push("harness");
		},
	);
	const closeSandbox = CodemodeSandbox.prototype.close;
	t.mock.method(
		CodemodeSandbox.prototype,
		"close",
		async function (this: CodemodeSandbox) {
			order.push("sandbox");
			await closeSandbox.call(this);
		},
	);
	const cleanup = env.cleanup.bind(env);
	t.mock.method(env, "cleanup", async (ctx: Parameters<typeof cleanup>[0]) => {
		order.push("environment");
		await cleanup(ctx);
	});
	const closeStore = FilesystemSessionStore.prototype.close;
	t.mock.method(
		FilesystemSessionStore.prototype,
		"close",
		async function (this: FilesystemSessionStore) {
			order.push("store");
			await closeStore.call(this);
		},
	);
	const closing = runtime.close();
	await entered.promise;
	assert.deepEqual(order, []);
	joined.resolve();
	await closing;
	assert.deepEqual(order, ["harness", "sandbox", "environment", "store"]);
});

test("failed storage opening closes the sandbox and releases the namespace", async (t) => {
	const f = await persistenceFixture(t);
	const sandboxClose = t.mock.method(CodemodeSandbox.prototype, "close");
	const storeClose = t.mock.method(FilesystemSessionStore.prototype, "close");
	const open = t.mock.method(
		FilesystemSessionStore.prototype,
		"openStorage",
		async () => {
			throw new Error("PRIVATE_STORAGE");
		},
	);
	await assert.rejects(f.runtime(), /Could not open shared/);
	assert.equal(sandboxClose.mock.callCount(), 1);
	assert.equal(storeClose.mock.callCount(), 1);
	open.mock.restore();
	await f.runtime();
});

test("failed backend cleanup still closes sandbox and releases namespace", async (t) => {
	const f = await persistenceFixture(t);
	const sandboxClose = t.mock.method(CodemodeSandbox.prototype, "close");
	const storeClose = t.mock.method(FilesystemSessionStore.prototype, "close");
	const open = t.mock.method(
		Harness,
		"open",
		async (...args: Parameters<typeof Harness.open>) => {
			const close = args[0].close.bind(args[0]);
			args[0].close = async (ctx) => {
				await close(ctx);
				throw new Error("PRIVATE_CLOSE");
			};
			throw new Error("PRIVATE_OPEN");
		},
	);
	await assert.rejects(f.runtime(), /Could not open shared/);
	assert.equal(sandboxClose.mock.callCount(), 1);
	assert.equal(storeClose.mock.callCount(), 1);
	open.mock.restore();
	await f.runtime();
});

test("failed resume releases the opened Harness, sandbox and namespace", async (t) => {
	const f = await persistenceFixture(t);
	const sandboxClose = t.mock.method(CodemodeSandbox.prototype, "close");
	const storeClose = t.mock.method(FilesystemSessionStore.prototype, "close");
	let closed = 0;
	const open = Harness.open;
	const opening = t.mock.method(
		Harness,
		"open",
		async (...args: Parameters<typeof open>) => {
			const harness = await open(...args);
			const close = harness.close.bind(harness);
			t.mock.method(
				harness,
				"close",
				async (ctx: Parameters<typeof close>[0]) => {
					closed++;
					await close(ctx);
				},
			);
			t.mock.method(harness, "resume", () => {
				throw new Error("PRIVATE_RESUME");
			});
			return harness;
		},
	);
	await assert.rejects(f.runtime(), /Could not open shared/);
	assert.equal(closed, 1);
	assert.equal(sandboxClose.mock.callCount(), 1);
	assert.equal(storeClose.mock.callCount(), 1);
	opening.mock.restore();
	await f.runtime();
});

test("sandbox close failure still cleans environments and releases namespace", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const session = await runtime.createSession(f.cwd);
	const env = await environmentFor(session, f.cwd);
	assert.ok(env);
	const cleanup = t.mock.method(NodeExecutionEnv.prototype, "cleanup");
	const storeClose = t.mock.method(FilesystemSessionStore.prototype, "close");
	const closeSandbox = CodemodeSandbox.prototype.close;
	const sandboxClose = t.mock.method(
		CodemodeSandbox.prototype,
		"close",
		async function (this: CodemodeSandbox) {
			await closeSandbox.call(this);
			throw new Error("sandbox close failed");
		},
	);
	await assert.rejects(runtime.close(), /Could not release shared/);
	assert.equal(cleanup.mock.callCount(), 1);
	assert.equal(storeClose.mock.callCount(), 1);
	sandboxClose.mock.restore();
	await f.runtime();
	t.mock.method(runtime, "close", async () => {});
});

for (const level of [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const) {
	test(`runtime preserves configured thinking level ${level}`, async () => {
		const models = createModels();
		models.setProvider(fauxProvider().provider);
		const runtime = await Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			level,
		);
		try {
			const session = await runtime.createSession(tmpdir());
			assert.equal(
				(await session.conversation.agent(context)).thinkingLevel,
				level,
			);
		} finally {
			await runtime.close();
		}
	});
}

test("startup opens and resumes one Harness; two ownerless sessions share it and use distinct IDs", async (t) => {
	const f = await persistenceFixture(t);
	const open = t.mock.method(Harness, "open");
	const sandboxClose = t.mock.method(CodemodeSandbox.prototype, "close");
	const runtime = await f.runtime();
	assert.equal(open.mock.callCount(), 1);
	const [a, b] = await Promise.all([
		runtime.createSession(f.cwd),
		runtime.createSession(f.cwd),
	]);
	assert.equal(open.mock.callCount(), 1);
	assert.equal(a.harness, b.harness);
	assert.notEqual(a.id, b.id);
	assert.notEqual(a.conversation.id, b.conversation.id);
	assert.notEqual(a.conversation.id, ROOT_CONVERSATION_ID);
	assert.notEqual(a.id, String(a.conversation.id));
	assert.match(a.id, /^[0-9a-f-]{36}$/);
	assert.equal((await a.harness.inspect(context)).scheduling, "running");
	assert.equal(
		await a.harness.conversation(ROOT_CONVERSATION_ID, context),
		undefined,
	);
	const mapping = await a.harness.snapshot(MappingDoc, context);
	assert.deepEqual(mapping?.conversations, {
		[a.id]: a.conversation.id,
		[b.id]: b.conversation.id,
	});
	assert.deepEqual(
		await a.harness.snapshot(ConversationDoc, a.conversation.id, context),
		{ sessionId: a.id, skills: "" },
	);
	assert.equal((await a.conversation.agent(context)).cwd, f.cwd);
	const close = t.mock.method(a.harness, "close");
	await a.close();
	await b.close();
	assert.equal(close.mock.callCount(), 0);
	assert.equal(sandboxClose.mock.callCount(), 0);
	const closing = runtime.close();
	assert.equal(runtime.close(), closing);
	await closing;
	assert.equal(close.mock.callCount(), 1);
	assert.equal(sandboxClose.mock.callCount(), 1);
	assert.ok(sandboxClose.mock.calls[0]?.this instanceof CodemodeSandbox);
	await assert.rejects(runtime.createSession(f.cwd), /unavailable/);
	await f.edit(async (storage) => {
		for (const session of [a, b]) {
			const scope = {
				kind: "conversation" as const,
				conversationId: session.conversation.id,
			};
			const metadata = await storage.findDocument(
				{ kind: ConversationDoc.definition.kind, scope },
				"current",
				context,
			);
			const agent = await storage.findDocument(
				{ kind: AgentDoc.definition.kind, scope },
				"current",
				context,
			);
			const record = await storage.conversation(
				session.conversation.id,
				context,
			);
			assert.ok(metadata && agent && record);
			assert.equal(metadata.createdAt, agent.createdAt);
			assert.equal(record.owner, undefined);
		}
	});
});

test("creating transaction failure leaves no half-published mapping and preserves sibling", async (t) => {
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const create = a.harness.createConversation.bind(a.harness);
	const mock = t.mock.method(
		a.harness,
		"createConversation",
		async (
			options: Parameters<typeof create>[0],
			ctx: Parameters<typeof create>[1],
		) =>
			create(
				{
					...options,
					init: async (tx, id) => {
						await options.init?.(tx, id);
						throw new Error("rollback");
					},
				},
				ctx,
			),
	);
	await assert.rejects(runtime.createSession(f.cwd), /rollback/);
	assert.deepEqual(
		(await a.harness.snapshot(MappingDoc, context))?.conversations,
		{ [a.id]: a.conversation.id },
	);
	assert.ok(await a.conversation.agent(context));
	assert.equal(runtime.failed, false);
	mock.mock.restore();
	assert.notEqual((await runtime.createSession(f.cwd)).id, a.id);
});

test("startup opening failure closes untransferred backend and releases namespace", async (t) => {
	const f = await persistenceFixture(t);
	let closed = 0;
	const sandboxClose = t.mock.method(CodemodeSandbox.prototype, "close");
	const mock = t.mock.method(
		Harness,
		"open",
		async (...args: Parameters<typeof Harness.open>) => {
			const close = args[0].close.bind(args[0]);
			args[0].close = async (ctx) => {
				closed++;
				await close(ctx);
			};
			throw new Error("PRIVATE_OPEN");
		},
	);
	await assert.rejects(
		f.runtime(),
		(error: Error) =>
			/Could not open shared/.test(error.message) &&
			!/PRIVATE/.test(error.message),
	);
	assert.equal(closed, 1);
	assert.equal(sandboxClose.mock.callCount(), 1);
	mock.mock.restore();
	await f.runtime();
});

test("storage failure report stops global admission and remains process-owned", async (t) => {
	const f = await persistenceFixture(t);
	const open = Harness.open;
	let report: Parameters<typeof open>[1]["onReport"];
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		report = args[1].onReport;
		return open(...args);
	});
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const b = await runtime.createSession(f.cwd);
	assert.ok(report);
	report({ kind: "storage_failed", error: new Error("PRIVATE") });
	await runtime.failure;
	assert.equal(a.failed, true);
	assert.equal(b.failed, true);
	await assert.rejects(runtime.createSession(f.cwd), /unavailable/);
	await assert.rejects(runtime.loadSession(a.id, f.cwd), /unavailable/);
});

test("runtime snapshots caller-owned launch defaults and saved choices do not follow later launch changes", async (t) => {
	const f = await persistenceFixture(t);
	const rules = join(f.root, "rules");
	await writeFile(rules, "ORIGINAL_RULES");
	const model = { provider: "faux", modelId: "faux-1" };
	const resources = { instructionsPath: rules };
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const runtime = await Runtime.open(
		models,
		model,
		"medium",
		resources,
		f.sessions,
	);
	model.modelId = "changed";
	resources.instructionsPath = "absent";
	const session = await runtime.createSession(f.cwd);
	assert.match(
		(await session.conversation.agent(context)).instructions ?? "",
		/ORIGINAL_RULES/,
	);
	await runtime.close();
	const next = await f.runtime({
		modelId: "different-default",
		thinking: "off",
	});
	const loaded = await next.loadSession(session.id, f.cwd);
	assert.equal(
		(await loaded.conversation.agent(context)).model?.modelId,
		"faux-1",
	);
	assert.equal(
		(await loaded.conversation.agent(context)).thinkingLevel,
		"medium",
	);
});

test("all resources release even after native close failure", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const close = a.harness.close.bind(a.harness);
	t.mock.method(
		a.harness,
		"close",
		async (ctx: Parameters<typeof close>[0]) => {
			await close(ctx);
			throw new Error("close failed");
		},
	);
	const env = await environmentFor(a, f.cwd);
	assert.ok(env);
	const sandboxClose = t.mock.method(CodemodeSandbox.prototype, "close");
	const cleanup = t.mock.method(env, "cleanup");
	const released = t.mock.method(FilesystemSessionStore.prototype, "close");
	await assert.rejects(runtime.close(), /Could not release shared/);
	assert.equal(sandboxClose.mock.callCount(), 1);
	assert.equal(cleanup.mock.callCount(), 1);
	assert.equal(released.mock.callCount(), 1);
	await f.runtime();
	// The failed close remains idempotently failed; fixture must not treat it as new work.
	t.mock.method(runtime, "close", async () => {});
});
