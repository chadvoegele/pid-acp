import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { ConversationIdle, Harness } from "@earendil-works/pi-durable";
import { Adapter } from "../dist/adapter.js";
import { logger } from "../dist/logger.js";
import { Runtime } from "../dist/runtime.js";

async function readySession() {
	const models = createModels();
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("ready answer")])]);
	models.setProvider(faux.provider);
	const runtime = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
	);
	const session = await runtime.createSession(tmpdir());
	return { runtime, session, faux };
}

test("Adapter accepts an already open Session and closes only that Session idempotently", async (t) => {
	const { runtime, session } = await readySession();
	t.after(() => runtime.close());
	const sibling = await runtime.createSession(tmpdir());
	t.after(() => sibling.close());
	const close = t.mock.method(session, "close");
	const abort = t.mock.method(session.conversation, "abort");
	const adapter = new Adapter(session);
	await adapter.attach(async () => {});
	const closed = adapter.close();
	assert.equal(adapter.close(), closed);
	await closed;
	assert.equal(close.mock.callCount(), 1);
	assert.equal(abort.mock.callCount(), 0);
	assert.equal(session.closed, true);
	assert.equal(sibling.closed, false);
});

test("session-bound prompt validates IDs, delivers output and rejects admission after close", async (t) => {
	const diagnostic = t.mock.method(logger, "error", () => {});
	const { runtime, session } = await readySession();
	const id = session.id;
	const adapter = new Adapter(session);
	t.after(async () => {
		await adapter.close();
		await runtime.close();
	});
	const content = "hello";
	const updates: import("@agentclientprotocol/sdk").SessionUpdate[] = [];
	const answer = Promise.withResolvers<void>();
	await assert.rejects(adapter.prompt("wrong", content), /Unknown session ID/);
	await assert.rejects(adapter.cancel("wrong"), /Unknown session ID/);
	await adapter.attach(async (update) => {
		updates.push(update);
		if (update.sessionUpdate === "agent_message_chunk") answer.resolve();
	});
	assert.deepEqual(await adapter.prompt(id, content), {
		stopReason: "end_turn",
	});
	await answer.promise;
	assert.ok(
		updates.some(
			(update) =>
				update.sessionUpdate === "agent_message_chunk" &&
				update.content.type === "text" &&
				update.content.text.includes("ready answer"),
		),
	);
	await adapter.close();
	await assert.rejects(adapter.prompt(id, content), /shutting down/);
	await assert.rejects(adapter.cancel(id), /shutting down/);
	assert.equal(diagnostic.mock.callCount(), 0);
});

test("steering does not report promptRequired after the attachment closes during idle admission", async (t) => {
	const { runtime, session } = await readySession();
	const adapter = new Adapter(session);
	t.after(async () => {
		await adapter.close();
		await runtime.close();
	});
	await adapter.attach(async () => {});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const submit = t.mock.method(session.conversation, "submit", async () => {
		entered.resolve();
		await release.promise;
		throw new ConversationIdle(session.conversation.id);
	});
	const steering = adapter.steer(session.id, "idle during close");
	await entered.promise;
	const closing = adapter.close();
	release.resolve();
	await assert.rejects(steering, /shutting down/);
	await closing;
	assert.equal(submit.mock.callCount(), 1);
});

