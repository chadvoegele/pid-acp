import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	AgentDoc,
	Harness,
	createRegistry,
	defineExtension,
	defineTask,
} from "@earendil-works/pi-durable";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../dist/runtime.js";
import { ConversationDoc, MappingDoc } from "../dist/conversation-resources.js";
import { openSessionStore } from "../dist/session-store.js";
import { persistenceFixture } from "./helpers/persistence.ts";

const pathFor = (root: string) => join(root, "db", "main.jsonl");

test("clean shared shutdown preserves three unfinished submissions and startup answers them without attachment", {
	timeout: 5000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const allEntered = Promise.withResolvers<void>();
	let entered = 0;
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	provider.setResponses(
		Array.from({ length: 3 }, () => async (_request, options) => {
			if (++entered === 3) allEntered.resolve();
			await new Promise<void>((_resolve, reject) => {
				if (options?.signal?.aborted) return reject(new Error("native close"));
				options?.signal?.addEventListener(
					"abort",
					() => reject(new Error("native close")),
					{ once: true },
				);
			});
			return fauxAssistantMessage("must not succeed during close");
		}),
	);
	const first = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
		f.sessions,
	);
	const conversations = await Promise.all([
		first.createSession(f.cwd),
		first.createSession(f.cwd),
		first.createSession(f.cwd),
	]);
	const submissions = await Promise.all(
		conversations.map((session) =>
			session.conversation.submit(
				{ type: "input", content: session.id, whenBusy: "reject" },
				context,
			),
		),
	);
	await allEntered.promise;
	const aborts = conversations.map((session) =>
		t.mock.method(session.conversation, "abort"),
	);
	await first.close();
	assert.ok(aborts.every((abort) => abort.mock.callCount() === 0));
	const recovered = Promise.withResolvers<void>();
	let resumed = 0;
	provider.setResponses(
		Array.from({ length: 3 }, () => () => {
			if (++resumed === 3) recovered.resolve();
			return fauxAssistantMessage("Recovered without a client.");
		}),
	);
	const open = Harness.open;
	let native: Harness | undefined;
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		native = await open(...args);
		return native;
	});
	const next = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
		f.sessions,
	);
	try {
		// This resolves from provider calls, before any progress-enabling client/load/wait operation.
		await recovered.promise;
		assert.equal(resumed, 3);
		assert.ok(native);
		for (const submission of submissions) {
			const saved = await native.submission(submission.id, context);
			assert.ok(saved);
			assert.equal((await saved.wait(context)).status, "done");
		}
		for (const session of conversations) {
			const conversation = await native.conversation(
				session.conversation.id,
				context,
			);
			assert.ok(conversation);
			assert.match(
				JSON.stringify((await conversation.context(context)).messages),
				/Recovered without a client/,
			);
		}
	} finally {
		await next.close();
	}
});

test("restart retains independent canonical resources and agent choices despite changed launch defaults", async (t) => {
	const f = await persistenceFixture(t);
	const rules = join(f.root, "rules");
	const skills = join(f.root, "skills");
	await mkdir(join(skills, "test"), { recursive: true });
	await writeFile(rules, "ORIGINAL_INSTRUCTIONS");
	await writeFile(
		join(skills, "test", "SKILL.md"),
		"---\nname: test\ndescription: ORIGINAL_CATALOG\n---\nbody",
	);
	const first = await f.runtime({
		thinking: "medium",
		resources: { instructionsPath: rules, skillsDir: skills },
	});
	const a = await first.createSession(f.cwd);
	const before = await a.conversation.agent(context);
	await first.close();
	await writeFile(rules, "CHANGED");
	await writeFile(join(skills, "test", "SKILL.md"), "BROKEN_DO_NOT_REDISCOVER");
	const next = await f.runtime({
		modelId: "different-default",
		resources: { instructionsPath: rules, skillsDir: skills },
	});
	const loaded = await next.loadSession(a.id, f.cwd);
	const after = await loaded.conversation.agent(context);
	assert.equal(after.cwd, f.cwd);
	assert.equal(after.instructions, before.instructions);
	assert.equal(after.thinkingLevel, "medium");
	assert.deepEqual(after.model, before.model);
	const metadata = await loaded.harness.snapshot(
		ConversationDoc,
		loaded.conversation.id,
		context,
	);
	assert.match(metadata?.skills ?? "", /ORIGINAL_CATALOG/);
	const different = join(f.root, "different");
	await mkdir(different);
	await assert.rejects(next.loadSession(a.id, different), /workspace/);
	await rm(f.cwd, { recursive: true });
	await assert.rejects(next.loadSession(a.id, f.cwd), /workspace/);
});

