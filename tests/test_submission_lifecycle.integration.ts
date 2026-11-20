import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, type Submission } from "@earendil-works/pi-durable";
import { Adapter } from "../dist/adapter.js";
import { Runtime } from "../dist/runtime.js";
import { readText, readStatus } from "./helpers/updates.ts";

async function fixture(t: TestContext, responses: FauxResponseStep[]) {
	const provider = fauxProvider();
	provider.setResponses(responses);
	const models = createModels();
	models.setProvider(provider.provider);
	const runtime = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
	);
	const session = await runtime.createSession(tmpdir());
	const adapter = new Adapter(session);
	t.after(async () => {
		await adapter.close();
		await runtime.close();
	});
	const prompt = (text = "input") => adapter.prompt(session.id, text);
	return { session, adapter, prompt };
}

function holdSubmissionResult(
	t: TestContext,
	session: Awaited<ReturnType<typeof fixture>>["session"],
) {
	const terminal = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const submit = session.conversation.submit.bind(session.conversation);
	t.mock.method(
		session.conversation,
		"submit",
		async (...args: Parameters<typeof submit>) => {
			const handle = (await submit(...args)) as unknown as Submission;
			const wait = handle.wait.bind(handle);
			t.mock.method(
				handle,
				"wait",
				async (...args: Parameters<typeof wait>) => {
					const result = await wait(...args);
					terminal.resolve();
					await release.promise;
					return result;
				},
			);
			return handle;
		},
		{ times: 1 },
	);
	return { terminal: terminal.promise, release: release.resolve };
}

