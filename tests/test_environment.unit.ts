import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureEnvironment } from "./helpers/environment.ts";

test("deterministic fixtures keep system variables but ignore inherited pid-acp configuration", () => {
	const env = {
		PATH: "/usr/bin",
		PID_ACP_PROVIDER: "external-provider",
		PID_ACP_SOCKET_PATH: "/tmp/external.sock",
		PID_ACP_EXTENSIONS: "/tmp/external.ts",
	};
	assert.deepEqual(fixtureEnvironment(env), { PATH: "/usr/bin" });
	assert.equal(env.PID_ACP_PROVIDER, "external-provider");
});