test("a shared namespace retains its lock inode across restart", async (t) => {
	const f = await persistenceFixture(t);
	const first = await f.runtime();
	const a = await first.createSession(f.cwd);
	const inode = (await stat(join(f.sessions, "owner.lock"))).ino;
	await assert.rejects(f.runtime(), /already owned/);
	await first.close();
	const next = await f.runtime();
	assert.equal((await next.loadSession(a.id, f.cwd)).id, a.id);
	assert.equal((await stat(join(f.sessions, "owner.lock"))).ino, inode);
});

for (const invalid of [
	"../escape",
	"/absolute",
	"",
	"1",
	".creating-incomplete",
	"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
	"00000000-0000-0000-0000-000000000000",
]) {
	test(`invalid external ID ${JSON.stringify(invalid)} never creates a conversation`, async (t) => {
		const f = await persistenceFixture(t);
		const runtime = await f.runtime();
		await assert.rejects(
			runtime.loadSession(invalid, f.cwd),
			/Invalid session ID/,
		);
		const a = await runtime.createSession(f.cwd);
		assert.equal(
			Object.keys(
				(await a.harness.snapshot(MappingDoc, context))?.conversations ?? {},
			).length,
			1,
		);
	});
}

for (const mutation of [
	"missing",
	"version",
	"skills",
	"agent",
	"mapping",
	"duplicate-mapping",
] as const) {
	test(`saved ${mutation} configuration is isolated from a healthy sibling on startup`, async (t) => {
		const f = await persistenceFixture(t);
		const runtime = await f.runtime();
		const a = await runtime.createSession(f.cwd);
		const b = await runtime.createSession(f.cwd);
		await runtime.close();
		await f.edit(async (storage) => {
			const scope = {
				kind: "conversation" as const,
				conversationId: a.conversation.id,
			};
			if (mutation === "mapping" || mutation === "duplicate-mapping") {
				const record = await storage.findDocument(
					{ kind: MappingDoc.definition.kind, scope: { kind: "session" } },
					"current",
					context,
				);
				assert.ok(record);
				await commitWrites(
					storage,
					[
						{
							type: "document.change",
							id: record.id,
							content: {
								kind: "base",
								version: 1,
								value: {
									conversations: {
										[a.id]: a.conversation.id,
										[b.id]: b.conversation.id,
										...(mutation === "duplicate-mapping"
											? { [randomUUID()]: a.conversation.id }
											: { [a.id]: 999999 }),
									},
								},
							},
						},
					],
					context,
				);
				return;
			}
			const record = await storage.findDocument(
				{
					kind:
						mutation === "agent"
							? AgentDoc.definition.kind
							: ConversationDoc.definition.kind,
					scope,
				},
				"current",
				context,
			);
			assert.ok(record);
			if (mutation === "missing" || mutation === "agent") {
				await commitWrites(
					storage,
					[{ type: "document.retire", id: record.id }],
					context,
				);
				return;
			}
			await commitWrites(
				storage,
				[
					{
						type: "document.change",
						id: record.id,
						content: {
							kind: "base",
							version: mutation === "version" ? 2 : 1,
							value: { sessionId: a.id, skills: 42 },
						},
					},
				],
				context,
			);
		});
		const next = await f.runtime();
		await assert.rejects(next.loadSession(a.id, f.cwd), /incompatible/);
		const loaded = await next.loadSession(b.id, f.cwd);
		assert.equal(loaded.conversation.id, b.conversation.id);
		assert.equal(next.failed, false);
	});
}

test("missing workspace at startup blocks real tools but repair permits load and execution without restart", async (t) => {
	const f = await persistenceFixture(t);
	const first = await f.runtime();
	const a = await first.createSession(f.cwd);
	const siblingCwd = join(f.root, "sibling");
	await mkdir(siblingCwd);
	const b = await first.createSession(siblingCwd);
	await first.close();
	await rm(f.cwd, { recursive: true });
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	const next = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
		f.sessions,
	);
	t.after(() => next.close());
	await assert.rejects(next.loadSession(a.id, f.cwd), /workspace/);
	const sibling = await next.loadSession(b.id, siblingCwd);
	const native = await sibling.harness.conversation(a.conversation.id, context);
	assert.ok(native);
	async function run(conversation: typeof native, command: string) {
		assert.ok(conversation);
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const submission = await conversation.submit(
			{ type: "input", content: "run", whenBusy: "reject" },
			context,
		);
		await submission.wait(context);
	}
	await run(native, `printf unsafe > '${join(f.root, "unsafe")}'`);
	await assert.rejects(readFile(join(f.root, "unsafe")), /ENOENT/);
	await run(sibling.conversation, "printf sibling > sibling");
	assert.equal(await readFile(join(siblingCwd, "sibling"), "utf8"), "sibling");
	await mkdir(f.cwd);
	const repaired = await next.loadSession(a.id, f.cwd);
	await run(repaired.conversation, "printf repaired > repaired");
	assert.equal(await readFile(join(f.cwd, "repaired"), "utf8"), "repaired");
});

