import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { readActivePid } from "./helpers/processes.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const cwd = await mkdtemp(join(tmpdir(), "pid-observation-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

const pending = () => new Promise<PromptResponse>(() => {});

test("PID observation waits for nonempty contents without joining the active prompt", async (t) => {
	const cwd = await fixture(t);
	await writeFile(join(cwd, "shell.pid"), "");
	const reading = readActivePid(cwd, "shell.pid", pending(), 1000);
	await delay(20);
	await writeFile(join(cwd, "shell.pid"), "12345\n");
	assert.equal(await reading, 12345);
});

test("PID observation exposes early terminal outcomes instead of waiting for a timeout", async (t) => {
	const cwd = await fixture(t);
	for (const stopReason of ["end_turn", "cancelled"] as const)
		await assert.rejects(
			readActivePid(cwd, "shell.pid", Promise.resolve({ stopReason }), 1000),
			new RegExp(`Prompt settled before shell.pid: stopReason=${stopReason}`),
		);
});

test("PID observation handles rejected prompts immediately", async (t) => {
	const cwd = await fixture(t);
	await assert.rejects(
		readActivePid(
			cwd,
			"shell.pid",
			Promise.reject(new Error("fixture failure")),
			1000,
		),
		/Prompt settled before shell.pid: fixture failure/,
	);
});

test("PID observation distinguishes pending work from malformed PID contents", async (t) => {
	const cwd = await fixture(t);
	await assert.rejects(
		readActivePid(cwd, "shell.pid", pending(), 20),
		/shell.pid; prompt pending/,
	);
	await writeFile(join(cwd, "shell.pid"), "not a PID");
	await assert.rejects(
		readActivePid(cwd, "shell.pid", pending()),
		/Invalid PID/,
	);
});
