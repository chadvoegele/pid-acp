import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Provider } from "@earendil-works/pi-ai/models";

const { provider, models } = fauxProvider({ api: "openai-codex-responses" });
const [model] = models;
const apiKey = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }))}.test`;
const errors = [
	{
		type: "error",
		code: "server_is_overloaded",
		message: "private provider detail",
	},
	{
		type: "response.failed",
		response: {
			error: {
				code: "server_is_overloaded",
				message: "private provider detail",
			},
		},
	},
	{
		type: "error",
		code: "other_error",
		message: "Our servers are currently overloaded. private provider detail",
	},
];

export default {
	...provider,
	streamSimple(_model, context, options) {
		return streamSimple({ ...model, api: "openai-codex-responses" }, context, {
			...options,
			apiKey,
			transport: "sse",
			fetch: async () =>
				new Response(`data: ${JSON.stringify(errors.shift())}\n\n`),
		});
	},
} satisfies Provider;