test("unknown UUID load does not create a conversation", async (t) => {
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	await assert.rejects(
		runtime.loadSession(randomUUID(), f.cwd),
		/Unknown saved session/,
	);
});

test("SDK repairs a torn final line but committed corruption and missing sidecars fail startup without memory fallback", async (t) => {
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	await runtime.createSession(f.cwd);
	await runtime.close();
	const path = pathFor(f.sessions);
	const before = await readFile(path);
	await appendFile(path, '{"PRIVATE_TORN');
	const next = await f.runtime();
	await next.close();
	assert.deepEqual(await readFile(path), before);
	await appendFile(path, "PRIVATE_CORRUPTION\n");
	await assert.rejects(
		f.runtime(),
		(error: Error) =>
			/Could not open shared/.test(error.message) &&
			!/PRIVATE/.test(error.message),
	);
	await writeFile(path, before);
	const directory = join(f.sessions, "db");
	const sidecar = (await readdir(directory)).find((name) =>
		name.startsWith("doc-"),
	);
	assert.ok(sidecar);
	await rm(join(directory, sidecar));
	await assert.rejects(f.runtime(), /Could not open shared/);
});

test("missing main file is not silently initialized over existing sidecars", async (t) => {
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	await runtime.createSession(f.cwd);
	await runtime.close();
	await rm(pathFor(f.sessions));
	await assert.rejects(f.runtime(), /incomplete/);
	assert.ok(!(await readdir(join(f.sessions, "db"))).includes("main.jsonl"));
});

for (const invalid of ["model", "cwd"] as const) {
	test(`Runtime startup recovers native work for three unattached conversations and isolates invalid saved ${invalid}`, {
		timeout: 5000,
	}, async (t) => {
		const f = await persistenceFixture(t);
		const store = await openSessionStore(f.sessions);
		const registry = createRegistry();
		const executed: number[] = [];
		const probe = defineTask({
			name: "test.runtime-recovery",
			version: 1,
			initial: () => ({ phase: "run" as const }),
			abort: async (_record, runtime, ctx) => {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "aborted" } }),
					ctx,
				);
			},
			phases: {
				run: async (record, runtime, ctx) => {
					const env = await runtime.env(ctx);
					assert.ok(env);
					executed.push(record.conversationId);
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status: "completed", result: {} },
						}),
						ctx,
					);
				},
			},
		});
		registry.install(defineExtension({ name: "probe", tasks: [probe] }));
		const models = createModels();
		models.setProvider(fauxProvider().provider);
		const seed = await Harness.open(
			await store.openStorage(),
			{ models, registry },
			context,
		);
		const saved = [];
		for (let i = 0; i < 3; i++) {
			const sessionId = randomUUID();
			const conversation = await seed.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: f.cwd },
					init: async (tx, conversationId) => {
						Object.assign(await tx.doc(ConversationDoc, conversationId), {
							sessionId,
							skills: "",
						});
						(await tx.doc(MappingDoc)).conversations[sessionId] =
							conversationId;
					},
				},
				context,
			);
			await conversation.commit(
				(tx) =>
					tx.createTask(probe, {}, { ownership: { kind: "conversation" } }),
				context,
			);
			saved.push(conversation);
		}
		// B/C must remain eligible without a client, even when A cannot recover.
		assert.ok(saved[0]);
		if (invalid === "model") {
			await saved[0].configure(
				{ model: { provider: "missing", modelId: "missing" } },
				context,
			);
		} else {
			const missingCwd = join(f.root, "missing-workspace");
			await saved[0].configure({ cwd: missingCwd }, context);
		}
		assert.equal((await seed.inspect(context)).scheduling, "paused");
		await seed.close(context);
		await store.close();
		const open = Harness.open;
		let native: Harness | undefined;
		t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
			const runtimeRegistry = args[1].registry as ReturnType<
				typeof createRegistry
			>;
			runtimeRegistry.install(
				defineExtension({ name: "probe", tasks: [probe] }),
			);
			native = await open(...args);
			return native;
		});
		const runtime = await Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{},
			f.sessions,
		);
		try {
			assert.ok(native);
			await native.waitForIdle(context);
			assert.deepEqual(
				executed.sort(),
				saved
					.slice(1)
					.map((c) => c.id)
					.sort(),
			);
			assert.equal(runtime.failed, false);
			assert.equal((await native.inspect(context)).tasks.length, 0);
			const metadata = await native.snapshot(
				ConversationDoc,
				saved[0].id,
				context,
			);
			assert.ok(metadata);
			await assert.rejects(
				runtime.loadSession(metadata.sessionId, f.cwd),
				/incompatible|workspace/,
			);
		} finally {
			await runtime.close();
		}
	});
}
