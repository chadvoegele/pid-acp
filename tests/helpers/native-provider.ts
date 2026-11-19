import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";

// No pid-acp factory or model schema: this is a native Pi AI Provider.
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("Native provider answer.")]);
export default faux.provider;
