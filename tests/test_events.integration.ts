import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	Harness,
	LiveDoc,
	MemoryStorage,
	ToolTask,
	GenerationTask,
	createRegistry,
	defineExtension,
	hook,
	type LiveState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { EventBridge } from "../dist/events.js";
import {
	readStatus,
	readToolId,
	readToolText,
	requireToolUpdate,
} from "./helpers/updates.ts";

for (const outcome of ["success", "error", "fault", "cancel"] as const) {
	test(`backpressured native watch preserves ${outcome} terminal status across tool rounds`, {
		timeout: 10000,
	}, async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), "pid-acp-events-"));
		const env = new NodeExecutionEnv({ cwd });
		const models = createModels();
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command:
							outcome === "cancel"
								? "printf partial; sleep 60"
								: `printf partial; exit ${outcome === "error" ? 3 : 0}`,
					},
					{ id: "first" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "printf second" }, { id: "second" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("finished"),
		]);
		models.setProvider(faux.provider);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		const terminalEntered = Promise.withResolvers<void>();
		const releaseTerminal = Promise.withResolvers<void>();
		const rounds: LiveState[] = [];
		const registry = createRegistry();
		registry.install(
			defineExtension({
				name: "test",
				tools: [createBashTool()],
				hooks: [
					hook(ToolTask, {
						afterTool: async (call, result) => {
							if (call.id !== "first") return;
							await entered.promise;
							// Non-JSON details fault native settlement after real bash execution.
							if (outcome === "fault")
								return { ...result, details: Number.NaN };
						},
					}),
					hook(GenerationTask, {
						afterTools: async (_assistant, _results, api, ctx) => {
							const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
							assert.ok(live);
							rounds.push(live);
						},
					}),
				],
			}),
		);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, env: () => env },
			context,
		);
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "faux", modelId: "faux-1" }, cwd },
			},
			context,
		);
		const watch = await conversation.watch(context);
		t.after(async () => {
			release.resolve();
			releaseTerminal.resolve();
			await watch.stop();
			await conversation.abort(context);
			await harness.close(context);
			await env.cleanup(context);
			await rm(cwd, { recursive: true, force: true });
		});
		const updates: SessionUpdate[] = [];
		const bridge = new EventBridge(watch.value.entries, async (update) => {
			updates.push(update);
			if (
				update.sessionUpdate === "tool_call" &&
				update.toolCallId === "first"
			) {
				entered.resolve();
				await release.promise;
			}
			if (
				readToolId(update) === "first" &&
				["failed", "completed"].includes(readStatus(update) ?? "")
			) {
				terminalEntered.resolve();
				await releaseTerminal.promise;
			}
		});
		let finishedDelivery = false;
		watch.start(async (call) => {
			try {
				if (call.kind !== "value") throw call.error;
				await bridge.accept(call.value);
				const live = call.value.docs["pi.live"] as LiveState | undefined;
				if (updates.length && !live?.run) {
					finishedDelivery = true;
					delivered.resolve();
				}
			} catch (error) {
				delivered.reject(error);
			}
		});
		const submission = await conversation.submit(
			{ type: "input", content: "run tools" },
			context,
		);
		await entered.promise;
		if (outcome === "cancel") await conversation.abort(context);
		await submission.wait(context);
		await conversation.waitForIdle(context);
		assert.equal(finishedDelivery, false);
		if (outcome !== "cancel") {
			assert.equal(rounds.length, 2);
			const slot = rounds[0]?.tools?.[0];
			assert.equal(slot?.status, "done");
			assert.equal(slot?.entry === undefined, outcome === "fault");
			assert.ok(slot?.taskId);
			const task = await harness.getTask(slot.taskId, context);
			assert.equal(task?.state.status, "terminal");
			if (task?.state.status === "terminal") {
				assert.equal(
					task.state.outcome.status,
					outcome === "fault" ? "faulted" : "completed",
				);
				t.diagnostic(
					`native ${outcome}: task=${task.state.outcome.status}, slot=${slot.status}, resultEntry=${slot.entry !== undefined}`,
				);
			}
		}
		release.resolve();
		assert.equal(
			await Promise.race([
				terminalEntered.promise.then(() => "terminal"),
				delivered.promise.then(() => "idle"),
			]),
			"terminal",
			"Idle must not leave a tool in progress",
		);
		assert.equal(
			finishedDelivery,
			false,
			"Terminal delivery must finish before idle presentation completes",
		);
		releaseTerminal.resolve();
		await delivered.promise;
		for (const id of outcome === "cancel" ? ["first"] : ["first", "second"]) {
			const terminal = updates.filter(
				(update) =>
					readToolId(update) === id &&
					["failed", "completed"].includes(readStatus(update) ?? ""),
			);
			assert.equal(terminal.length, 1);
			assert.equal(
				readStatus(terminal[0]),
				id === "second" || outcome === "success" ? "completed" : "failed",
			);
			if (outcome === "fault" && id === "first") {
				assert.equal(requireToolUpdate(terminal[0]).rawOutput, undefined);
			} else {
				assert.ok(requireToolUpdate(terminal[0]).rawOutput);
				assert.match(
					readToolText(terminal[0]),
					id === "second"
						? /second/
						: outcome === "cancel"
							? /aborted/
							: /partial/,
				);
			}
		}
	});
}
