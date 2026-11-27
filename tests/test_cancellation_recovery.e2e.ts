import { existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startClient, waitFor } from "./helpers/client.ts";
import { readStatus } from "./helpers/updates.ts";
import { readPids, assertChildrenStopped } from "./helpers/processes.ts";

test("cancel real nested bash children under five seconds and recover", {
	timeout: 15000,
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pid-acp-cancel-"));
	const client = await startClient({ cwd });
	try {
		const prompt = client.prompt("sleep");
		const pids = await readPids(cwd);
		const start = Date.now();
		await client.cancel();
		assert.equal((await prompt).stopReason, "cancelled");
		assert.ok(Date.now() - start < 5000);
		await assertChildrenStopped(pids);
		await waitFor(() =>
			client.updates.some((update) => readStatus(update) === "failed"),
		);
		assert.ok(client.updates.some((update) => readStatus(update) === "failed"));
		const cancelledIds = client.updates
			.filter((update) => update.sessionUpdate === "agent_message_chunk")
			.map((update) => update.messageId);
		assert.ok(cancelledIds.length > 0);
		assert.ok(
			cancelledIds.every((id) => typeof id === "string" && id.length > 0),
		);
		client.updates.length = 0;
		assert.equal((await client.prompt("healthy")).stopReason, "end_turn");
		await client.waitForAnswer(
			(text) =>
				text === "A streamed answer with several distinct committed chunks.",
		);
		const recovered = client.updates.filter(
			(update) => update.sessionUpdate === "agent_message_chunk",
		);
		assert.ok(recovered.length > 0);
		assert.ok(
			recovered.every(
				(update) =>
					typeof update.messageId === "string" &&
					!cancelledIds.includes(update.messageId),
			),
		);
	} finally {
		await client.close();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("rapid and active-model cancellation each allow a subsequent prompt", {
	timeout: 15000,
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pid-acp-model-"));
	const started = join(cwd, "model-started");
	const client = await startClient({
		cwd,
		env: { PID_TEST_MODEL_STARTED: started },
	});
	try {
		for (const waitForModel of [false, true, false]) {
			await rm(started, { force: true });
			const prompt = client.prompt("model-block");
			if (waitForModel) await waitFor(() => existsSync(started));
			const start = Date.now();
			await client.cancel();
			assert.equal((await prompt).stopReason, "cancelled");
			assert.ok(Date.now() - start < 5000);
			assert.equal((await client.prompt("healthy")).stopReason, "end_turn");
		}
	} finally {
		await client.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
