import assert from "node:assert/strict";
import { test } from "node:test";
import { withClientDeadline } from "./helpers/client.ts";

test("client deadline kills the server and rejects a stalled operation", async () => {
	let killed = false;
	await assert.rejects(
		withClientDeadline(
			() => {
				killed = true;
			},
			"stalled prompt",
			10,
			() => new Promise<never>(() => {}),
		),
		/stalled prompt exceeded 10ms/,
	);
	assert.equal(killed, true);
});

test("client deadline leaves a completed operation alone", async () => {
	let killed = false;
	assert.equal(
		await withClientDeadline(
			() => {
				killed = true;
			},
			"prompt",
			100,
			async () => "complete",
		),
		"complete",
	);
	assert.equal(killed, false);
});
