import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startClient } from "./helpers/client.ts";
import { readText } from "./helpers/updates.ts";

test("production delegates to an arbitrary native Pi AI provider without OpenAI environment", {
	timeout: 15000,
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pid-native-provider-"));
	let client: Awaited<ReturnType<typeof startClient>> | undefined;
	try {
		client = await startClient({
			live: true,
			cwd,
			env: {
				PID_ACP_PROVIDERS: resolve("tests/helpers/native-provider.ts"),
				PID_ACP_MODEL: "faux-1",
				PID_ACP_THINKING: "off",
				PID_ACP_BASE_URL: undefined,
				PID_ACP_API_KEY: undefined,
			},
		});
		assert.equal((await client.prompt("Hello")).stopReason, "end_turn");
		await client.waitForAnswer((text) => text === "Native provider answer.");
		assert.equal(
			client.updates.map(readText).join(""),
			"Native provider answer.",
		);
		assert.equal(client.stderr, "");
	} finally {
		await client?.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
