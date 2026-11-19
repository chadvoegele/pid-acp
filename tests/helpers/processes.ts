import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PromptResponse } from "@agentclientprotocol/sdk";

export async function readActivePid(
	cwd: string,
	file: string,
	completion: Promise<PromptResponse>,
	timeout = 60000,
) {
	let outcome: string | undefined;
	void completion.then(
		(result) => {
			outcome = `stopReason=${result.stopReason}`;
		},
		(error: unknown) => {
			outcome = error instanceof Error ? error.message : String(error);
		},
	);
	const deadline = Date.now() + timeout;
	for (;;) {
		const text = await readFile(join(cwd, file), "utf8").catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return "";
				throw error;
			},
		);
		if (text.trim()) {
			const pid = Number(text);
			assert.ok(Number.isSafeInteger(pid) && pid > 1, `Invalid PID in ${file}`);
			return pid;
		}
		assert.equal(
			outcome,
			undefined,
			`Prompt settled before ${file}: ${outcome}`,
		);
		assert.ok(
			Date.now() < deadline,
			`Timed out waiting for ${file}; prompt pending`,
		);
		await delay(10);
	}
}

export async function readPids(cwd: string) {
	const files = ["shell.pid", "nested.pid", "sleep.pid"];
	const pids = [];
	for (const file of files) {
		let value = "";
		const deadline = Date.now() + 5000;
		while (!value && Date.now() < deadline) {
			value = await readFile(join(cwd, file), "utf8").catch(() => "");
			if (!value) await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.ok(value, `missing ${file}`);
		pids.push(Number(value.trim()));
	}
	return pids;
}
async function isRunning(pid: number) {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
	return stat && !/^\d+ \(.*\) Z /.test(stat);
}
export async function assertChildrenStopped(pids: number[]) {
	for (const pid of pids) {
		const deadline = Date.now() + 2000;
		while (await isRunning(pid)) {
			assert.ok(Date.now() < deadline, `child ${pid} survived cleanup`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}