test("submission completion and another admission are independent of a blocked attachment sink", {
	timeout: 5000,
}, async (t) => {
	const { runtime, session, faux } = await readySession();
	faux.appendResponses([fauxAssistantMessage("second answer")]);
	const adapter = new Adapter(session);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	const updates: import("@agentclientprotocol/sdk").SessionUpdate[] = [];
	t.after(async () => {
		release.resolve();
		await adapter.close();
		await runtime.close();
	});
	await adapter.attach(async (update) => {
		entered.resolve();
		await release.promise;
		updates.push(update);
		if (
			updates.filter((u) => u.sessionUpdate === "agent_message_chunk")
				.length === 2
		)
			delivered.resolve();
	});
	const prompt = (text: string) => adapter.prompt(session.id, text);
	const first = prompt("hello");
	await entered.promise;
	assert.equal((await first).stopReason, "end_turn");
	assert.equal(updates.length, 0);
	assert.equal((await prompt("next")).stopReason, "end_turn");
	assert.equal(updates.length, 0);
	release.resolve();
	await delivered.promise;
	assert.deepEqual(
		updates.map((u) => u.sessionUpdate),
		[
			"user_message_chunk",
			"agent_message_chunk",
			"user_message_chunk",
			"agent_message_chunk",
		],
	);
});
for (const failure of ["prompt", "storage"] as const) {
	test(`shared logger receives only sanitized ${failure} failure guidance`, async (t) => {
		const diagnostic = t.mock.method(logger, "error", () => {});
		const open = Harness.open;
		let report: import("@earendil-works/pi-durable").HarnessOptions["onReport"];
		t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
			report = args[1].onReport;
			return open(...args);
		});
		const { runtime, session } = await readySession();
		const adapter = new Adapter(session);
		t.after(async () => {
			await adapter.close();
			await runtime.close();
		});
		const privateError = new Error(
			"PRIVATE_ERROR_BODY key=PRIVATE_KEY transcript=PRIVATE_TRANSCRIPT",
		);
		await adapter.attach(async () =>
			assert.fail("Failed inspection must not emit updates"),
		);
		t.mock.method(session.harness, "inspect", async () => {
			if (failure === "storage")
				report?.({ error: privateError, kind: "storage_failed" });
			throw privateError;
		});
		await assert.rejects(
			adapter.prompt(session.id, "PRIVATE_PROMPT"),
			(error: Error) => {
				assert.match(
					error.message,
					failure === "storage" ? /Session storage failed/ : /Prompt failed/,
				);
				assert.doesNotMatch(error.message, /PRIVATE_/);
				return true;
			},
		);
		assert.deepEqual(
			diagnostic.mock.calls.map((call) => call.arguments),
			[
				[
					failure === "storage"
						? "pid-acp: Session storage failed; admission stopped. Check private session storage and available disk space."
						: "pid-acp: Prompt failed; check provider connectivity, model configuration and credentials.",
				],
			],
		);
	});
}

test("storage failure before submission result mapping cannot report saved success", {
	timeout: 5000,
}, async (t) => {
	const open = Harness.open;
	let report: Parameters<typeof open>[1]["onReport"];
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		report = args[1].onReport;
		return open(...args);
	});
	t.mock.method(logger, "error", () => {});
	const { runtime, session } = await readySession();
	const adapter = new Adapter(session);
	await adapter.attach(async () => {});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(async () => {
		release.resolve();
		await adapter.close();
		await runtime.close();
	});
	const submit = session.conversation.submit.bind(session.conversation);
	t.mock.method(
		session.conversation,
		"submit",
		async (...args: Parameters<typeof submit>) => {
			const submission = (await submit(
				...args,
			)) as unknown as import("@earendil-works/pi-durable").Submission;
			const wait = submission.wait.bind(submission);
			t.mock.method(
				submission,
				"wait",
				async (...waitArgs: Parameters<typeof wait>) => {
					const result = await wait(...waitArgs);
					entered.resolve();
					await release.promise;
					return result;
				},
			);
			return submission;
		},
	);
	const pending = adapter.prompt(session.id, "hello");
	await entered.promise;
	await session.conversation.waitForIdle(
		(await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
	);
	assert.ok(report);
	report({ kind: "storage_failed", error: new Error("PRIVATE_STORAGE") });
	const rejected = assert.rejects(pending, /Session storage failed/);
	release.resolve();
	await rejected;
});

test("Session exposes process-owned failure checks without an Adapter factory dependency", async (t) => {
	const open = Harness.open;
	let report: import("@earendil-works/pi-durable").HarnessOptions["onReport"];
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		report = args[1].onReport;
		return open(...args);
	});
	const { runtime, session } = await readySession();
	const id = session.id;
	const adapter = new Adapter(session);
	await adapter.attach(async () => {});
	t.after(async () => {
		await adapter.close();
		await runtime.close();
	});
	assert.equal(session.failed, false);
	report?.({ error: new Error("PRIVATE_STORAGE"), kind: "storage_failed" });
	assert.equal(session.failed, true);
	assert.equal(runtime.failed, true);
	await runtime.failure;
	await assert.rejects(adapter.prompt(id, "no input"), /shutting down/);
	await assert.rejects(adapter.cancel(id), /shutting down/);
});

