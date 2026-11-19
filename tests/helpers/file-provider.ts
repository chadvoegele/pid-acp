import assert from "node:assert/strict";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";

import type { ToolCall } from "@earendil-works/pi-ai";

const faux = fauxProvider({
	models: [
		{
			id: "files",
			input: process.env.FILE_VISION === "1" ? ["text", "image"] : ["text"],
			inputLimits: {
				images: { resize: { maxWidth: 1, maxHeight: 1, maxBytes: 1024 } },
			},
		},
	],
});
let nextId = 0;
const respond: FauxResponseFactory = async (
	transcript,
	options,
	_state,
	model,
) => {
	const last = transcript.messages.at(-1);
	if (last?.role === "toolResult") {
		const transformed = transformMessages([...transcript.messages], model).at(
			-1,
		);
		assert.ok(transformed?.role === "toolResult");
		if (last.content.some((block) => block.type === "image")) {
			assert.equal(
				transformed.content.some((block) => block.type === "image"),
				model.input.includes("image"),
			);
			if (!model.input.includes("image"))
				assert.match(JSON.stringify(transformed.content), /omitted/i);
		}
		const user = [...transcript.messages]
			.reverse()
			.find((message) => message.role === "user");
		if (JSON.stringify(user?.content).includes("block")) {
			await new Promise((_resolve, reject) => {
				if (options?.signal?.aborted) return reject(new Error("aborted"));
				options?.signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{ once: true },
				);
			});
		}
		return fauxAssistantMessage(JSON.stringify(last));
	}
	assert.ok(last?.role === "user");
	const text =
		typeof last.content === "string"
			? last.content
			: last.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
	const request = JSON.parse(text) as {
		name: string;
		args: ToolCall["arguments"];
	};
	return fauxAssistantMessage(
		fauxToolCall(request.name, request.args, { id: `file-${++nextId}` }),
		{ stopReason: "toolUse" },
	);
};
faux.setResponses(Array.from({ length: 500 }, () => respond));
export default faux.provider;
