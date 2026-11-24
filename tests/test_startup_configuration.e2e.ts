import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { startClient } from "./helpers/client.ts";
import { persistenceFixture } from "./helpers/persistence.ts";

const routingProviders = {
	alpha: resolve("tests/helpers/routing-provider-alpha.ts"),
	beta: resolve("tests/helpers/routing-provider-beta.ts"),
};
const routingConfig = {
	PID_ACP_PROVIDER_CONFIG: JSON.stringify(Object.values(routingProviders)),
	PID_ACP_MODEL: "shared",
	PID_ACP_SOCKET_PATH: undefined,
	PID_ACP_EXTENSIONS: "",
};

async function assertProviderAnswer(
	client: Awaited<ReturnType<typeof startClient>>,
	sessionId: string,
	provider: keyof typeof routingProviders,
) {
	const start = client.updates.length;
	assert.equal(
		(await client.prompt("Identify yourself.", sessionId)).stopReason,
		"end_turn",
	);
	await client.waitForAnswer(
		(text) => text === `Answer from ${provider}`,
		start,
	);
}

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
		/^pid-acp: Set PID_ACP_PROVIDER_CONFIG.*nonempty JSON array/,
	);
	assert.equal(stderr.split("\n").filter(Boolean).length, 1);
	assert.ok(!stderr.includes("do-not-print"));
});

test("production executable rejects an unregistered default provider on stderr", {
	timeout: 5000,
}, async (t) => {
	const { sessions } = await persistenceFixture(t);
	const { code, stdout, stderr } = await runStartup({
		...routingConfig,
		PID_ACP_PROVIDER: "missing",
		PID_ACP_SESSIONS_DIR: sessions,
		PID_ACP_MCP_CONFIG: "",
	});
	assert.equal(code, 1);
	assert.equal(stdout, "");
	assert.match(
		stderr,
		/^pid-acp: PID_ACP_PROVIDER is not registered\. Set it to the ID of a provider loaded by PID_ACP_PROVIDER_CONFIG\./,
	);
});

test("production sessions retain their selected providers across changes to the default", {
	timeout: 20000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const workspace = { cwd: f.cwd, mcpServers: [] };
	const start = (provider: keyof typeof routingProviders) =>
		f.client({
			...routingConfig,
			PID_ACP_PROVIDER: provider,
		});

	const first = await start("alpha");
	const alpha = await first.request("session/new", workspace);
	await assertProviderAnswer(first, alpha.sessionId, "alpha");
	await first.close();

	const second = await start("beta");
	const beta = await second.request("session/new", workspace);
	await assertProviderAnswer(second, beta.sessionId, "beta");
	await second.close();

	const restarted = await start("alpha");
	for (const [provider, { sessionId }] of [
		["alpha", alpha],
		["beta", beta],
	] as const) {
		await restarted.request("session/load", { ...workspace, sessionId });
		await assertProviderAnswer(restarted, sessionId, provider);
	}
	await restarted.close();

	const withoutBeta = await f.client({
		...routingConfig,
		PID_ACP_PROVIDER_CONFIG: routingProviders.alpha,
		PID_ACP_PROVIDER: undefined,
	});
	await assert.rejects(
		withoutBeta.request("session/load", {
			...workspace,
			sessionId: beta.sessionId,
		}),
		/Restore its workspace and compatible provider\/model\/runtime/,
	);
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
