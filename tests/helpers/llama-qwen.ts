import {
	createProvider,
	envApiKeyAuth,
	type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

// Trusted, explicitly selected configuration using Pi AI's native provider/model API.
const { PID_ACP_BASE_URL: baseUrl, PID_ACP_MODEL: modelId } = process.env;
if (!baseUrl || !modelId || !process.env.PID_ACP_API_KEY?.trim())
	throw new Error("Set PID_ACP_BASE_URL, PID_ACP_MODEL and PID_ACP_API_KEY.");
const url = new URL(baseUrl);
if (
	!["http:", "https:"].includes(url.protocol) ||
	url.username ||
	url.password ||
	url.search ||
	url.hash
)
	throw new Error(
		"Use an HTTP(S) base URL without credentials, query or fragment.",
	);

const model: Model<"openai-completions"> = {
	id: modelId,
	name: modelId,
	provider: "local-qwen",
	api: "openai-completions",
	baseUrl: url.href.replace(/\/$/, ""),
	reasoning: true,
	input: ["text"],
	contextWindow: 32768,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: {
		supportsDeveloperRole: false,
		supportsUsageInStreaming: false,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
		supportsStore: false,
		supportsReasoningEffort: true,
	},
	// The loaded Qwen3.8 template accepts only low, medium and xhigh.
	// Pi AI clamps other requested levels using this native capability map.
	thinkingLevelMap: {
		off: "none",
		minimal: null,
		high: null,
		xhigh: "xhigh",
		max: null,
	},
	samplingParams: { chat_template_kwargs: { enable_thinking: true } },
	samplingParamsByThinkingLevel: {
		off: { chat_template_kwargs: { enable_thinking: false } },
	},
};

export default createProvider({
	id: model.provider,
	name: "Local Qwen / llama-server",
	baseUrl: model.baseUrl,
	auth: { apiKey: envApiKeyAuth("Local Qwen key", ["PID_ACP_API_KEY"]) },
	models: [model],
	api: openAICompletionsApi(),
});
