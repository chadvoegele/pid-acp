import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { captureEnvironmentFactory } from "./helpers/environments.ts";
import { persistenceFixture } from "./helpers/persistence.ts";

test("attachment exposes native tools but never owns Harness, environments or abort", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const b = await runtime.createSession(f.cwd);
	const agent = await a.conversation.agent(context);
	assert.deepEqual(
		agent.tools.map((tool) => tool.name),
		["bash", "read", "edit", "write", "codemode"],
	);
	assert.deepEqual(
		agent.tools.map((tool) => tool.replay ?? "unsafe"),
		["unsafe", "unsafe", "unsafe", "unsafe", "safe"],
	);
	const [first, duplicate, second] = await Promise.all([
		environmentFor(a, f.cwd),
		environmentFor(a, f.cwd),
		environmentFor(b, f.cwd),
	]);
	assert.ok(first && second);
	assert.equal(first, duplicate);
	assert.notEqual(first, second);
	const abort = t.mock.method(a.conversation, "abort");
	const nativeClose = t.mock.method(a.harness, "close");
	const cleanup = t.mock.method(NodeExecutionEnv.prototype, "cleanup");
	const closing = a.close();
	assert.equal(a.close(), closing);
	await closing;
	assert.equal(a.closed, true);
	assert.equal(b.closed, false);
	assert.equal(abort.mock.callCount(), 0);
	assert.equal(nativeClose.mock.callCount(), 0);
	assert.equal(cleanup.mock.callCount(), 0);
	assert.ok(await a.conversation.agent(context));
	await runtime.close();
	assert.equal(nativeClose.mock.callCount(), 1);
	assert.equal(cleanup.mock.callCount(), 2);
	assert.equal(abort.mock.callCount(), 0);
	await assert.rejects(b.conversation.agent(context));
});

test("shutdown joins Harness before attempting all environment cleanup, and releases lock after cleanup failure", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const b = await runtime.createSession(f.cwd);
	const first = await environmentFor(a, f.cwd);
	const second = await environmentFor(b, f.cwd);
	assert.ok(first && second);
	const order: string[] = [];
	const close = a.harness.close.bind(a.harness);
	t.mock.method(
		a.harness,
		"close",
		async (ctx: Parameters<typeof close>[0]) => {
			await close(ctx);
			order.push("native");
		},
	);
	t.mock.method(first, "cleanup", async () => {
		order.push("first");
		throw new Error("first failed");
	});
	const cleanup = second.cleanup.bind(second);
	t.mock.method(
		second,
		"cleanup",
		async (ctx: Parameters<typeof cleanup>[0]) => {
			order.push("second");
			await cleanup(ctx);
		},
	);
	await assert.rejects(runtime.close(), /Could not release shared/);
	assert.deepEqual(order, ["native", "first", "second"]);
	await f.runtime();
	t.mock.method(runtime, "close", async () => {});
});

test("newly allocated environments during native close are cleaned without calling abort", async (t) => {
	const environmentFor = captureEnvironmentFactory(t);
	const f = await persistenceFixture(t);
	const runtime = await f.runtime();
	const a = await runtime.createSession(f.cwd);
	const close = a.harness.close.bind(a.harness);
	const cleanup = t.mock.method(NodeExecutionEnv.prototype, "cleanup");
	t.mock.method(
		a.harness,
		"close",
		async (ctx: Parameters<typeof close>[0]) => {
			await environmentFor(a, f.cwd);
			await close(ctx);
		},
	);
	const abort = t.mock.method(a.conversation, "abort");
	await runtime.close();
	assert.equal(cleanup.mock.callCount(), 1);
	assert.equal(abort.mock.callCount(), 0);
});
