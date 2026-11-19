import {
	defineDoc,
	defineExtension,
	defineTool,
	section,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";

// Adapted from Durable's 10-extension-state example.
const Todos = defineDoc({
	kind: "example.todos",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	checkpointWhen: () => false,
	initial: () => ({ items: [] }),
});

const todo = defineTool({
	name: "todo",
	description: "Add an item to the current conversation's todo list.",
	parameters: obj({ item: str() }),
	async execute({ item }, api, context) {
		await api.commit(async (tx) => {
			(await tx.doc(Todos, api.conversationId)).items.push(item);
		}, context);
		return { output: [{ type: "text", text: `Added ${item}` }] };
	},
});

const todos = section("todos", async (input, context) => {
	const list = await input.read.snapshot(Todos, input.conversationId, context);
	return list?.items.length ? list.items.join("\n") : undefined;
});

export const todoExtension = defineExtension({
	name: "user.todo",
	tools: [todo],
	sections: [todos],
});
