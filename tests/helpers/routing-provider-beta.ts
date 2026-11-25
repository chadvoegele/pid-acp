import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";

const beta = fauxProvider({ provider: "beta", models: [{ id: "shared" }] });
beta.setResponses([fauxAssistantMessage("Answer from beta")]);
export default beta.provider;
