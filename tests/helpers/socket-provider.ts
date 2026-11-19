import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";

const gates = new Map<string, () => void>();
process.on("message", (message) => {
	if (typeof message === "string") gates.get(message)?.();
});
process.channel?.unref();

const faux = fauxProvider();
const respond: FauxResponseFactory = async ({ messages }, options) => {
	const content = messages.findLast(
		(message) => message.role === "user",
	)?.content;
	const input = typeof content === "string" ? content : JSON.stringify(content);
	process.send?.(`provider:${input}`);
	if (input.startsWith("hold-") && !process.env.PID_TEST_RECOVER) {
		const signal = options?.signal;
		const abort = () => gate.reject(new Error("Aborted"));
		const gate = Promise.withResolvers<void>();
		gates.set(`release:${input}`, gate.resolve);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (signal?.aborted) abort();
			await gate.promise;
		} finally {
			signal?.removeEventListener("abort", abort);
			gates.delete(`release:${input}`);
		}
	}
	return fauxAssistantMessage(`Answer: ${input}`);
};
faux.setResponses(Array.from({ length: 24 }, () => respond));
export default faux.provider;
