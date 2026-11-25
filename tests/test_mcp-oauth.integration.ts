import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ConversationId } from "@earendil-works/pi-durable";
import { McpConfigurationError, loadMcpConfig } from "../dist/mcp-config.js";
import { McpAdapter } from "../dist/mcp.js";
import { waitFor } from "./helpers/client.ts";
import { startMcpHttpFixture } from "./helpers/mcp-http-fixture.ts";
import {
	clientId,
	listenOAuthFixture,
	privateFixture,
	startMcpOAuthFixture,
} from "./helpers/mcp-oauth-fixture.ts";
import { persistenceFixture } from "./helpers/persistence.ts";

const piBinary = process.env.PID_ACP_TEST_PI;
const exec = promisify(execFile);
const name = "project-docs";
const other = { serverUrl: "https://another.example/mcp", note: "preserve-me" };
const otherKey = `mcp__another|${other.serverUrl}`;
const toolPrompt = JSON.stringify({
	name: "codemode",
	args: { code: "text(await tools.mcp__project_docs__mutate({}));" },
});

async function setup(t: TestContext) {
	const disk = await persistenceFixture(t);
	const http = await startMcpOAuthFixture(t);
	const dir = join(disk.root, "agent");
	const home = join(disk.root, "home");
	await mkdir(dir, { mode: 0o700 });
	await mkdir(home, { mode: 0o700 });
	const authFile = join(dir, "mcp-auth.json");
	const path = join(dir, "mcp.json");
	const key = `mcp__project_docs|${http.url}`;
	const entry = { url: http.url, oauth: { clientId, scope: "offline_access" } };
	await writeFile(path, JSON.stringify({ mcpServers: { [name]: entry } }));
	const env = {
		PID_ACP_MCP_CONFIG: path,
		PID_ACP_MCP_AUTH_FILE: authFile,
		HOME: home,
		PI_CODING_AGENT_DIR: dir,
	};
	const write = (state: unknown) =>
		writeFile(authFile, JSON.stringify(state), { mode: 0o600 });
	const read = async () => JSON.parse(await readFile(authFile, "utf8"));
	const state = {
		serverUrl: http.url,
		tokens: http.issue(),
		tokensExpireAt: Date.now() - 1,
	};
	const seed = (extras = {}) =>
		write({ [key]: { ...state, ...extras }, [otherKey]: other });
	const getAdapter = async () => {
		const adapter = new McpAdapter({
			...(await loadMcpConfig({ path, required: true }, env)),
			oauthFile: authFile,
		});
		t.after(() => adapter.close());
		return adapter;
	};
	return {
		...disk,
		http,
		dir,
		home,
		authFile,
		path,
		env,
		key,
		entry,
		state,
		seed,
		read,
		write,
		getAdapter,
		async client() {
			return disk.client({
				...env,
				PID_ACP_PROVIDERS: resolve("tests/helpers/mcp-provider.ts"),
			});
		},
	};
}

function safeFailure(message: RegExp) {
	return (error: Error) => {
		assert.ok(error instanceof McpConfigurationError);
		assert.match(error.message, message);
		assert.doesNotMatch(String(error.stack), privateFixture);
		assert.equal(error.cause, undefined);
		return true;
	};
}

test("discovery sends the stored bearer for an expired grant without refreshing until challenged", async (t) => {
	const f = await setup(t);
	await f.seed();
	const adapter = await f.getAdapter();
	assert.equal((await adapter.discover(f.cwd)).tools.length, 1);
	assert.equal(f.http.counts.refreshes, 0);
	assert.ok(f.http.requests[0]?.accepted);
	f.http.expire();
	assert.equal((await adapter.discover(f.cwd)).tools.length, 1);
	assert.equal(f.http.counts.refreshes, 1);
	assert.equal(
		(await f.read())[f.key].tokens.refresh_token,
		f.http.tokens().refresh_token,
	);
	assert.deepEqual((await f.read())[otherKey], other);
});

