import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";

export interface TodoRequest {
	tools: string[];
	todos: string | null;
	result?: ToolResultMessage;
}

const log = process.env.PID_TEST_TODO_REQUEST_LOG;
assert.ok(log);
const phase = basename(log, ".jsonl");
const faux = fauxProvider();
let nextId = 0;
const respond: FauxResponseFactory = async ({ messages }) => {
	const system = getCurrentSystemMessage(messages);
	const last = messages.findLast((message) => message.role !== "system");
	assert.ok(last?.role === "user" || last?.role === "toolResult");
	const request: TodoRequest = {
		tools: system?.toolsAdded?.map(({ name }) => name) ?? [],
		todos: system?.sections?.todos ?? null,
		...(last.role === "toolResult" ? { result: last } : {}),
	};
	await appendFile(log, `${JSON.stringify(request)}\n`);
	if (last.role === "user") {
		const text =
			typeof last.content === "string"
				? last.content
				: last.content
						.map((block) => (block.type === "text" ? block.text : ""))
						.join("");
		const call = JSON.parse(text) as {
			name: string;
			args: ToolCall["arguments"];
		} | null;
		if (call) {
			assert.ok(
				request.tools.includes(call.name),
				`Missing tool: ${call.name}`,
			);
			return fauxAssistantMessage(
				fauxToolCall(call.name, call.args, { id: `${phase}-${++nextId}` }),
				{ stopReason: "toolUse" },
			);
		}
	}
	return fauxAssistantMessage("Fixture turn complete.");
};
faux.setResponses(Array.from({ length: 20 }, () => respond));
export default faux.provider;
