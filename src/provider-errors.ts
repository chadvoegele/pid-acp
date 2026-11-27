import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";

export const PROVIDER_OVERLOADED_MESSAGE =
	"The model provider is overloaded. Please try again later.";

function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)[key]
		: undefined;
}

export function withCodexOverloadMessage(
	streamSimple: Models["streamSimple"],
): Models["streamSimple"] {
	return (model, context, options) => {
		if (model.api !== "openai-codex-responses")
			return streamSimple(model, context, options);

		let overloaded = false;
		const source = streamSimple(model, context, {
			...options,
			async onProviderStreamEvent(event, eventModel) {
				const type = field(event, "type");
				if (type === "error") {
					overloaded =
						(field(event, "code") ?? field(field(event, "error"), "code")) ===
						"server_is_overloaded";
				} else if (type === "response.failed") {
					overloaded =
						field(field(field(event, "response"), "error"), "code") ===
						"server_is_overloaded";
				}
				await options?.onProviderStreamEvent?.(event, eventModel);
			},
		});
		const output = createAssistantMessageEventStream();
		void (async () => {
			for await (const event of source) {
				if (event.type === "error" && event.reason === "error" && overloaded) {
					output.push({
						...event,
						error: {
							...event.error,
							errorMessage: PROVIDER_OVERLOADED_MESSAGE,
						},
					});
				} else {
					output.push(event);
				}
			}
			output.end(await source.result());
		})();
		return output;
	};
}
