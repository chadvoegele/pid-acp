import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	Harness,
	createRegistry,
	defineExtension,
	defineTask,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

for (const activation of [
	"resume",
	"waitForIdle",
	"submit",
	"abort",
] as const) {
	test(`Durable ${activation} enables harness-wide recovery across conversations`, {
		timeout: 5000,
	}, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "pid-acp-recovery-"));
		let openedHarness: Awaited<ReturnType<typeof Harness.open>> | undefined;
		t.after(async () => {
			try {
				await openedHarness?.close(context);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
		const executed: number[] = [];
		const dormantRan = Promise.withResolvers<void>();
		let dormantId: number | undefined;
		const task = defineTask({
			name: "test.recovery-probe",
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
					executed.push(record.conversationId);
					if (record.conversationId === dormantId) dormantRan.resolve();
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
		const registry = createRegistry();
		registry.install(defineExtension({ name: "probe", tasks: [task] }));
		const options = { models: createModels(), registry };
		const path = join(directory, "main.jsonl");
		const seed = await Harness.open(
			await openNodeJsonlStorage(path, context),
			options,
			context,
		);
		openedHarness = seed;
		const a = await seed.createConversation(
			{ ownership: { kind: "ownerless" } },
			context,
		);
		const b = await seed.createConversation(
			{ ownership: { kind: "ownerless" } },
			context,
		);
		dormantId = b.id;
		for (const conversation of [a, b]) {
			await conversation.commit(
				(tx) =>
					tx.createTask(task, {}, { ownership: { kind: "conversation" } }),
				context,
			);
		}
		assert.equal((await seed.inspect(context)).scheduling, "paused");
		await seed.close(context);
		const reopened = await Harness.open(
			await openNodeJsonlStorage(path, context),
			options,
			context,
		);
		openedHarness = reopened;
		assert.equal((await reopened.inspect(context)).scheduling, "paused");
		assert.equal(executed.length, 0);
		const selected = await reopened.conversation(a.id, context);
		assert.ok(selected);
		if (activation === "resume") {
			reopened.resume();
		} else if (activation === "submit") {
			const submission = await selected.submit(
				{ type: "input", content: "probe" },
				context,
			);
			await submission.wait(context);
		} else {
			await selected[activation](context);
		}
		await dormantRan.promise;
		assert.ok(
			executed.includes(b.id),
			"Harness-wide activation must recover B without client attachment or input to B.",
		);
	});
}
