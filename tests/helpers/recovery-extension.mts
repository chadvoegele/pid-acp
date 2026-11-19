import { writeFile } from "node:fs/promises";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";

export const result = "fixture-task-recovered";
export const task = defineTask({
	name: "fixture.recover",
	version: 1,
	initial: (_input: { started: string }) => ({ phase: "run" as const }),
	phases: {
		async run(record, runtime, context) {
			await writeFile(record.input.started, "started");
			// Allocate the host's conversation environment and its MCP client.
			await runtime.env(context);
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "completed", result },
				}),
				context,
			);
		},
	},
	async abort(_record, runtime, context) {
		await runtime.commit(
			() => ({ status: "terminal", outcome: { status: "aborted" } }),
			context,
		);
	},
});

export default defineExtension({ name: "fixture.recovery", tasks: [task] });
