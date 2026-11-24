import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClient, waitFor } from "./helpers/client.ts";
import { readText, readStatus } from "./helpers/updates.ts";

for (const name of [
	"PID_ACP_PROVIDERS",
	"PID_ACP_BASE_URL",
	"PID_ACP_MODEL",
	"PID_ACP_API_KEY",
])
	if (!process.env[name])
		throw new Error(`Set ${name} explicitly for live testing.`);
assert.ok(
	["minimal", "low", "medium", "high", "xhigh", "max"].includes(
		process.env.PID_ACP_THINKING ?? "",
	),
	"Set PID_ACP_THINKING to an enabled thinking level explicitly.",
);
const cwd = await mkdtemp(join(tmpdir(), "pid-live-thinking-"));
let client: Awaited<ReturnType<typeof startClient>> | undefined;
const started = Date.now();
try {
	client = await startClient({ live: true, cwd });
	assert.equal(
		(
			await client.prompt(
				"Use bash to run pwd, then tell me the exact directory.",
			)
		).stopReason,
		"end_turn",
	);
	await client.waitForAnswer((text) => text.includes(cwd));
	const thoughts = client.updates.filter(
		(u) => u.sessionUpdate === "agent_thought_chunk",
	);
	assert.ok(thoughts.length > 1, "Qwen must stream thinking.");
	assert.ok(
		thoughts.every(
			(u) =>
				u.content.type === "text" && u.content.text.length > 0 && u.messageId,
		),
	);
	assert.ok(client.updates.some((u) => readStatus(u) === "completed"));
	assert.ok(client.updates.map(readText).join("").includes(cwd));
	const thoughtIds = new Set(thoughts.map((u) => u.messageId));
	const answers = client.updates.filter(
		(u) => u.sessionUpdate === "agent_message_chunk",
	);
	assert.ok(answers.every((u) => u.messageId && !thoughtIds.has(u.messageId)));
	process.stdout.write(
		`${JSON.stringify({ check: "thinking-tool-answer", thoughtChunks: thoughts.length, thoughtBlocks: thoughtIds.size, answerChunks: answers.length, durationMs: Date.now() - started })}\n`,
	);
	client.updates.length = 0;
	let finished = false;
	const pending = client
		.prompt(
			"Compute 123456789 times 987654321. Think through the calculation carefully and verify it using multiple independent methods before answering. Do not use tools.",
		)
		.finally(() => {
			finished = true;
		});
	await waitFor(
		() =>
			client?.updates.some((u) => u.sessionUpdate === "agent_thought_chunk") ??
			false,
		60000,
	);
	assert.equal(finished, false);
	const cancelledAt = Date.now();
	await client.cancel();
	assert.equal((await pending).stopReason, "cancelled");
	const cancelMs = Date.now() - cancelledAt;
	assert.ok(cancelMs < 5000);
	client.updates.length = 0;
	assert.equal(
		(
			await client.prompt(
				"The previous task is cancelled. Discard it. For this new task, reply only with the word recovered.",
			)
		).stopReason,
		"end_turn",
	);
	await client.waitForAnswer((text) => text.includes("recovered"));
	assert.ok(
		client.updates.map(readText).join("").includes("recovered"),
		"Recovery prompt must produce its answer after cancelled thinking.",
	);
	assert.equal(client.stderr, "");
	process.stdout.write(
		`${JSON.stringify({ check: "thinking-cancel-recovery", cancelMs, passed: true, durationMs: Date.now() - started, model: process.env.PID_ACP_MODEL, thinkingLevel: process.env.PID_ACP_THINKING })}\n`,
	);
} finally {
	await client?.close();
	await rm(cwd, { recursive: true, force: true });
}