for (const endpoint of ["resource", "issuer", "token"] as const) {
	for (const status of [307, 308]) {
		test(`OAuth ${endpoint} ${status} redirect never reaches a second origin`, async (t) => {
			const f = await setup(t);
			await f.seed();
			let forwarded = 0;
			const target = await listenOAuthFixture(t, (_req, res) => {
				forwarded++;
				res.end();
			});
			f.http.behavior.redirect = { endpoint, target, status };
			const adapter = await f.getAdapter();
			await adapter.discover(f.cwd);
			assert.equal(f.http.counts.refreshes, 0);
			f.http.expire();
			await assert.rejects(
				adapter.discover(f.cwd),
				safeFailure(/OAuth refresh failed/),
			);
			assert.equal(f.http.counts.refreshes, endpoint === "token" ? 1 : 0);
			assert.equal(forwarded, 0);
			assert.deepEqual((await f.read())[f.key].tokens, f.state.tokens);
		});
	}
}

test("missing, legacy and nonrenewable grants fail before dispatch with login guidance; malformed or incompatible state fails closed", async (t) => {
	const f = await setup(t);
	const adapter = await f.getAdapter();
	const login = safeFailure(/pi mcp login project-docs.*restart pid-acp/);
	await assert.rejects(adapter.discover(f.cwd), login);
	await f.write({ [f.http.url]: f.state });
	await assert.rejects(adapter.discover(f.cwd), login);
	await f.seed({ tokens: { ...f.state.tokens, refresh_token: undefined } });
	await assert.rejects(adapter.discover(f.cwd), login);
	await f.seed({
		clientInformation: {
			client_id: clientId,
			client_secret: "PRIVATE_OAUTH_SECRET",
		},
	});
	await assert.rejects(
		adapter.discover(f.cwd),
		safeFailure(/supported pre-registered public client/),
	);
	await f.seed({ clientInformation: { client_id: "other-public-client" } });
	await assert.rejects(
		adapter.discover(f.cwd),
		safeFailure(/supported pre-registered public client/),
	);
	await f.seed({ serverUrl: "https://different.example/mcp" });
	await assert.rejects(
		adapter.discover(f.cwd),
		safeFailure(/Pi OAuth store is invalid or inaccessible/),
	);
	await writeFile(f.authFile, '{"PRIVATE_OAUTH_MALFORMED');
	await assert.rejects(
		adapter.discover(f.cwd),
		safeFailure(/Pi OAuth store is invalid or inaccessible/),
	);
	await assert.rejects(
		exec(process.execPath, [resolve("dist/main.js")], {
			cwd: f.cwd,
			timeout: 5000,
			env: {
				...f.env,
				PID_ACP_PROVIDERS: resolve("tests/helpers/mcp-provider.ts"),
				PID_ACP_MODEL: "faux-1",
			},
		}),
		(error: Error & { stdout: string; stderr: string; code: number }) => {
			assert.equal(error.code, 1);
			assert.equal(error.stdout, "");
			assert.match(error.stderr, /Pi OAuth store is invalid or inaccessible/);
			assert.doesNotMatch(error.stderr, privateFixture);
			return true;
		},
	);
	assert.equal(f.http.requests.length, 0);
});

test("conversation setup keeps healthy servers usable and retains a safe OAuth failure", async (t) => {
	const f = await setup(t);
	const healthy = await startMcpHttpFixture();
	t.after(() => healthy.close());
	await writeFile(
		f.path,
		JSON.stringify({
			mcpServers: {
				[name]: f.entry,
				static: {
					url: healthy.url,
					headers: { Authorization: "Bearer fixture" },
				},
			},
		}),
	);
	await f.seed();
	const adapter = await f.getAdapter();
	await adapter.discover(f.cwd);
	await f.write({ [otherKey]: other });
	const id = 1 as ConversationId;
	await adapter.prepare(id, f.cwd);
	const [oauthStatus, staticStatus] = adapter.getStatus(id);
	assert.match(oauthStatus?.status ?? "", /pi mcp login project-docs/);
	assert.equal(staticStatus?.status, "connected");
});

