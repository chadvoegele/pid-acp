import assert from "node:assert/strict";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

const faux = fauxProvider();
faux.setResponses([
	(transcript) => {
		const text = JSON.stringify(transcript);
		assert.ok(text.includes("GLOBAL_RESOURCE_MARKER"));
		assert.ok(text.includes("PROJECT_RESOURCE_MARKER"));
		assert.ok(text.includes("fixture skill description"));
		assert.ok(!text.includes("LAZY_SKILL_BODY_MARKER"));
		assert.ok(!text.includes("CHANGED_INSTRUCTIONS_MARKER"));
		assert.ok(!text.includes("EXCLUDED_DEFAULT_INSTRUCTIONS"));
		assert.ok(process.env.PID_TEST_SKILL_PATH);
		return fauxAssistantMessage(
			[
				fauxToolCall(
					"read",
					{ path: process.env.PID_TEST_SKILL_PATH },
					{ id: "load-skill" },
				),
			],
			{ stopReason: "toolUse" },
		);
	},
	(transcript) => {
		const last = transcript.messages.at(-1);
		assert.equal(last?.role, "toolResult");
		assert.ok(JSON.stringify(last).includes("LAZY_SKILL_BODY_MARKER"));
		return fauxAssistantMessage("Skill loaded through the native read tool.");
	},
	(transcript) => {
		const text = JSON.stringify(transcript);
		assert.ok(text.includes("PROJECT_RESOURCE_MARKER"));
		assert.ok(!text.includes("CHANGED_INSTRUCTIONS_MARKER"));
		return fauxAssistantMessage("Instructions remain a session snapshot.");
	},
]);
export default faux.provider;
