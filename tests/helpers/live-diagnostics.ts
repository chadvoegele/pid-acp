import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { readText } from "./updates.ts";

// Only for disposable live fixtures; never use this to log user sessions.
export function summarizeLiveUpdates(
	updates: readonly SessionUpdate[],
	fixtureRoots: readonly string[] = [],
) {
	const redact = (value: string) => {
		const secret = process.env.PID_ACP_API_KEY;
		if (secret)
			for (const form of [secret, JSON.stringify(secret).slice(1, -1)])
				value = value.replaceAll(form, "<redacted>");
		for (const root of fixtureRoots)
			value = value.replaceAll(root, "<fixture>");
		return value.slice(0, 4000);
	};
	return {
		updateCount: updates.length,
		answer: redact(
			updates
				.filter((update) => update.sessionUpdate === "agent_message_chunk")
				.map(readText)
				.join(""),
		),
		inputs: updates
			.filter((update) => update.sessionUpdate === "user_message_chunk")
			.map((update) =>
				redact(update.content.type === "text" ? update.content.text : ""),
			),
		tools: updates
			.filter(
				(update) =>
					update.sessionUpdate === "tool_call" ||
					update.sessionUpdate === "tool_call_update",
			)
			.map((update) => ({
				id: redact(update.toolCallId),
				status: update.status,
				...(update.sessionUpdate === "tool_call"
					? {
							tool: redact(update.title),
							input: redact(JSON.stringify(update.rawInput) ?? ""),
						}
					: { output: redact(JSON.stringify(update.rawOutput) ?? "") }),
			})),
	};
}
