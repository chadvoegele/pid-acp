import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";

const faux = fauxProvider();
const respond: FauxResponseFactory = async (transcript) => {
	const system = transcript.messages.filter(
		(message) => message.role === "system",
	);
	const declarations = system.flatMap((message) => message.toolsAdded ?? []);
	assert.ok(declarations.some((tool) => tool.name === "codemode"));
	assert.ok(declarations.every((tool) => !tool.name.startsWith("mcp__")));
	assert.doesNotMatch(JSON.stringify(system), /fixture-token|PRIVATE_/);
	const last = transcript.messages.findLast(
		(message) => message.role !== "system",
	);
	if (process.env.PID_TEST_REQUEST_LOG)
		await appendFile(
			process.env.PID_TEST_REQUEST_LOG,
			`${JSON.stringify({ lastRole: last?.role })}\n`,
		);
	if (last?.role === "toolResult")
		return fauxAssistantMessage(JSON.stringify(last));
	assert.ok(last?.role === "user");
	const text =
		typeof last.content === "string"
			? last.content
			: last.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
	const { name, args } = JSON.parse(text);
	return fauxAssistantMessage(fauxToolCall(name, args, { id: randomUUID() }), {
		stopReason: "toolUse",
	});
};
faux.setResponses(Array.from({ length: 500 }, () => respond));
export default faux.provider;