test("cancel racing native admission is joined once and cannot cancel the next prompt", {
	timeout: 5000,
}, async (t) => {
	const { runtime, session } = await readySession();
	const adapter = new Adapter(session);
	await adapter.attach(async () => {});
	t.after(async () => {
		await adapter.close();
		await runtime.close();
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const submit = session.conversation.submit.bind(session.conversation);
	t.mock.method(
		session.conversation,
		"submit",
		async (...args: Parameters<typeof submit>) => {
			entered.resolve();
			await release.promise;
			return submit(...args);
		},
		{ times: 1 },
	);
	const abort = t.mock.method(session.conversation, "abort");
	const pending = adapter.prompt(session.id, "hello");
	await entered.promise;
	const cancelled = adapter.cancel(session.id);
	const twice = adapter.cancel(session.id);
	release.resolve();
	assert.equal((await pending).stopReason, "cancelled");
	await Promise.all([cancelled, twice]);
	assert.equal(abort.mock.callCount(), 1);
	await adapter.cancel(session.id);
	assert.equal(abort.mock.callCount(), 1);
	assert.equal(
		(await adapter.prompt(session.id, "next")).stopReason,
		"end_turn",
	);
	assert.equal(abort.mock.callCount(), 1);
});

test("close joins an in-flight admission without a user abort or cancelled response", {
	timeout: 5000,
}, async (t) => {
	const { runtime, session } = await readySession();
	const adapter = new Adapter(session);
	await adapter.attach(async () => {});
	t.after(async () => {
		await adapter.close();
		await runtime.close();
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const submit = session.conversation.submit.bind(session.conversation);
	t.mock.method(
		session.conversation,
		"submit",
		async (...args: Parameters<typeof submit>) => {
			entered.resolve();
			await release.promise;
			return submit(...args);
		},
	);
	const abort = t.mock.method(session.conversation, "abort");
	const pending = assert.rejects(
		adapter.prompt(session.id, "hello"),
		/Server stopped/,
	);
	await entered.promise;
	const closed = adapter.close();
	let settled = false;
	void closed.then(() => {
		settled = true;
	});
	await (await import("node:timers/promises")).setImmediate();
	assert.equal(settled, false);
	release.resolve();
	await closed;
	await pending;
	assert.equal(abort.mock.callCount(), 0);
	assert.equal(session.closed, true);
});

test("close stops delivery and releases attachment when recovered cancellation rejects", {
	timeout: 5000,
}, async (t) => {
	const { BACKGROUND_CONTEXT: context } = await import(
		"@earendil-works/chord/context"
	);
	const { runtime, session } = await readySession();
	const adapter = new Adapter(session);
	const watch = await session.conversation.watch(context);
	const stop = t.mock.method(watch, "stop");
	t.mock.method(session.conversation, "watch", async () => watch);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(async () => {
		release.resolve();
		await watch.stop();
		await runtime.close();
	});
	await adapter.attach(async () => {});
	t.mock.method(session.harness, "inspect", async () => {
		entered.resolve();
		await release.promise;
		throw new Error("PRIVATE_INSPECTION");
	});
	const cancelled = assert.rejects(
		adapter.cancel(session.id),
		(error: Error) => {
			assert.match(error.message, /Could not cancel session/);
			assert.doesNotMatch(error.message, /PRIVATE/);
			return true;
		},
	);
	await entered.promise;
	const closing = adapter.close();
	assert.equal(adapter.close(), closing);
	const closed = closing;
	release.resolve();
	await Promise.all([cancelled, closed]);
	assert.equal(stop.mock.callCount(), 1);
	assert.equal(session.closed, true);
});

test("blocked native work in a sibling does not prevent this conversation's prompt", async (t) => {
	const { runtime, session } = await readySession();
	const sibling = await runtime.createSession(
		(await import("node:os")).tmpdir(),
	);
	const adapter = new Adapter(session);
	await adapter.attach(async () => {});
	t.after(async () => {
		await adapter.close();
		await runtime.close();
	});
	const { defineTask } = await import("@earendil-works/pi-durable");
	const task = defineTask({
		name: "test.missing",
		version: 1,
		abort: async (_task, runtime, ctx) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "aborted" } }),
				ctx,
			);
		},
		initial: () => ({ phase: "prepare" as const }),
		phases: {
			prepare: async () => {
				throw new Error("must not run");
			},
		},
	});
	await sibling.conversation.commit(
		async (tx) => {
			await tx.createTask(task, {}, { ownership: { kind: "conversation" } });
		},
		(await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
	);
	assert.equal(
		(await adapter.prompt(session.id, "hello")).stopReason,
		"end_turn",
	);
});
