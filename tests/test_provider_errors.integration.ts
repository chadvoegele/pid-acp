import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { startClient } from "./helpers/client.ts";

test("sends a safe ACP error only for the Codex overload code", {
	timeout: 10000,
}, async (t) => {
	const client = await startClient({
		live: true,
		cwd: tmpdir(),
		env: {
			PID_ACP_SOCKET_PATH: undefined,
			PID_ACP_EXTENSIONS: undefined,
			PID_ACP_THINKING: "off",
			PID_ACP_PROVIDERS: resolve("tests/helpers/codex-error-provider.ts"),
			PID_ACP_PROVIDER: "faux",
			PID_ACP_MODEL: "faux-1",
		},
	});
	t.after(() => client.close());
	const overloaded = {
		code: -32603,
		message: "The model provider is overloaded. Please try again later.",
	};
	await assert.rejects(client.prompt("first"), overloaded);
	await assert.rejects(client.prompt("second"), overloaded);
	await assert.rejects(client.prompt("third"), {
		code: -32603,
		message:
			"Prompt failed. Check server diagnostics and provider configuration.",
	});
	assert.doesNotMatch(JSON.stringify(client.wire), /private provider detail/);
});
