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
	privateOAuthMarker,
	registeredClient,
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

async function setup(
	t: TestContext,
	mode: "explicit" | "dynamic" = "explicit",
) {
	const disk = await persistenceFixture(t);
	const http = await startMcpOAuthFixture(t, mode);
	const dir = join(disk.root, "agent");
	const home = join(disk.root, "home");
	await mkdir(dir, { mode: 0o700 });
	await mkdir(home, { mode: 0o700 });
	const authFile = join(dir, "mcp-auth.json");
	const path = join(dir, "mcp.json");
	const key = `mcp__project_docs|${http.url}`;
	const entry = {
		url: http.url,
		oauth: mode === "dynamic" ? {} : { clientId, scope: "offline_access" },
	};
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
		discovery: http.discovery,
		tokens: http.issue(),
		tokensExpireAt: Date.now() - 1,
	};
	const seed = (extras = {}) =>
		write({ [key]: { ...state, ...extras }, [otherKey]: other });
	const createAdapter = async (configPath = path) => {
		const adapter = new McpAdapter({
			...(await loadMcpConfig({ path: configPath, required: true }, env)),
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
		createAdapter,
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
		assert.doesNotMatch(String(error.stack), privateOAuthMarker);
		assert.equal(error.cause, undefined);
		return true;
	};
}

test("discovery sends the stored bearer for an expired grant without refreshing until challenged", async (t) => {
	const f = await setup(t);
	await f.seed();
	const adapter = await f.createAdapter();
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

test("dynamic refresh uses only the endpoint saved during login, not challenge discovery", async (t) => {
	const f = await setup(t, "dynamic");
	let discoveryRequests = 0;
	const target = await listenOAuthFixture(t, (_req, res) => {
		discoveryRequests++;
		res.writeHead(404).end();
	});
	f.http.behavior.resourceMetadataUrl = `${target}/metadata`;
	const adapter = await f.createAdapter();
	for (const discovery of [
		undefined,
		{ authorizationServerUrl: f.http.discovery.authorizationServerUrl },
	]) {
		await f.seed({
			discovery,
			tokens: f.http.issue(),
			clientInformation: registeredClient,
		});
		assert.equal((await adapter.discover(f.cwd)).tools.length, 1);
		f.http.expire();
		await assert.rejects(
			adapter.discover(f.cwd),
			safeFailure(/pi mcp login project-docs/),
		);
		assert.equal(f.http.counts.refreshes, 0);
		assert.equal(discoveryRequests, 0);
	}
	await f.seed({ tokens: f.http.issue(), clientInformation: registeredClient });
	f.http.expire();
	assert.equal((await adapter.discover(f.cwd)).tools.length, 1);
	assert.equal(f.http.counts.refreshes, 1);
	assert.equal(discoveryRequests, 0);
});

for (const status of [307, 308]) {
	test(`OAuth token ${status} redirect never reaches a second origin`, async (t) => {
		const f = await setup(t, "dynamic");
		await f.seed({ clientInformation: registeredClient });
		let forwarded = 0;
		const target = await listenOAuthFixture(t, (_req, res) => {
			forwarded++;
			res.end();
		});
		f.http.behavior.tokenRedirect = { target, status };
		const adapter = await f.createAdapter();
		await adapter.discover(f.cwd);
		assert.equal(f.http.counts.refreshes, 0);
		f.http.expire();
		await assert.rejects(
			adapter.discover(f.cwd),
			safeFailure(/OAuth refresh failed/),
		);
		assert.equal(f.http.counts.refreshes, 1);
		assert.equal(forwarded, 0);
		assert.deepEqual((await f.read())[f.key].tokens, f.state.tokens);
	});
}

test("missing, legacy and nonrenewable grants fail before dispatch with login guidance; malformed or incompatible state fails closed", async (t) => {
	const f = await setup(t);
	const adapter = await f.createAdapter();
	const login = safeFailure(/pi mcp login project-docs.*restart pid-acp/);
	await assert.rejects(adapter.discover(f.cwd), login);
	await f.write({ [f.http.url]: f.state });
	await assert.rejects(adapter.discover(f.cwd), login);
	await f.seed({ tokens: { ...f.state.tokens, refresh_token: undefined } });
	await assert.rejects(adapter.discover(f.cwd), login);
	for (const client_id of [clientId, "other-public-client"]) {
		await f.seed({ clientInformation: { ...registeredClient, client_id } });
		await assert.rejects(
			adapter.discover(f.cwd),
			safeFailure(/incompatible with the configured client/),
		);
	}
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
			assert.doesNotMatch(error.stderr, privateOAuthMarker);
			return true;
		},
	);
	assert.equal(f.http.requests.length, 0);
});

test("missing or unusable dynamic registration fails before any request with login guidance", async (t) => {
	const f = await setup(t, "dynamic");
	const adapter = await f.createAdapter();
	for (const clientInformation of [
		undefined,
		null,
		"PRIVATE_OAUTH_NOT_AN_OBJECT",
		[],
		{},
		{ client_id: "   " },
		{ ...registeredClient, client_secret: "   " },
		{ ...registeredClient, client_secret: {} },
		{ ...registeredClient, client_secret: undefined },
		{ ...registeredClient, token_endpoint_auth_method: "private_key_jwt" },
		{ ...registeredClient, redirect_uris: null },
	]) {
		await f.seed({ clientInformation });
		await assert.rejects(
			adapter.discover(f.cwd),
			safeFailure(
				/stop all refreshers.*pi mcp login project-docs.*restart pid-acp/,
			),
		);
	}
	assert.equal(f.http.requests.length, 0);
	assert.equal(f.http.registrations, 0);
});

for (const rejection of [
	"invalid_client",
	"unauthorized_client",
	"invalid_grant",
] as const) {
	test(`dynamic refresh handles ${rejection} and preserves pending sign-in state`, async (t) => {
		const f = await setup(t, "dynamic");
		const pending = {
			codeVerifier: "PRIVATE_OAUTH_VERIFIER",
			oauthState: "PRIVATE_OAUTH_STATE",
		};
		await f.seed({ clientInformation: registeredClient, ...pending });
		let rediscovery = 0;
		f.http.behavior.resourceMetadataUrl = await listenOAuthFixture(
			t,
			(_req, res) => {
				rediscovery++;
				res.writeHead(404).end();
			},
		);
		f.http.behavior.refresh = rejection;
		f.http.expire();
		const adapter = await f.createAdapter();
		const login = safeFailure(
			/stop all refreshers.*pi mcp login project-docs.*restart pid-acp/,
		);
		await assert.rejects(adapter.discover(f.cwd), login);
		const saved = (await f.read())[f.key];
		assert.equal(saved.tokens, undefined);
		assert.equal(saved.tokensExpireAt, undefined);
		assert.deepEqual(
			saved.clientInformation,
			rejection === "invalid_grant" ? registeredClient : undefined,
		);
		if (rejection !== "invalid_grant") assert.equal(saved.discovery, undefined);
		assert.equal(saved.codeVerifier, pending.codeVerifier);
		assert.equal(saved.oauthState, pending.oauthState);
		await assert.rejects(adapter.discover(f.cwd), login);
		assert.equal(f.http.counts.refreshes, 1);
		assert.equal(f.http.registrations, 0);
		assert.equal(rediscovery, 0);
	});
}

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
	const adapter = await f.createAdapter();
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
	const f = await setup(t, "dynamic");
	await f.seed({ clientInformation: registeredClient });
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
	f.http.behavior.refresh = "invalid_grant";
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
		privateOAuthMarker,
	);
	await client.close();
	for (const entry of await readdir(f.sessions, {
		withFileTypes: true,
		recursive: true,
	})) {
		if (entry.isFile())
			assert.doesNotMatch(
				await readFile(join(entry.parentPath, entry.name), "utf8"),
				privateOAuthMarker,
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

async function setupPiCli(f: Awaited<ReturnType<typeof setup>>) {
	assert.ok(piBinary);
	const piPath = piBinary;
	const browserShimDir = join(f.home, "bin");
	await mkdir(browserShimDir);
	// Never run a browser on the host. Drive the mock approval and real loopback callback below.
	await writeFile(join(browserShimDir, "xdg-open"), "#!/bin/sh\nexit 0\n", {
		mode: 0o700,
	});
	const options = {
		cwd: f.cwd,
		timeout: 10_000,
		env: {
			PATH: `${browserShimDir}:${process.env.PATH}`,
			HOME: f.home,
			PI_CODING_AGENT_DIR: f.dir,
		},
	};
	async function login() {
		const pending = exec(
			piPath,
			["mcp", "login", name, "--timeout", "7"],
			options,
		);
		void pending.catch(() => {});
		let stdout = "";
		pending.child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		const prefix = `${new URL(f.http.url).origin}/authorize?`;
		const findAuthorizationUrl = () =>
			stdout.split("\n").find((line) => line.startsWith(prefix));
		try {
			await waitFor(() => findAuthorizationUrl() !== undefined);
			const authorizationUrl = findAuthorizationUrl();
			assert.ok(authorizationUrl);
			assert.equal(
				(await fetch(authorizationUrl, { signal: AbortSignal.timeout(5000) }))
					.status,
				200,
			);
			assert.match((await pending).stdout, /Signed in to MCP server/);
		} finally {
			if (pending.child.exitCode === null && pending.child.signalCode === null)
				pending.child.kill();
			await pending.catch(() => undefined);
		}
	}
	return { login, piPath, options };
}

test("Pi CLI registers once; pid-acp calls tools, rotates with the saved secret and restarts", {
	skip: !piBinary && "set PID_ACP_TEST_PI to a Pi CLI executable",
	timeout: 30_000,
}, async (t) => {
	const f = await setup(t, "dynamic");
	const { login } = await setupPiCli(f);
	await login();
	assert.equal(f.http.registrations, 1);
	assert.equal((await stat(f.authFile)).mode & 0o777, 0o600);
	const records = await f.read();
	const original = records[f.key];
	assert.equal(original.clientInformation.redirect_uris.length, 1);
	assert.deepEqual(original.clientInformation, {
		...registeredClient,
		redirect_uris: original.clientInformation.redirect_uris,
	});
	assert.equal(original.tokens.refresh_token, f.http.tokens().refresh_token);
	await f.write({ ...records, [otherKey]: other });

	type Client = Awaited<ReturnType<typeof f.client>>;
	const newSession = async (client: Client) =>
		(await client.request("session/new", { cwd: f.cwd, mcpServers: [] }))
			.sessionId;
	async function callTool(client: Client, sessionId: string) {
		const start = client.updates.length;
		await client.prompt(toolPrompt, sessionId);
		await client.waitForAnswer(
			(text) => text.includes("structuredContent"),
			start,
		);
		assert.doesNotMatch(
			JSON.stringify(client.wire) + client.stderr,
			privateOAuthMarker,
		);
	}
	const first = await f.client();
	const sessionId = await newSession(first);
	await callTool(first, sessionId);
	assert.deepEqual(f.http.counts, { refreshes: 0, exchanges: 1, effects: 1 });
	f.http.expire();
	await callTool(first, sessionId);
	await first.close();
	assert.deepEqual(f.http.counts, { refreshes: 1, exchanges: 1, effects: 2 });

	const rotated = (await f.read())[f.key];
	assert.notEqual(rotated.tokens.refresh_token, original.tokens.refresh_token);
	assert.equal(rotated.tokens.refresh_token, f.http.tokens().refresh_token);
	assert.deepEqual(rotated.clientInformation, original.clientInformation);
	const restarted = await f.client();
	await callTool(restarted, await newSession(restarted));
	await restarted.close();
	assert.deepEqual(f.http.counts, { refreshes: 1, exchanges: 1, effects: 3 });
	assert.equal(f.http.registrations, 1);
	assert.deepEqual((await f.read())[f.key], rotated);
	assert.deepEqual((await f.read())[otherKey], other);
});

test("Pi CLI bootstraps and reauthorizes; Pi and pid-acp serialize a real cross-process rotation", {
	skip: !piBinary && "set PID_ACP_TEST_PI to a Pi CLI executable",
	timeout: 30_000,
}, async (t) => {
	const f = await setup(t);
	const { login, piPath, options } = await setupPiCli(f);
	f.http.expire();
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
	await login();
	const records = await f.read();
	assert.equal(records[f.key].clientInformation, undefined);
	assert.equal((await stat(f.authFile)).mode & 0o777, 0o600);
	assert.equal(
		records[f.key].tokens.refresh_token,
		f.http.tokens().refresh_token,
	);
	await f.write({ ...records, [otherKey]: other });
	const first = await f.createAdapter(acpConfig);
	await first.discover(f.cwd);
	f.http.expire();
	const gate = Promise.withResolvers<void>();
	f.http.behavior.pause = gate.promise;
	const pi = exec(piPath, ["mcp", "list"], options);
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
		await pi.catch(() => undefined);
	}
	assert.equal(f.http.counts.refreshes, 1);
	assert.deepEqual((await f.read())[otherKey], other);
	await first.close();
	const restarted = await f.createAdapter(acpConfig);
	await restarted.discover(f.cwd);
	assert.equal(f.http.counts.refreshes, 1);
	await restarted.close();
	await exec(piPath, ["mcp", "logout", name], options);
	assert.equal((await f.read())[f.key], undefined);
	f.http.expire();
	await login();
	const reauthorized = await f.createAdapter(acpConfig);
	await reauthorized.discover(f.cwd);
	assert.equal(f.http.counts.exchanges, 2);
	assert.deepEqual((await f.read())[otherKey], other);
});