test("two concurrent ACP conversations share one rotation, with one post-auth effect per call and no retry of ambiguous failures", {
	timeout: 20_000,
}, async (t) => {
	const f = await setup(t);
	await f.seed();
	const client = await f.client();
	const newSession = () =>
		client.request("session/new", { cwd: f.cwd, mcpServers: [] });
	const [a, b] = await Promise.all([newSession(), newSession()]);
	// Prime both conversation-owned clients before challenging their mutations.
	const status = JSON.stringify({
		name: "codemode",
		args: { code: 'text("ready");' },
	});
	await Promise.all([
		client.prompt(status, a.sessionId),
		client.prompt(status, b.sessionId),
	]);
	f.http.expire();
	const gate = Promise.withResolvers<void>();
	f.http.behavior.pause = gate.promise;
	const challenges = Promise.withResolvers<void>();
	// Both requests must acquire the stale token before the first 401 can start refresh.
	f.http.behavior.pauseToolChallenge = challenges.promise;
	const pending = Promise.all([
		client.prompt(toolPrompt, a.sessionId),
		client.prompt(toolPrompt, b.sessionId),
	]);
	void pending.catch(() => {});
	try {
		await waitFor(
			() =>
				f.http.requests.filter((r) => !r.accepted && r.method === "tools/call")
					.length === 2,
		);
		challenges.resolve();
		await waitFor(() => f.http.counts.refreshes === 1);
		assert.equal(f.http.counts.effects, 0);
	} finally {
		challenges.resolve();
		gate.resolve();
	}
	await pending;
	const calls = f.http.requests.filter((r) => r.method === "tools/call");
	assert.deepEqual(f.http.counts, { refreshes: 1, exchanges: 0, effects: 2 });
	assert.equal(calls.length, 4);
	assert.equal(new Set(calls.map((r) => r.session)).size, 2);

	f.http.behavior.failCall = true;
	const start = client.updates.length;
	await client.prompt(toolPrompt, a.sessionId);
	await client.waitForAnswer(
		(text) => text.includes("interrupted external effect"),
		start,
	);
	assert.equal(f.http.counts.effects, 3);
	assert.equal(
		f.http.requests.filter((r) => r.method === "tools/call").length,
		5,
	);

	f.http.behavior.failCall = false;
	f.http.behavior.refresh = "revoked";
	f.http.expire();
	const revoked = client.updates.length;
	await client.prompt(toolPrompt, b.sessionId);
	await client.waitForAnswer(
		(text) => text.includes("pi mcp login project-docs"),
		revoked,
	);
	assert.equal(f.http.counts.effects, 3);
	assert.equal((await f.read())[f.key].tokens, undefined);
	assert.doesNotMatch(
		JSON.stringify(client.wire) + client.stderr,
		privateFixture,
	);
	await client.close();
	for (const entry of await readdir(f.sessions, {
		withFileTypes: true,
		recursive: true,
	})) {
		if (entry.isFile())
			assert.doesNotMatch(
				await readFile(join(entry.parentPath, entry.name), "utf8"),
				privateFixture,
			);
	}
});

test("ACP cancellation and orderly EOF join an uncancellable rotation without replaying the cancelled call", {
	timeout: 20_000,
}, async (t) => {
	const f = await setup(t);
	await f.seed();
	const client = await f.client();
	const { sessionId } = await client.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await client.prompt(
		JSON.stringify({ name: "codemode", args: { code: 'text("ready");' } }),
		sessionId,
	);
	f.http.expire();
	const gate = Promise.withResolvers<void>();
	f.http.behavior.pause = gate.promise;
	const prompt = client.prompt(toolPrompt, sessionId);
	void prompt.catch(() => {});
	try {
		await waitFor(() => f.http.counts.refreshes === 1);
		await client.cancel(sessionId);
		assert.equal((await prompt).stopReason, "cancelled");
		const closing = client.close();
		void closing.catch(() => {});
		await waitFor(() => f.http.deleted.length === 2);
		assert.equal(client.child.exitCode, null);
		gate.resolve();
		await closing;
		assert.deepEqual(await client.exited, [0, null]);
	} finally {
		gate.resolve();
	}
	assert.equal(
		f.http.requests.filter((r) => r.method === "tools/call").length,
		1,
	);
	assert.equal(f.http.counts.effects, 0);
	assert.equal(
		(await f.read())[f.key].tokens.refresh_token,
		f.http.tokens().refresh_token,
	);
	assert.deepEqual((await f.read())[otherKey], other);
});

