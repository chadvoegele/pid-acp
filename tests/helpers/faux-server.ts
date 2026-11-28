import { writeFile } from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseFactory,
	fauxProvider,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../../dist/runtime.js";
import { serve } from "../../dist/stdio-server.js";

const faux = fauxProvider({
	tokensPerSecond: 100,
	tokenSize: { min: 3, max: 3 },
});
const respond: FauxResponseFactory = async (transcript, options) => {
	const last = transcript.messages.at(-1);
	if (last?.role === "toolResult") {
		const output = last.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");
		if (!output.includes("pid-") && !last.isError)
			throw new Error("Real bash output was not supplied to the provider.");
		return fauxAssistantMessage([fauxText(`The shell returned: ${output}`)]);
	}
	const input = JSON.stringify(last?.content ?? "");
	if (input.includes("provider-error"))
		return fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Simulated provider failure. Try again later.",
		});
	if (input.includes("provider-blank"))
		return fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "  ",
		});
	if (input.includes("model-block")) {
		const started = process.env.PID_TEST_MODEL_STARTED;
		if (started) await writeFile(started, "");
		await new Promise((_resolve, reject) => {
			if (options?.signal?.aborted) return reject(new Error("aborted"));
			options?.signal?.addEventListener(
				"abort",
				() => reject(new Error("aborted")),
				{ once: true },
			);
		});
	}
	let command: string | undefined;
	if (input.includes("sleep"))
		command =
			"printf '%s\\n' $$ > shell.pid; bash -c 'echo $$ > nested.pid; sleep 60 & echo $! > sleep.pid; wait'";
	else if (input.includes("shell-fail")) command = "printf failure; exit 7";
	else if (input.includes("pwd")) command = "pwd";
	if (command)
		return fauxAssistantMessage(
			[
				fauxText("Running the shell command."),
				fauxToolCall("bash", { command }, { id: `bash-${++toolId}` }),
			],
			{ stopReason: "toolUse" },
		);
	return fauxAssistantMessage([
		fauxText("A streamed answer with several distinct committed chunks."),
	]);
};
let toolId = 0;
faux.setResponses(Array.from({ length: 100 }, () => respond));
const models = createModels();
models.setProvider(faux.provider);
await serve(
	await Runtime.open(models, { provider: "faux", modelId: "faux-1" }),
);