test("slow tool sink does not gate submission; terminal and final message arrive once in attachment order", {
	timeout: 5000,
}, async (t) => {
	const { adapter, prompt } = await fixture(t, [
		fauxAssistantMessage(
			fauxToolCall(
				"bash",
				{ command: "printf lifecycle-output" },
				{ id: "lifecycle-tool" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("final answer"),
	]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const final = Promise.withResolvers<void>();
	const updates: SessionUpdate[] = [];
	t.after(() => release.resolve());
	await adapter.attach(async (update) => {
		if (update.sessionUpdate === "tool_call") {
			entered.resolve();
			await release.promise;
		}
		updates.push(update);
		if (readText(update) === "final answer") final.resolve();
	});
	const pending = prompt();
	await entered.promise;
	assert.equal((await pending).stopReason, "end_turn");
	assert.equal(updates.filter((u) => readStatus(u) === "completed").length, 0);
	release.resolve();
	await final.promise;
	assert.equal(
		updates.filter((u) => u.sessionUpdate === "tool_call").length,
		1,
	);
	assert.equal(updates.filter((u) => readStatus(u) === "completed").length, 1);
	const tool = updates.findIndex((u) => u.sessionUpdate === "tool_call");
	const terminal = updates.findIndex((u) => readStatus(u) === "completed");
	assert.ok(tool < terminal && terminal < updates.length - 1);
	assert.match(JSON.stringify(updates[terminal]), /lifecycle-output/);
});

test("overlapping ACP prompt waits for its own turn while passive output needs no ACP prompt", {
	timeout: 5000,
}, async (t) => {
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const secondStarted = Promise.withResolvers<void>();
	const releaseSecond = Promise.withResolvers<void>();
	t.after(() => {
		releaseFirst.resolve();
		releaseSecond.resolve();
	});
	const { session, adapter, prompt } = await fixture(t, [
		async () => {
			firstStarted.resolve();
			await releaseFirst.promise;
			return fauxAssistantMessage("first answer");
		},
		async () => {
			secondStarted.resolve();
			await releaseSecond.promise;
			return fauxAssistantMessage("queued answer");
		},
	]);
	const updates: SessionUpdate[] = [];
	const passiveDelivered = Promise.withResolvers<void>();
	await adapter.attach(async (u) => {
		updates.push(u);
		if (readText(u) === "passive answer") passiveDelivered.resolve();
	});
	const first = prompt("first input");
	await firstStarted.promise;
	let queuedReturned = false;
	const queued = prompt("queued input").then((result) => {
		queuedReturned = true;
		return result;
	});
	releaseFirst.resolve();
	await secondStarted.promise;
	assert.equal((await first).stopReason, "end_turn");
	assert.equal(queuedReturned, false);
	releaseSecond.resolve();
	assert.equal((await queued).stopReason, "end_turn");
	await session.conversation.submit(
		{
			type: "write",
			entry: {
				kind: AssistantEntry.kind,
				model: [fauxAssistantMessage("passive answer")],
			},
		},
		context,
	);
	await passiveDelivered.promise;
	assert.deepEqual(
		updates
			.filter((u) => u.sessionUpdate === "user_message_chunk")
			.map((u) => (u.content.type === "text" ? u.content.text : "")),
		["first input", "queued input"],
	);
	assert.deepEqual(updates.map(readText).filter(Boolean), [
		"first answer",
		"queued answer",
		"passive answer",
	]);
});

test("cancel joins only the send captured at receipt, not later watch output", {
	timeout: 5000,
}, async (t) => {
	const running = Promise.withResolvers<void>();
	const { session, adapter, prompt } = await fixture(t, [
		async (_request, options) => {
			running.resolve();
			await new Promise<void>((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
			throw new Error("aborted");
		},
	]);
	const held = holdSubmissionResult(t, session);
	const firstSend = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const laterSend = Promise.withResolvers<void>();
	const releaseLater = Promise.withResolvers<void>();
	t.after(() => {
		releaseFirst.resolve();
		releaseLater.resolve();
	});
	await adapter.attach(async (u) => {
		if (u.sessionUpdate === "user_message_chunk") {
			firstSend.resolve();
			await releaseFirst.promise;
		}
		if (readText(u) === "late output") {
			laterSend.resolve();
			await releaseLater.promise;
		}
	});
	let returned = false;
	const pending = prompt().then((result) => {
		returned = true;
		return result;
	});
	await Promise.all([running.promise, firstSend.promise]);
	const cancelled = adapter.cancel(session.id);
	await held.terminal;
	held.release();
	await setImmediate();
	assert.equal(
		returned,
		false,
		"aborted original prompt joins the captured pending send",
	);
	await session.conversation.submit(
		{
			type: "write",
			entry: {
				kind: AssistantEntry.kind,
				model: [fauxAssistantMessage("late output")],
			},
		},
		context,
	);
	releaseFirst.resolve();
	assert.equal((await pending).stopReason, "cancelled");
	await cancelled;
	await laterSend.promise;
	assert.equal(
		returned,
		true,
		"future notification sends do not extend the cancellation boundary",
	);
});

test("late and repeated cancel never override native done or abort the next turn", {
	timeout: 5000,
}, async (t) => {
	const { session, adapter, prompt } = await fixture(t, [
		fauxAssistantMessage("done"),
		fauxAssistantMessage("next"),
	]);
	const send = Promise.withResolvers<void>();
	const releaseSink = Promise.withResolvers<void>();
	t.after(() => releaseSink.resolve());
	await adapter.attach(async () => {
		send.resolve();
		await releaseSink.promise;
	});
	const held = holdSubmissionResult(t, session);
	const abort = t.mock.method(session.conversation, "abort");
	const first = prompt();
	await Promise.all([held.terminal, send.promise]);
	const cancelled = Promise.all([
		adapter.cancel(session.id),
		adapter.cancel(session.id),
	]);
	held.release();
	assert.equal((await first).stopReason, "end_turn");
	assert.equal((await prompt("next")).stopReason, "end_turn");
	releaseSink.resolve();
	await cancelled;
	assert.equal(abort.mock.callCount(), 0);
});

test("close releases a hung presentation and pending request without native abort", {
	timeout: 5000,
}, async (t) => {
	const running = Promise.withResolvers<void>();
	const releaseNative = Promise.withResolvers<void>();
	t.after(() => releaseNative.resolve());
	const { session, adapter, prompt } = await fixture(t, [
		async () => {
			running.resolve();
			await releaseNative.promise;
			return fauxAssistantMessage("native success after detach");
		},
	]);
	const send = Promise.withResolvers<void>();
	const releaseSink = Promise.withResolvers<void>();
	t.after(() => releaseSink.resolve());
	await adapter.attach(async () => {
		send.resolve();
		await releaseSink.promise;
	});
	const abort = t.mock.method(session.conversation, "abort");
	const pending = assert.rejects(prompt(), /Server stopped/);
	await Promise.all([send.promise, running.promise]);
	await adapter.close();
	await pending;
	assert.equal(session.closed, true);
	releaseNative.resolve();
	await session.conversation.waitForIdle(context);
	assert.match(
		JSON.stringify((await session.conversation.context(context)).messages),
		/native success after detach/,
	);
	assert.equal(abort.mock.callCount(), 0);
});