test("Pi CLI bootstraps and reauthorizes; Pi and pid-acp serialize a real cross-process rotation", {
	skip: !piBinary && "set PID_ACP_TEST_PI to a Pi CLI executable",
	timeout: 30_000,
}, async (t) => {
	assert.ok(piBinary);
	const f = await setup(t);
	f.http.expire();
	const piPath = join(f.home, "bin");
	await mkdir(piPath);
	// Never run a browser on the host. Drive the mock approval and real loopback callback below.
	await writeFile(join(piPath, "xdg-open"), "#!/bin/sh\nexit 0\n", {
		mode: 0o700,
	});
	const options = {
		cwd: f.cwd,
		timeout: 10_000,
		env: {
			PATH: `${piPath}:${process.env.PATH}`,
			HOME: f.home,
			PI_CODING_AGENT_DIR: f.dir,
		},
	};
	// Add a marker only to the Pi-side config to identify which process dispatched a request.
	await writeFile(
		join(f.dir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				[name]: { ...f.entry, headers: { "X-Fixture-Peer": "pi" } },
			},
		}),
	);
	// pid-acp deliberately selects a different config file but the exact same live store.
	const acpConfig = join(f.root, "pid-acp-mcp.json");
	await writeFile(
		acpConfig,
		JSON.stringify({ mcpServers: { [name]: f.entry } }),
	);
	const adapter = async () =>
		new McpAdapter({
			...(await loadMcpConfig({ path: acpConfig, required: true })),
			oauthFile: f.authFile,
		});
	async function login() {
		const pending = exec(
			piBinary as string,
			["mcp", "login", name, "--timeout", "7"],
			options,
		);
		void pending.catch(() => {});
		let stdout = "";
		pending.child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		const prefix = `${new URL(f.http.url).origin}/authorize?`;
		await waitFor(() =>
			stdout.split("\n").some((line) => line.startsWith(prefix)),
		);
		const authorizationUrl = stdout
			.split("\n")
			.find((line) => line.startsWith(prefix));
		assert.ok(authorizationUrl);
		assert.equal(
			(await fetch(authorizationUrl, { signal: AbortSignal.timeout(5000) }))
				.status,
			200,
		);
		assert.match((await pending).stdout, /Signed in to MCP server/);
	}
	await login();
	const records = await f.read();
	assert.equal(records[f.key].clientInformation, undefined);
	assert.equal((await stat(f.authFile)).mode & 0o777, 0o600);
	assert.equal(
		records[f.key].tokens.refresh_token,
		f.http.tokens().refresh_token,
	);
	await f.write({ ...records, [otherKey]: other });
	const first = await adapter();
	t.after(() => first.close());
	await first.discover(f.cwd);
	f.http.expire();
	const gate = Promise.withResolvers<void>();
	f.http.behavior.pause = gate.promise;
	const pi = exec(piBinary, ["mcp", "list"], options);
	void pi.catch(() => {});
	try {
		await waitFor(() => f.http.counts.refreshes === 1);
		const hash = createHash("sha256").update(f.key).digest("hex").slice(0, 16);
		assert.ok(
			(await stat(join(f.dir, `mcp-auth-refresh-${hash}.lock`))).isDirectory(),
		);
		const before = f.http.requests.length;
		const discovering = first.discover(f.cwd);
		void discovering.catch(() => {});
		await waitFor(() =>
			f.http.requests
				.slice(before)
				.some((r) => r.method === "initialize" && !r.accepted && !r.peer),
		);
		await delay(200);
		assert.equal(f.http.counts.refreshes, 1);
		gate.resolve();
		await discovering;
		assert.match((await pi).stdout, /connected/);
	} finally {
		gate.resolve();
	}
	assert.equal(f.http.counts.refreshes, 1);
	assert.deepEqual((await f.read())[otherKey], other);
	await first.close();
	const restarted = await adapter();
	t.after(() => restarted.close());
	await restarted.discover(f.cwd);
	assert.equal(f.http.counts.refreshes, 1);
	await restarted.close();
	await exec(piBinary, ["mcp", "logout", name], options);
	assert.equal((await f.read())[f.key], undefined);
	f.http.expire();
	await login();
	const reauthorized = await adapter();
	t.after(() => reauthorized.close());
	await reauthorized.discover(f.cwd);
	assert.equal(f.http.counts.exchanges, 2);
	assert.deepEqual((await f.read())[otherKey], other);
});
