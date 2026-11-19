import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { client, type SessionUpdate } from "@agentclientprotocol/sdk";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../dist/runtime.js";
import { AcpServerFixture } from "./helpers/acp-server-fixture.ts";
import { Adapter } from "../dist/adapter.js";
import { persistenceFixture } from "./helpers/persistence.ts";
import { waitFor } from "./helpers/client.ts";

for (const failure of ["provider", "environment"] as const) {
	test(`real ${failure} failure in A leaves running B and later prompts usable`, {
		timeout: 5000,
	}, async (t) => {
		const f = await persistenceFixture(t);
		const aCwd = join(f.root, "a");
		await mkdir(aCwd);
		const enteredB = Promise.withResolvers<void>();
		const releaseB = Promise.withResolvers<void>();
		const provider = fauxProvider();
		let callsA = 0;
		provider.setResponses(
			Array.from({ length: 8 }, () => async (request) => {
				const user = request.messages.findLast(
					(message) => message.role === "user",
				);
				if (user?.content === "A") {
					callsA++;
					if (failure === "provider")
						throw new Error("PRIVATE_PROVIDER_FAILURE");
					const last = request.messages.at(-1);
					if (last?.role === "toolResult") {
						assert.equal(last.isError, true);
						assert.match(
							JSON.stringify(last.content),
							/workspace|configuration/i,
						);
						return fauxAssistantMessage("A environment failed locally");
					}
					return fauxAssistantMessage(
						fauxToolCall("write", { path: "must-not-exist", content: "A" }),
						{ stopReason: "toolUse" },
					);
				}
				if (request.messages.at(-1)?.role === "toolResult")
					return fauxAssistantMessage("B completed");
				enteredB.resolve();
				await releaseB.promise;
				return fauxAssistantMessage(
					fauxToolCall("write", { path: "healthy", content: "B only" }),
					{ stopReason: "toolUse" },
				);
			}),
		);
		const models = createModels();
		models.setProvider(provider.provider);
		const runtime = await Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{ instructionsPath: "", skillsDir: "" },
		);
		const a = await runtime.createSession(aCwd);
		const b = await runtime.createSession(f.cwd);
		const adapterA = new Adapter(a);
		await adapterA.attach(async () => {});
		const adapterB = new Adapter(b);
		await adapterB.attach(async () => {});
		t.after(async () => {
			releaseB.resolve();
			await Promise.all([adapterA.close(), adapterB.close()]);
			await runtime.close();
		});
		const prompt = (adapter: Adapter, sessionId: string, text: string) =>
			adapter.prompt(sessionId, text);
		const pendingB = prompt(adapterB, b.id, "B");
		void pendingB.catch(() => {});
		await enteredB.promise;
		if (failure === "environment") await rm(aCwd, { recursive: true });
		if (failure === "provider") {
			await assert.rejects(
				prompt(adapterA, a.id, "A"),
				(error: Error) =>
					/Prompt failed/.test(error.message) && !/PRIVATE/.test(error.message),
			);
		} else {
			assert.equal((await prompt(adapterA, a.id, "A")).stopReason, "end_turn");
			assert.equal(existsSync(join(aCwd, "must-not-exist")), false);
		}
		assert.equal(callsA, failure === "provider" ? 1 : 2);
		assert.equal(runtime.failed, false);
		releaseB.resolve();
		assert.equal((await pendingB).stopReason, "end_turn");
		assert.equal(
			(await prompt(adapterB, b.id, "B again")).stopReason,
			"end_turn",
		);
		assert.equal(await readFile(join(f.cwd, "healthy"), "utf8"), "B only");
		assert.ok(
			!JSON.stringify(
				(await b.conversation.context(context)).messages,
			).includes("PRIVATE"),
		);
	});
}

