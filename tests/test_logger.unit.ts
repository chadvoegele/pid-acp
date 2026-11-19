import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const loggerUrl = new URL("../dist/logger.js", import.meta.url).href;

test("importing the shared Console writes nothing to either stream", () => {
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`await import(${JSON.stringify(loggerUrl)});`,
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
});

test("normal, warning and error Console methods keep prefixed diagnostics on stderr", () => {
	const methods = ["log", "info", "debug", "warn", "error"];
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { logger } = await import(${JSON.stringify(loggerUrl)});
			for (const method of ${JSON.stringify(methods)})
				logger[method]("pid-acp: " + method + " diagnostic");`,
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.equal(
		result.stderr,
		methods.map((method) => `pid-acp: ${method} diagnostic\n`).join(""),
	);
});
