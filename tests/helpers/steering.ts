import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { readStatus, readText } from "./updates.ts";

export function hasSteeringFollowThrough(
	updates: readonly SessionUpdate[],
	token: string,
	commandEvidence = token,
) {
	const calls = updates
		.filter((update) => update.sessionUpdate === "tool_call")
		.filter((update) => update.title === "bash");
	if (calls.length < 2) return false;
	const steeredCall = calls
		.slice(1)
		.find((call) => JSON.stringify(call.rawInput)?.includes(commandEvidence));
	if (!steeredCall) return false;
	const executed = updates.some(
		(update) =>
			update.sessionUpdate === "tool_call_update" &&
			update.toolCallId === steeredCall.toolCallId &&
			readStatus(update) === "completed" &&
			JSON.stringify(update.rawOutput)?.includes(token),
	);
	return executed && updates.map(readText).join("").includes(token);
}

export class SteeringInstructionMiss extends Error {}

export async function runSteeringAttempts<T>(
	run: (attempt: number) => Promise<T>,
	report: (result: {
		attempt: number;
		durationMs: number;
		outcome: string;
		error?: string;
	}) => void,
) {
	const maximumAttempts = 3;
	for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
		const started = Date.now();
		try {
			const result = await run(attempt);
			report({ attempt, durationMs: Date.now() - started, outcome: "passed" });
			return result;
		} catch (error) {
			const eligible = error instanceof SteeringInstructionMiss;
			report({
				attempt,
				durationMs: Date.now() - started,
				outcome: eligible ? "instruction-following-miss" : "blocking-failure",
				error: error instanceof Error ? error.message : String(error),
			});
			if (!eligible || attempt === maximumAttempts) throw error;
		}
	}
	throw new Error("No steering attempt ran.");
}
