import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, ToolTaskInput } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

export async function readNativeToolTrace(sessions: string, callId: string) {
	const storage = await openNodeJsonlStorage(join(sessions, "db"), context, {
		readOnly: true,
	});
	try {
		const tasks = [];
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanTasks(
				{ kind: "pi.tool" },
				100,
				cursor,
				context,
			);
			tasks.push(...page.items);
			cursor = page.next;
		} while (cursor);
		const parent = tasks.find((task) => {
			const input = task.input as ToolTaskInput;
			return input.kind === "model" && input.callId === callId;
		});
		assert.ok(parent, "ACP parent must identify an admitted native tool task.");
		const input = parent.input as Extract<ToolTaskInput, { kind: "model" }>;
		const entry = await storage.entry(input.assistant, context);
		const call = entry?.entry.model
			?.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((block) => block.type === "toolCall")
					: [],
			)
			.find((block) => block.id === callId);
		assert.ok(call);
		const nested = tasks
			.filter((task) => {
				const input = task.input as ToolTaskInput;
				return input.kind === "nested" && input.parent === parent.id;
			})
			.map((task) => ({
				call: (
					task.input as unknown as Extract<ToolTaskInput, { kind: "nested" }>
				).call,
				state: task.state,
			}));
		return { call, state: parent.state, nested };
	} finally {
		await storage.close(context);
	}
}