for (const equalCwd of [false, true]) {
	test(`ACP routes parallel providers and real bash with reused tool IDs (equal cwd: ${equalCwd})`, {
		timeout: 5000,
	}, async (t) => {
		const f = await persistenceFixture(t);
		const bCwd = equalCwd ? f.cwd : join(f.root, "b");
		if (!equalCwd) await mkdir(bCwd);
		const both = Promise.withResolvers<void>();
		let entered = 0;
		const provider = fauxProvider();
		const step: Parameters<typeof provider.setResponses>[0][number] = async (
			request,
		) => {
			const user = request.messages.find((message) => message.role === "user");
			assert.ok(user?.role === "user" && typeof user.content === "string");
			const label = user.content;
			if (++entered === 2) both.resolve();
			await both.promise;
			return fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: `printf ${label} > ${label}.txt; touch '${join(f.root, `ready-${label}`)}'; while [ ! -e '${join(f.root, `ready-${label === "A" ? "B" : "A"}`)}' ]; do sleep 0.01; done; cat ${label}.txt`,
					},
					{ id: "same-call" },
				),
				{ stopReason: "toolUse" },
			);
		};
		provider.setResponses([
			step,
			step,
			fauxAssistantMessage("done"),
			fauxAssistantMessage("done"),
			step,
			fauxAssistantMessage("again"),
		]);
		const models = createModels();
		models.setProvider(provider.provider);
		const runtime = await Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{ instructionsPath: "", skillsDir: "" },
		);
		const server = new AcpServerFixture(runtime);
		const updates: { sessionId: string; update: SessionUpdate }[] = [];
		const connection = client()
			.onNotification("session/update", ({ params }) => {
				updates.push(params);
			})
			.connect(server.createApp());
		t.after(async () => {
			connection.close();
			await server.close();
		});
		const [a, b] = await Promise.all([
			connection.agent.request("session/new", { cwd: f.cwd, mcpServers: [] }),
			connection.agent.request("session/new", { cwd: bCwd, mcpServers: [] }),
		]);
		assert.notEqual(a.sessionId, b.sessionId);
		const prompt = (sessionId: string, text: string) =>
			connection.agent.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text }],
			});
		const pending = [prompt(a.sessionId, "A"), prompt(b.sessionId, "B")];
		await both.promise;
		await assert.rejects(prompt(a.sessionId, "DO_NOT_QUEUE"), /already active/);
		assert.ok(
			(await Promise.all(pending)).every(
				(result) => result.stopReason === "end_turn",
			),
		);
		assert.equal(await readFile(join(f.cwd, "A.txt"), "utf8"), "A");
		assert.equal(await readFile(join(bCwd, "B.txt"), "utf8"), "B");
		for (const id of [a.sessionId, b.sessionId]) {
			const own = updates
				.filter((item) => item.sessionId === id)
				.map((item) => item.update);
			assert.equal(
				own.filter(
					(update) =>
						update.sessionUpdate === "tool_call" &&
						update.toolCallId === "same-call",
				).length,
				1,
			);
			assert.equal(
				own.filter(
					(update) =>
						update.sessionUpdate === "tool_call_update" &&
						update.status === "completed",
				).length,
				1,
			);
		}
		await assert.rejects(prompt("stale", "no allocation"), /Unknown session/);
		await connection.agent.notify("session/cancel", { sessionId: "stale" });
		assert.equal((await prompt(b.sessionId, "next")).stopReason, "end_turn");
		assert.equal(
			updates.filter(
				(item) =>
					item.sessionId === b.sessionId &&
					item.update.sessionUpdate === "tool_call" &&
					item.update.toolCallId === "same-call",
			).length,
			2,
			"one attachment watch resets correlation at the next native input",
		);
	});
}

