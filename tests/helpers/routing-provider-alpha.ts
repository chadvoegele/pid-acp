import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";

const alpha = fauxProvider({ provider: "alpha", models: [{ id: "shared" }] });
alpha.setResponses([fauxAssistantMessage("Answer from alpha")]);
export default alpha.provider;
