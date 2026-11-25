import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

// Independent reproduction of Pi 1.5.2's lock targets and in-place file transaction.
const [authFile, kind] = process.argv.slice(2);
const key = "mcp__project_docs|https://mcp.example.test/api";
const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
const refreshTarget = join(dirname(authFile), `mcp-auth-refresh-${hash}`);
assert.ok(process.send);
const release =
	kind === "file"
		? lockfile.lockSync(authFile)
		: await lockfile.lock(refreshTarget, { realpath: false, stale: 20_000 });
try {
	const proceed = once(process, "message");
	process.send("locked");
	const [message] = await proceed;
	assert.equal(message, "release");
	if (kind === "refresh") {
		const unlockFile = lockfile.lockSync(authFile);
		try {
			const states = JSON.parse(readFileSync(authFile, "utf8"));
			states[key].tokens.access_token = "rotated-access";
			states[key].tokens.refresh_token = "rotated-refresh";
			writeFileSync(authFile, `${JSON.stringify(states, null, 2)}\n`, {
				mode: 0o600,
			});
		} finally {
			unlockFile();
		}
	}
} finally {
	await release();
	process.disconnect?.();
}
