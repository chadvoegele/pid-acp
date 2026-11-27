import { fixtureEnvironment } from "./helpers/environment.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("published MCP discovery/registry replacement precedes unattached recovery; native missing tools fail and unsafe intents never replay", {
	timeout: 20000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pid-mcp-api-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	function start(phase: string) {
		const child = fork("tests/helpers/mcp-api-proof.ts", [root, phase], {
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			env: { ...fixtureEnvironment(), PID_ACP_MCP_CONFIG: "" },
		});
		const exited = once(child, "exit");
		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += data;
		});
		t.after(async () => {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
			await exited;
		});
		return { child, exited, stderr: () => stderr };
	}
	const seed = start("seed");
	const intent = await Promise.race([
		once(seed.child, "message"),
		seed.exited.then(() => {
			throw new Error(`Seed exited before intent: ${seed.stderr()}`);
		}),
	]);
	assert.deepEqual(intent[0], {
		kind: "intent",
		externalCalls: ["value", "hold"],
	});
	seed.child.kill("SIGKILL");
	assert.deepEqual(await seed.exited, [null, "SIGKILL"]);
	assert.equal(seed.stderr(), "");
	const recover = start("recover");
	const recovered = await Promise.race([
		once(recover.child, "message"),
		recover.exited.then(() => {
			throw new Error(`Recovery exited early: ${recover.stderr()}`);
		}),
	]);
	assert.deepEqual(recovered[0], { kind: "recovered" });
	recover.child.disconnect();
	assert.deepEqual(await recover.exited, [0, null], recover.stderr());
	assert.equal(recover.stderr(), "");
	assert.equal(
		await readFile(join(root, "recovered.txt"), "utf8"),
		"recovered without attachment",
	);
});
