import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { persistenceFixture } from "./helpers/persistence.ts";

async function runStartup(env: NodeJS.ProcessEnv) {
	const child = spawn(process.execPath, ["dist/main.js"], {
		env,
		timeout: 4000,
	});
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (data) => {
		stdout += data;
	});
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const [code] = await once(child, "close");
	return { code, stdout, stderr };
}

test("production executable fails configuration without stdout or leaking credentials", async () => {
	const { code, stdout, stderr } = await runStartup({
		PATH: "/nonexistent",
		PID_ACP_API_KEY: "do-not-print",
	});
	assert.equal(code, 1);
	assert.equal(stdout, "");
	assert.match(
		stderr,
		/^pid-acp: Startup failed\. Set PID_ACP_PROVIDER_CONFIG/,
	);
	assert.equal(stderr.split("\n").filter(Boolean).length, 1);
	assert.ok(!stderr.includes("do-not-print"));
});

test("production executable reports safe entry-specific registration errors on stderr", {
	timeout: 5000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const first = join(f.root, "valid.mjs");
	const second = join(f.root, "invalid.mjs");
	await writeFile(first, 'export default { name: "user.valid" };');
	await writeFile(
		second,
		`export default {
		name: "user.invalid",
		tools: [{ name: "private-fixture-token" }, { name: "private-fixture-token" }]
	};`,
	);
	const { code, stdout, stderr } = await runStartup({
		PID_ACP_PROVIDER_CONFIG: resolve("tests/helpers/native-provider.ts"),
		PID_ACP_MODEL: "faux-1",
		PID_ACP_MCP_CONFIG: "",
		PID_ACP_EXTENSIONS: JSON.stringify([first, second]),
	});
	assert.equal(code, 1);
	assert.equal(stdout, "");
	assert.match(
		stderr,
		/^pid-acp: PID_ACP_EXTENSIONS entry 2 \(registration\): Check/,
	);
	assert.equal(stderr.trimEnd().split("\n").length, 1);
	assert.doesNotMatch(stderr, /private-fixture-token/);
});
