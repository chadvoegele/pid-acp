import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClient, waitFor } from "./helpers/client.ts";
import { summarizeLiveUpdates } from "./helpers/live-diagnostics.ts";
import { requireLiveProvider } from "./helpers/live-provider.ts";
import {
	hasSteeringFollowThrough,
	runSteeringAttempts,
	SteeringInstructionMiss,
} from "./helpers/steering.ts";
import { readText } from "./helpers/updates.ts";

const provider = await requireLiveProvider();
const started = Date.now();
const attempts: object[] = [];

async function runAttempt(attempt: number) {
	const cwd = await mkdtemp(join(tmpdir(), "pid-acp-live-steering-"));
	const token = `STEERING-${randomUUID()}`;
	await writeFile(join(cwd, "steering-value.txt"), token);
	let client: Awaited<ReturnType<typeof startClient>> | undefined;
	const checks: object[] = [];
	try {
		client = await startClient({ live: true, cwd });
		const active = client;
		assert.deepEqual(client.initialize._meta?.steering, { supported: true });
		const sessionId = client.session?.sessionId;
		assert.ok(sessionId);
		const steer = (text: string, metadata = false) =>
			active.request("_session/steering", {
				sessionId,
				prompt: [{ type: "text", text }],
				...(metadata
					? { _meta: { steering: { idleBehavior: "promptRequired" } } }
					: {}),
			});
		const idleUpdateCount = client.updates.length;
		for (const metadata of [false, true]) {
			assert.deepEqual(await steer("idle steering", metadata), {
				outcome: "promptRequired",
				reason: "noRunningTurn",
			});
		}
		assert.equal(client.updates.length, idleUpdateCount);
		checks.push({
			check: "idle-steering",
			result: "promptRequired/noRunningTurn",
		});
		const ordinaryStart = client.updates.length;
		assert.deepEqual(await client.prompt("Reply with the single word READY."), {
			stopReason: "end_turn",
		});
		await client.waitForAnswer((text) => text.includes("READY"), ordinaryStart);
		checks.push({ check: "ordinary-prompt", result: "end_turn" });

		const initialCommand = "sleep 8; printf 'INITIAL-COMMAND-COMPLETE\\n'";
		const promptStart = client.updates.length;
		const prompt = client.prompt(
			`Use the native bash tool to run this harmless command: ${JSON.stringify(initialCommand)}. While it runs, the user may send an additional task. After it finishes, complete any added task using another native bash call before answering. Do not inspect any files yet.`,
		);
		void prompt.catch(() => {});
		await waitFor(
			() =>
				active.updates
					.slice(promptStart)
					.some((update) => update.sessionUpdate === "tool_call"),
			60_000,
		);
		const initialCall = client.updates
			.slice(promptStart)
			.find((update) => update.sessionUpdate === "tool_call");
		assert.ok(initialCall);
		assert.equal(initialCall.title, "bash");
		assert.match(JSON.stringify(initialCall.rawInput), /sleep 8/);
		const steeringUpdateText =
			"Additional task: obtain the secret value from steering-value.txt, which you have not read. After the running command finishes, use a SECOND native bash call to run: cat steering-value.txt > steering-receipt.txt; cat steering-receipt.txt . The receipt file and successful bash execution are required. Finish by reporting the value returned by that command. Do not answer until you have executed this second bash call; the value is not provided in this message. Do not use codemode or other tools.";
		const steering = await steer(steeringUpdateText);
		checks.push({ check: "native-steering-admission", result: steering });
		assert.deepEqual(steering, { outcome: "injected" });
		await assert.rejects(
			client.prompt("This overlapping ordinary prompt must be rejected."),
			/already active/i,
		);
		let completed = false;
		void prompt.then(() => {
			completed = true;
		});
		assert.equal(
			completed,
			false,
			"Steering returns before the original prompt completes.",
		);
		assert.deepEqual(await prompt, { stopReason: "end_turn" });

		await waitFor(() =>
			active.updates
				.slice(promptStart)
				.some(
					(update) =>
						update.sessionUpdate === "tool_call_update" &&
						update.toolCallId === initialCall.toolCallId &&
						update.status === "completed",
				),
		);
		await waitFor(
			() => active.updates.slice(promptStart).map(readText).join("").length > 0,
		);
		const calls = client.updates
			.slice(promptStart)
			.filter((update) => update.sessionUpdate === "tool_call");
		for (const call of calls) {
			await waitFor(() =>
				active.updates
					.slice(promptStart)
					.some(
						(update) =>
							update.sessionUpdate === "tool_call_update" &&
							update.toolCallId === call.toolCallId &&
							(update.status === "completed" || update.status === "failed"),
					),
			);
		}
		assert.ok(
			!client.updates
				.slice(promptStart)
				.some(
					(update) =>
						update.sessionUpdate === "tool_call_update" &&
						update.status === "failed",
				),
			"A failed tool is a blocker, not a retryable obedience miss.",
		);
		const steeringInputs = client.updates
			.slice(promptStart)
			.filter(
				(update) =>
					update.sessionUpdate === "user_message_chunk" &&
					update.content.type === "text" &&
					update.content.text === steeringUpdateText,
			);
		assert.equal(
			steeringInputs.length,
			1,
			"Steering input is presented exactly once.",
		);
		assert.equal(client.stderr, "");
		try {
			await waitFor(
				() =>
					hasSteeringFollowThrough(
						active.updates.slice(promptStart),
						token,
						"steering-value.txt",
					),
				5000,
			);
		} catch {
			throw new SteeringInstructionMiss(
				"Completed turn lacked a matching successful second native bash result and hidden-value answer (5000ms observation window).",
			);
		}
		let receipt: string | undefined;
		try {
			receipt = await readFile(join(cwd, "steering-receipt.txt"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (receipt !== token)
			throw new SteeringInstructionMiss(
				"The second action did not create the required hidden-value receipt.",
			);
		checks.push({
			check: "active-steering-follow-through",
			result:
				"successful second native bash; hidden value consumed; receipt verified",
			toolCalls: calls.length,
		});
		return checks;
	} catch (error) {
		process.stderr.write(
			`${JSON.stringify({ attempt, checks, ...(client && summarizeLiveUpdates(client.updates, [cwd])) })}\n`,
		);
		throw error;
	} finally {
		try {
			if (client) {
				await client.close();
				assert.deepEqual(await client.exited, [0, null]);
				assert.equal(client.stderr, "");
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}
}

const checks = await runSteeringAttempts(runAttempt, (result) => {
	attempts.push(result);
	process.stdout.write(
		`${JSON.stringify({ policy: "maximum-three-fresh-attempts; instruction-following-only", ...result })}\n`,
	);
});
process.stdout.write(
	`${JSON.stringify({ provider: provider.endpoint, model: provider.model, thinkingLevel: provider.thinkingLevel, durationMs: Date.now() - started, attempts, checks, passed: true })}\n`,
);
