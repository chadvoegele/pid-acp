import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { promptAfterRecovery } from "./helpers/client.ts";

const busy = () =>
	new RequestError(
		-32000,
		"A prompt is already active. Cancel it or wait for completion.",
	);

test("recovered prompts wait for admission and never repeat an accepted turn", async () => {
	let attempts = 0;
	let executions = 0;
	const result = await promptAfterRecovery(async () => {
		if (++attempts < 3) throw busy();
		executions++;
		return { stopReason: "end_turn" };
	});
	assert.equal(attempts, 3);
	assert.equal(executions, 1);
	assert.deepEqual(result, { stopReason: "end_turn" });
});

test("recovered prompt admission propagates other errors without retry", async () => {
	for (const error of [
		new Error("provider failed"),
		new RequestError(-32000, "Server is shutting down."),
		new RequestError(-32602, "Unknown session ID."),
	]) {
		let attempts = 0;
		await assert.rejects(
			promptAfterRecovery(async () => {
				attempts++;
				throw error;
			}),
			(caught) => caught === error,
		);
		assert.equal(attempts, 1);
	}
});

test("recovered prompt admission has a bounded busy wait", async () => {
	let attempts = 0;
	const error = busy();
	await assert.rejects(
		promptAfterRecovery(async () => {
			attempts++;
			throw error;
		}, 0),
		(caught) => caught === error,
	);
	assert.equal(attempts, 1);
});
