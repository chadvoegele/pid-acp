import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { waitFor } from "./helpers/client.ts";
import {
	hasSteeringFollowThrough,
	runSteeringAttempts,
	SteeringInstructionMiss,
} from "./helpers/steering.ts";

const token = "STEERING-public-fixture";
const calls: Extract<SessionUpdate, { sessionUpdate: "tool_call" }>[] = [
	{
		sessionUpdate: "tool_call",
		toolCallId: "initial",
		title: "bash",
		status: "in_progress",
		rawInput: { command: "sleep 8; printf initial" },
	},
	{
		sessionUpdate: "tool_call",
		toolCallId: "steered",
		title: "bash",
		status: "in_progress",
		rawInput: { command: `printf '%s\\n' ${token}` },
	},
];
const result: SessionUpdate = {
	sessionUpdate: "tool_call_update",
	toolCallId: "steered",
	status: "completed",
	rawOutput: [{ type: "text", text: `${token}\n` }],
};
const answer = (text: string): SessionUpdate => ({
	sessionUpdate: "agent_message_chunk",
	content: { type: "text", text },
});

test("steering observes execution and the complete final reply independently of prompt completion", async () => {
	const updates: SessionUpdate[] = [...calls];
	assert.equal(hasSteeringFollowThrough(updates, token), false);
	updates.push(result, answer("STEERING-public-"));
	assert.equal(hasSteeringFollowThrough(updates, token), false);
	const observation = waitFor(() => hasSteeringFollowThrough(updates, token));
	setImmediate(() => updates.push(answer("fixture")));
	await observation;
	assert.equal(hasSteeringFollowThrough(updates, token), true);
});

test("steering requires the matching successful result, not merely a call or final answer", () => {
	assert.equal(
		hasSteeringFollowThrough([...calls, answer(token)], token),
		false,
	);
	for (const wrong of [
		{ ...result, toolCallId: "unrelated" },
		{ ...result, status: "failed" as const },
		{ ...result, status: "in_progress" as const },
		{ ...result, rawOutput: [{ type: "text", text: "other output" }] },
	])
		assert.equal(
			hasSteeringFollowThrough([...calls, wrong, answer(token)], token),
			false,
		);
});

test("steering accepts a hidden value read by the second command, not a prompt echo", () => {
	const hiddenCalls = [
		calls[0],
		{ ...calls[1], rawInput: { command: "cat steering-value.txt" } },
	] as SessionUpdate[];
	assert.equal(
		hasSteeringFollowThrough(
			[...hiddenCalls, result, answer(token)],
			token,
			"steering-value.txt",
		),
		true,
	);
	assert.equal(
		hasSteeringFollowThrough(
			[...hiddenCalls, answer(token)],
			token,
			"steering-value.txt",
		),
		false,
	);
	assert.equal(
		hasSteeringFollowThrough(
			[
				{ ...calls[0], rawInput: { command: token } },
				{ ...calls[1], rawInput: { command: "unrelated" } },
				{ ...result, toolCallId: "initial" },
				answer(token),
			],
			token,
		),
		false,
	);
});

test("bounded steering stops on its first pass and reports every cleaned attempt", async () => {
	const reports: object[] = [];
	const ran: number[] = [];
	const result = await runSteeringAttempts(
		async (attempt) => {
			ran.push(attempt);
			if (attempt === 1)
				throw new SteeringInstructionMiss("omitted second action");
			return "passed";
		},
		(result) => reports.push(result),
	);
	assert.equal(result, "passed");
	assert.deepEqual(ran, [1, 2]);
	assert.deepEqual(
		reports.map((report) => (report as { outcome: string }).outcome),
		["instruction-following-miss", "passed"],
	);
});

test("bounded steering never makes a fourth attempt or retries infrastructure errors", async () => {
	let attempts = 0;
	const reports: object[] = [];
	await assert.rejects(
		runSteeringAttempts(
			async () => {
				attempts++;
				throw new SteeringInstructionMiss("miss");
			},
			(result) => reports.push(result),
		),
		SteeringInstructionMiss,
	);
	assert.equal(attempts, 3);
	assert.equal(reports.length, 3);
	for (const error of [
		new Error("server crashed"),
		new Error("timeout"),
		new Error("auth failure"),
		new Error("cleanup failed"),
	]) {
		attempts = 0;
		await assert.rejects(
			runSteeringAttempts(
				async () => {
					attempts++;
					throw error;
				},
				() => {},
			),
			(actual) => actual === error,
		);
		assert.equal(attempts, 1);
	}
});

test("steering requires both native bash calls and an assistant reply", () => {
	assert.equal(
		hasSteeringFollowThrough([...calls.slice(1), result, answer(token)], token),
		false,
	);
	assert.equal(
		hasSteeringFollowThrough(
			[
				...calls.map((call) => ({ ...call, title: "codemode" })),
				result,
				answer(token),
			],
			token,
		),
		false,
	);
	assert.equal(
		hasSteeringFollowThrough(
			[
				...calls,
				result,
				{
					sessionUpdate: "user_message_chunk",
					content: { type: "text", text: token },
				},
			],
			token,
		),
		false,
	);
});
