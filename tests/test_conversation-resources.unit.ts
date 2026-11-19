import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { ConversationDoc, MappingDoc } from "../dist/conversation-resources.js";
import { captureEnvironmentFactory } from "./helpers/environments.ts";
import { persistenceFixture } from "./helpers/persistence.ts";

test("environment selection ignores caller cwd and uses committed per-conversation metadata", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const env = await environmentFor(a, "/untrusted-not-a-workspace");
	assert.ok(env);
	assert.equal(env.cwd, f.cwd);
});

test("failed environment construction can retry after workspace repair and retains per-conversation ownership", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const b = await runtime.createSession(f.cwd);
	await rm(f.cwd, { recursive: true });
	await assert.rejects(environmentFor(a, f.cwd), /configuration/);
	await mkdir(f.cwd);
	const [first, duplicate, sibling] = await Promise.all([
		environmentFor(a, f.cwd),
		environmentFor(a, f.cwd),
		environmentFor(b, f.cwd),
	]);
	assert.ok(first && sibling);
	assert.equal(first, duplicate);
	assert.notEqual(first, sibling);
	assert.equal(runtime.failed, false);
});

test("missing metadata never falls back to agent cwd or process cwd", async (t) => {
	const f = await persistenceFixture(t);
	let factory: HarnessOptions["env"];
	const open = Harness.open;
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		factory = args[1].env;
		return open(...args);
	});
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const rogue = await a.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: f.cwd },
		},
		context,
	);
	assert.ok(factory);
	await assert.rejects(
		Promise.resolve(
			factory(
				{ conversationId: rogue.id, cwd: process.cwd(), read: a.harness },
				context,
			),
		),
		/configuration/,
	);
});

test("skills section reads requesting conversation metadata rather than a mutable shared catalog", async (t) => {
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const b = await runtime.createSession(f.cwd);
	for (const [session, skills] of [
		[a, "CATALOG_A"],
		[b, "CATALOG_B"],
	] as const)
		await session.conversation.commit(async (tx) => {
			(await tx.doc(ConversationDoc, session.conversation.id)).skills = skills;
		}, context);
	for (const [session, expected] of [
		[a, "CATALOG_A"],
		[b, "CATALOG_B"],
		[a, "CATALOG_A"],
	] as const) {
		const agent = await session.conversation.agent(context);
		const skills = agent.sections.find((section) => section.key === "skills");
		assert.ok(skills);
		assert.equal(
			await skills.render(
				{
					conversationId: session.conversation.id,
					agent,
					env: undefined,
					shown: {},
					read: session.harness,
				},
				context,
			),
			expected,
		);
	}
});

test("environment construction requires matching durable external/internal identity", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const b = await runtime.createSession(f.cwd);
	await a.harness.commit(async (tx) => {
		(await tx.doc(MappingDoc)).conversations[a.id] = b.conversation.id;
	}, context);
	await assert.rejects(environmentFor(a, f.cwd), /configuration/);
});
