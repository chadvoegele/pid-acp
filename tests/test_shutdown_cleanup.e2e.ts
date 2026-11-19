import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startClient } from "./helpers/client.ts";
import { readPids, assertChildrenStopped } from "./helpers/processes.ts";

for (const action of ["EOF", "SIGTERM", "SIGINT"] as const) {
	test(`${action} during parallel A/B bash exits promptly and stops all nested children`, {
		timeout: 15000,
	}, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pid-acp-shutdown-"));
		const siblingCwd = join(cwd, "sibling");
		await mkdir(siblingCwd);
		const client = await startClient({ cwd });
		try {
			const sibling = await client.request("session/new", {
				cwd: siblingCwd,
				mcpServers: [],
			});
			const pending = Promise.all([
				client.prompt("sleep").catch((error) => error),
				client.prompt("sleep", sibling.sessionId).catch((error) => error),
			]);
			const pids = (
				await Promise.all([readPids(cwd), readPids(siblingCwd)])
			).flat();
			const start = Date.now();
			if (action === "EOF") await client.close();
			else {
				client.child.kill(action);
				await client.exited;
			}
			assert.ok(Date.now() - start < 5000);
			assert.equal(client.child.exitCode, 0);
			await assertChildrenStopped(pids);
			const outcomes = await pending;
			assert.ok(
				outcomes.every((outcome) => outcome instanceof Error),
				"Process shutdown must not report prompt success or user cancellation.",
			);
			assert.equal(client.stderr, "");
		} finally {
			await client.close();
			await rm(cwd, { recursive: true, force: true });
		}
	});
}
