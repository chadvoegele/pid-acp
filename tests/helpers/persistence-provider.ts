import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";

const faux = fauxProvider();
const respond: FauxResponseFactory = async (transcript, options) => {
	if (process.env.PID_TEST_RESOURCE_SNAPSHOT === "1") {
		const system = JSON.stringify(
			transcript.messages.findLast((message) => message.role === "system"),
		);
		assert.ok(system.includes("ORIGINAL_INSTRUCTIONS"));
		assert.ok(system.includes("ORIGINAL_SKILL_DESCRIPTION"));
		assert.ok(!system.includes("CHANGED_INSTRUCTIONS"));
		assert.ok(!system.includes("CHANGED_SKILL_BODY"));
	}
	const last = transcript.messages.at(-1);
	const user = transcript.messages.findLast(
		(message) => message.role === "user",
	);
	const input =
		typeof user?.content === "string"
			? user.content
			: JSON.stringify(user?.content);
	if (process.env.PID_TEST_REQUEST_LOG)
		await appendFile(
			process.env.PID_TEST_REQUEST_LOG,
			`${JSON.stringify({ input, lastRole: last?.role })}\n`,
		);
	if (
		process.env.PID_TEST_RECOVER === "1" &&
		input !== "context" &&
		input !== "continuation"
	)
		return fauxAssistantMessage("Recovered answer.");
	if (input === "uncooperative") {
		if (process.env.PID_TEST_READY)
			await writeFile(process.env.PID_TEST_READY, "ready");
		await new Promise<never>(() => {});
	}
	if (input === "provider-error")
		throw new Error("PRIVATE_PROVIDER_ERROR_DO_NOT_LOG");
	if (
		input === "block" ||
		(last?.role === "toolResult" && input?.includes('"blockAfterTool":true'))
	) {
		if (process.env.PID_TEST_READY)
			await writeFile(process.env.PID_TEST_READY, "ready");
		await new Promise<never>((_resolve, reject) => {
			if (options?.signal?.aborted) return reject(new Error("aborted"));
			options?.signal?.addEventListener(
				"abort",
				() => reject(new Error("aborted")),
				{ once: true },
			);
		});
	}
	if (last?.role === "toolResult")
		return fauxAssistantMessage("Tool finished.");
	if (input?.startsWith("{")) {
		const { name, args } = JSON.parse(input);
		return fauxAssistantMessage(
			[
				fauxText("Before tool."),
				fauxToolCall(name, args, {
					id: `persistent-${transcript.messages.length}`,
				}),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (input === "context")
		return fauxAssistantMessage(JSON.stringify(transcript.messages));
	return fauxAssistantMessage([
		fauxThinking("Saved thought."),
		fauxText(`Answer: ${input}`),
	]);
};
faux.setResponses(Array.from({ length: 100 }, () => respond));
export default faux.provider;