test("attached recovered A can cancel without a new prompt while B completes and accepts another", {
	timeout: 5000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const provider = fauxProvider();
	const started = Promise.withResolvers<void>();
	provider.setResponses([
		async (_request, options) => {
			started.resolve();
			await new Promise<void>((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
			throw new Error("aborted");
		},
		fauxAssistantMessage("B done"),
		fauxAssistantMessage("B again"),
		fauxAssistantMessage("A again"),
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	const runtime = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
		f.sessions,
	);
	const a = await runtime.createSession(f.cwd);
	const b = await runtime.createSession(f.cwd);
	const recovered = await a.conversation.submit(
		{ type: "input", content: "recovered" },
		context,
	);
	await started.promise;
	const adapter = new Adapter(a);
	const sibling = new Adapter(b);
	await sibling.attach(async () => {});
	t.after(async () => {
		await Promise.all([adapter.close(), sibling.close()]);
		await runtime.close();
	});
	await adapter.attach(async () => {}, true);
	const abortA = t.mock.method(a.conversation, "abort");
	const abortB = t.mock.method(b.conversation, "abort");
	const prompt = (target: Adapter, sessionId: string, text: string) =>
		target.prompt(sessionId, text);
	await assert.rejects(prompt(adapter, a.id, "DO_NOT_QUEUE"), /already active/);
	// Race the authoritative native rejection, even if the preceding inspection was idle.
	const inspect = a.harness.inspect.bind(a.harness);
	t.mock.method(
		a.harness,
		"inspect",
		async (...args: Parameters<typeof inspect>) => ({
			...(await inspect(...args)),
			tasks: [],
		}),
		{ times: 1 },
	);
	const entering = Promise.withResolvers<void>();
	const releaseAdmission = Promise.withResolvers<void>();
	t.after(() => releaseAdmission.resolve());
	const submit = a.conversation.submit.bind(a.conversation);
	t.mock.method(
		a.conversation,
		"submit",
		async (...args: Parameters<typeof submit>) => {
			entering.resolve();
			await releaseAdmission.promise;
			return submit(...args);
		},
		{ times: 1 },
	);
	const rejected = assert.rejects(
		prompt(adapter, a.id, "ALSO_DO_NOT_QUEUE"),
		/already active/,
	);
	await entering.promise;
	const racingCancel = adapter.cancel(a.id);
	releaseAdmission.resolve();
	await rejected;
	await racingCancel;
	assert.equal(
		abortA.mock.callCount(),
		1,
		"session cancellation targets recovered work even when fresh admission rejects",
	);
	assert.equal((await prompt(sibling, b.id, "B")).stopReason, "end_turn");
	await adapter.cancel(a.id);
	assert.equal((await recovered.wait(context)).status, "unanswered");
	assert.equal(abortA.mock.callCount(), 1);
	assert.equal(abortB.mock.callCount(), 0);
	assert.equal((await prompt(sibling, b.id, "again")).stopReason, "end_turn");
	assert.equal((await prompt(adapter, a.id, "again")).stopReason, "end_turn");
	await adapter.cancel(a.id);
	assert.equal(abortA.mock.callCount(), 1, "idle cancellation must not abort");
	const history = await a.conversation.context(context);
	assert.ok(!JSON.stringify(history.messages).includes("DO_NOT_QUEUE"));
});

for (const settleBeforeWatch of [false, true]) {
	test(`load during real bash defers synthetic missing results (settled before watch: ${settleBeforeWatch})`, {
		timeout: 5000,
	}, async (t) => {
		const f = await persistenceFixture(t);
		const release = join(f.cwd, "release");
		const running = join(f.cwd, "running");
		const provider = fauxProvider();
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: `touch '${running}'; while [ ! -e '${release}' ]; do sleep 0.01; done; printf tool-result`,
					},
					{ id: "running-call" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("finished"),
		]);
		const models = createModels();
		models.setProvider(provider.provider);
		const runtime = await Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{ instructionsPath: "", skillsDir: "" },
			f.sessions,
		);
		const session = await runtime.createSession(f.cwd);
		const attached = await runtime.loadSession(session.id, f.cwd);
		const adapter = new Adapter(attached);
		t.after(async () => {
			await writeFile(release, "release").catch(() => {});
			await adapter.close();
			await runtime.close();
		});
		await session.conversation.submit(
			{ type: "input", content: "go" },
			context,
		);
		await waitFor(() => existsSync(running));
		if (settleBeforeWatch) {
			const snapshot = attached.conversation.context.bind(
				attached.conversation,
			);
			t.mock.method(
				attached.conversation,
				"context",
				async () => {
					const value = await snapshot(context);
					await writeFile(release, "release");
					await session.conversation.waitForIdle(context);
					return value;
				},
				{ times: 1 },
			);
		}
		const updates: SessionUpdate[] = [];
		await adapter.attach(async (update) => {
			updates.push(update);
		}, true);
		assert.equal(
			updates.filter(
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.status === "failed",
			).length,
			0,
		);
		await writeFile(release, "release");
		await session.conversation.waitForIdle(context);
		await waitFor(() =>
			updates.some(
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					update.status === "completed",
			),
		);
		assert.equal(
			updates.filter((update) => update.sessionUpdate === "tool_call").length,
			1,
		);
		assert.deepEqual(
			updates.flatMap((update) =>
				update.sessionUpdate === "tool_call_update" &&
				(update.status === "completed" || update.status === "failed")
					? [update.status]
					: [],
			),
			["completed"],
		);
	});
}

test("delivery loss and attachment close do not abort native execution", {
	timeout: 5000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const provider = fauxProvider();
	const release = join(f.cwd, "release");
	const running = join(f.cwd, "running");
	provider.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", {
				command: `touch '${running}'; while [ ! -e '${release}' ]; do sleep 0.01; done; printf native-output`,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("native answer"),
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	const runtime = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
	);
	const session = await runtime.createSession(f.cwd);
	const adapter = new Adapter(session);
	t.after(async () => {
		await writeFile(release, "release").catch(() => {});
		await adapter.close();
		await runtime.close();
	});
	const abort = t.mock.method(session.conversation, "abort");
	await adapter.attach(async () => {
		throw new Error("PRIVATE_SINK");
	});
	const pending = assert.rejects(
		adapter.prompt(session.id, "go"),
		/Server stopped/,
	);
	await pending;
	await waitFor(() => existsSync(running));
	assert.ok(
		(await session.harness.inspect(context)).tasks.some(
			(task) => task.record.conversationId === session.conversation.id,
		),
	);
	await adapter.close();
	await writeFile(release, "release");
	await session.conversation.waitForIdle(context);
	assert.equal(abort.mock.callCount(), 0);
	assert.match(
		JSON.stringify((await session.conversation.context(context)).messages),
		/native answer/,
	);
	await waitFor(() => session.closed);
});
