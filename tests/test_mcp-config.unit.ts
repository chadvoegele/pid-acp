// biome-ignore-all lint/suspicious/noTemplateCurlyInString: MCP fixtures intentionally contain literal environment templates.
import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { validateMcpServerConfig } from "@earendil-works/pi-mcp";
import { readConfig } from "../dist/config.js";
import {
	getMcpToolExposure,
	loadMcpConfig,
	resolveMcpStdioOptions,
} from "../dist/mcp-config.js";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pid-mcp-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "mcp.json");
	return {
		root,
		path,
		async load(value: unknown, env: NodeJS.ProcessEnv = {}) {
			await writeFile(path, JSON.stringify(value), { mode: 0o600 });
			return loadMcpConfig({ path, required: true }, env);
		},
		async source(source: string) {
			await writeFile(path, source, { mode: 0o600 });
			return loadMcpConfig({ path, required: true }, {});
		},
	};
}

const launch = {
	PID_ACP_PROVIDERS: "/fixture/provider.mjs",
	PID_ACP_MODEL: "fixture",
};

test("MCP path selects only the Pi user file or an explicit replacement; empty disables", () => {
	assert.deepEqual(
		readConfig({ ...launch, PI_CODING_AGENT_DIR: "/not-used" }).mcpConfig,
		{ path: join(homedir(), ".pi", "agent", "mcp.json"), required: false },
	);
	assert.deepEqual(
		readConfig({ ...launch, PID_ACP_MCP_CONFIG: "/fixture/alternate.json" })
			.mcpConfig,
		{ path: "/fixture/alternate.json", required: true },
	);
	assert.equal(
		readConfig({ ...launch, PID_ACP_MCP_CONFIG: "" }).mcpConfig,
		undefined,
	);
	for (const path of ["relative.json", "~/mcp.json", " "])
		assert.throws(
			() => readConfig({ ...launch, PID_ACP_MCP_CONFIG: path }),
			/PID_ACP_MCP_CONFIG/,
		);
});

test("disabled and missing default do no configuration work; explicit missing fails sanitized", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(await loadMcpConfig(undefined, {}), {
		servers: [],
	});
	const path = join(f.root, "missing-SECRET.json");
	assert.deepEqual(await loadMcpConfig({ path, required: false }, {}), {
		servers: [],
	});
	await assert.rejects(
		loadMcpConfig({ path, required: true }, {}),
		(error: Error) => {
			assert.match(error.message, /Could not read/);
			assert.ok(!error.message.includes("SECRET"));
			return true;
		},
	);
});

test("ordinary JSON parsing validates the application container without parser excerpts", async (t) => {
	const f = await fixture(t);
	for (const source of [
		'{"mcpServers": SECRET}',
		'{"mcpServers": {},}',
		"mcpServers: {}",
	])
		await assert.rejects(f.source(source), (error: Error) => {
			assert.match(error.message, /valid JSON/);
			assert.ok(!error.message.includes("SECRET"));
			return true;
		});
	for (const value of [null, [], {}, { mcpServers: [] }, { mcpServers: null }])
		await assert.rejects(f.load(value), /mcpServers object/);
	assert.deepEqual(
		await f.source('{"mcpServers":{"old":{"command":"x"}},"mcpServers":{}}'),
		{ servers: [] },
	);
});

test("base validation follows the public upstream validator, including transport precedence", async (t) => {
	const f = await fixture(t);
	const entries = [
		null,
		[],
		{},
		{ command: 1 },
		{ command: "x", args: [1] },
		{ command: "x", env: { TOKEN: false } },
		{ command: "x", cwd: 1 },
		{ command: "x", enabled: "false" },
		{ command: "x", description: 1 },
		{ command: "x", timeout: 0 },
		{ command: "x", timeout: -1 },
		{ url: "not-a-url-SECRET" },
		{ url: "ftp://fixture.invalid/SECRET" },
		{ url: "https://fixture.invalid", headers: { TOKEN: 1 } },
		{ type: "sse", url: "https://fixture.invalid" },
		{ type: "other", command: "x" },
		{ command: " " },
		{ command: "" },
		{ command: "x", timeout: 12 },
		{ url: "http://fixture.invalid", command: "x" },
		{ type: "stdio", url: "ignored", command: "x" },
		{ type: "streamable-http", url: "https://fixture.invalid" },
	];
	for (const entry of entries) {
		const checked = validateMcpServerConfig("fixture", entry);
		if (checked.kind === "invalid") {
			await assert.rejects(
				f.load({ mcpServers: { fixture: entry } }),
				(error: Error) => {
					assert.match(error.message, /MCP configuration/);
					assert.ok(!error.message.includes("SECRET"));
					return true;
				},
			);
			continue;
		}
		const loaded = (await f.load({ mcpServers: { fixture: entry } }))
			.servers[0];
		assert.equal(loaded?.kind, checked.kind);
	}
	const infinite = await f.source(
		'{"mcpServers":{"fixture":{"command":"x","timeout":1e999}}}',
	);
	const [infiniteServer] = infinite.servers;
	assert.ok(infiniteServer?.kind === "stdio");
	assert.equal(infiniteServer.config.timeout, Infinity);
});

test("unsupported active features fail actionably; disabled entries and inert extensions stay inert", async (t) => {
	const f = await fixture(t);
	for (const extra of [
		{ oauth: {} },
		{ auth: "SECRET" },
		{ authProvider: "SECRET" },
		{ roots: ["SECRET"] },
		{ exposure: "direct" },
		{ exposure: "deferred" },
		{ toolExposure: { "*": "direct" } },
	])
		await assert.rejects(
			f.load({ mcpServers: { fixture: { command: "x", ...extra } } }),
			(error: Error) => {
				assert.match(error.message, /Correct the selected mcp.json/);
				assert.ok(!error.message.includes("SECRET"));
				return true;
			},
		);
	await assert.rejects(
		f.load({ mcpServers: {}, autoEnableCodemode: false }),
		/autoEnableCodemode/,
	);
	assert.equal(
		(
			await f.load({
				extra: "SECRET",
				mcpServers: { fixture: { command: "x", extra: "SECRET" } },
			})
		).servers.length,
		1,
	);
	assert.deepEqual(
		await f.load({
			mcpServers: {
				"disabled invalid name": {
					enabled: false,
					oauth: "invalid",
					exposure: "direct",
					env: { TOKEN: "!cmd SECRET" },
				},
			},
			autoEnableCodemode: true,
		}),
		{ servers: [] },
	);
});

test("HTTP OAuth opts into a literal public client", async (t) => {
	const f = await fixture(t);
	const oauth = {
		clientId: "public-fixture",
		scope: "offline_access",
		callbackUrl: "http://127.0.0.1:8765/callback",
		callbackPort: 8765,
	};
	const entry = { url: "https://example.test/mcp", oauth };
	const config = { mcpServers: { "fixture-docs": entry } };
	const [server] = (await f.load(config)).servers;
	assert.ok(server?.kind === "http");
	assert.deepEqual(server.config.oauth, oauth);
	for (const invalid of [
		{ ...entry, url: "http://example.test/mcp" },
		{ ...entry, url: "https://user:SECRET@example.test/mcp" },
		{ ...entry, url: "https://example.test/mcp#SECRET" },
		{ ...entry, headers: { aUtHoRiZaTiOn: "SECRET" } },
		{ ...entry, oauth: {} },
		...[
			{ clientId: "  " },
			{ clientId: "!SECRET" },
			{ clientId: "${SECRET}" },
			{ scope: "${SECRET}" },
			{ clientSecret: "SECRET" },
			{ clientName: "SECRET" },
			{ clientRegistration: "dcr" },
			{ clientRegistration: "cimd" },
			{ authServerMetadataUrl: "https://secret.example/" },
			{ extra: "SECRET" },
			{ callbackUrl: "http://example.test/SECRET" },
		].map((options) => ({ ...entry, oauth: { ...oauth, ...options } })),
	]) {
		await assert.rejects(
			f.load({ mcpServers: { fixture: invalid } }),
			(error: Error) => {
				assert.match(error.message, /MCP configuration:/);
				assert.doesNotMatch(error.message, /SECRET|secret\.example/);
				return true;
			},
		);
	}
	await assert.rejects(
		f.load({
			mcpServers: {
				...config.mcpServers,
				fixture_docs: { command: "fixture" },
			},
		}),
		/share a namespace/,
	);
	assert.equal(
		(
			await f.load({
				mcpServers: {
					...config.mcpServers,
					fixture_docs: { ...entry, enabled: false },
				},
			})
		).servers.length,
		1,
	);
	assert.equal(
		(
			await f.load({
				mcpServers: { fixture: { ...entry, url: "http://127.0.0.1:9000/mcp" } },
			})
		).servers.length,
		1,
	);
});

test("config uses only its selected file and delegates server-name syntax without a length cap", async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.root, ".pi"));
	await writeFile(join(f.root, ".pi", "mcp.json"), "not JSON, never read");
	assert.equal(
		(await f.load({ mcpServers: { only: { command: "fixture" } } })).servers
			.length,
		1,
	);
	for (const name of ["", "SECRET space", 'SECRET"\n'])
		await assert.rejects(
			f.load({ mcpServers: { [name]: { command: "fixture" } } }),
			(error: Error) => {
				assert.match(error.message, /Server names/);
				assert.ok(!error.message.includes("SECRET"));
				return true;
			},
		);
	assert.equal(
		(await f.load({ mcpServers: { ["a".repeat(80)]: { command: "x" } } }))
			.servers.length,
		1,
	);
	assert.equal(
		(
			await f.load({
				mcpServers: { "a-b": { command: "x" }, a_b: { command: "x" } },
			})
		).servers.length,
		2,
	);
});

test("stdio uses argv, one-pass env expansion, upstream inheritance defaults and conversation-relative cwd", async (t) => {
	const f = await fixture(t);
	const env = {
		TOKEN: "private-token",
		RECURSIVE: "${TOKEN}",
		PRIVATE_AMBIENT: "SECRET",
	};
	const configuration = await f.load(
		{
			mcpServers: {
				fixture: {
					command: "program",
					args: ["--literal", "$(not-a-shell)", "${TOKEN}"],
					cwd: "relative",
					env: {
						TOKEN: "Bearer ${TOKEN}",
						RECURSIVE: "${RECURSIVE}",
						EMPTY: "",
					},
					description: "Fixture",
					timeout: 12,
				},
			},
		},
		env,
	);
	const server = configuration.servers[0];
	assert.ok(server?.kind === "stdio");
	assert.equal(server.config.timeout, 12);
	assert.equal(server.config.description, "Fixture");
	assert.equal(server.config.exposure, "codemode");
	assert.deepEqual(server.config.env, {
		TOKEN: "Bearer private-token",
		RECURSIVE: "${TOKEN}",
		EMPTY: "",
	});
	env.TOKEN = "changed";
	assert.equal(server.config.env.TOKEN, "Bearer private-token");
	assert.deepEqual(resolveMcpStdioOptions(server, "/workspace/a"), {
		command: "program",
		args: ["--literal", "$(not-a-shell)", "${TOKEN}"],
		cwd: "/workspace/a/relative",
		env: server.config.env,
		inheritEnv: undefined,
	});
	assert.equal(
		resolveMcpStdioOptions(server, "/workspace/b").cwd,
		"/workspace/b/relative",
	);
	for (const inheritEnv of [undefined, true, false]) {
		const entry = (
			await f.load({
				mcpServers: {
					fixture: {
						command: "program",
						inheritEnv,
						env: { EXPLICIT: "allowed" },
						stderr: "inherit",
					},
				},
			})
		).servers[0];
		assert.ok(entry?.kind === "stdio");
		const options = resolveMcpStdioOptions(entry, "/workspace");
		assert.deepEqual(options.env, { EXPLICIT: "allowed" });
		assert.equal(options.inheritEnv, inheritEnv === false ? false : undefined);
		assert.equal(options.cwd, "/workspace");
		assert.equal(options.stderr, undefined);
	}
	for (const inheritEnv of [null, "false", 0])
		await assert.rejects(
			f.load({ mcpServers: { fixture: { command: "x", inheritEnv } } }),
			/inheritEnv must be a boolean/,
		);
	const absolute = (
		await f.load({
			mcpServers: { fixture: { command: "program", cwd: "/explicit" } },
		})
	).servers[0];
	assert.ok(absolute?.kind === "stdio");
	assert.equal(resolveMcpStdioOptions(absolute, "/workspace").cwd, "/explicit");
});

test("missing env disables only its server; errors expose field categories, not names or values", async (t) => {
	const f = await fixture(t);
	const config = await f.load({
		mcpServers: {
			healthy: { command: "x" },
			env_missing: { command: "x", env: { SECRET_FIELD: "${SECRET_NAME}" } },
			http_missing: {
				url: "https://fixture.invalid",
				headers: { SECRET_HEADER: "${SECRET_NAME}" },
			},
		},
	});
	assert.deepEqual(
		config.servers.map(({ name, kind }) => ({ name, kind })),
		[
			{ name: "env_missing", kind: "blocked" },
			{ name: "healthy", kind: "stdio" },
			{ name: "http_missing", kind: "blocked" },
		],
	);
	const blocked = config.servers.filter((server) => server.kind === "blocked");
	assert.ok(blocked[0] && blocked[1]);
	assert.match(blocked[0].issue, /in env/);
	assert.match(blocked[1].issue, /in headers/);
	assert.ok(!JSON.stringify(blocked).includes("SECRET"));
	const inherited = await f.load({
		mcpServers: { fixture: { command: "x", env: { TOKEN: "${toString}" } } },
	});
	assert.equal(inherited.servers[0]?.kind, "blocked");
	for (const entry of [
		{ command: "x", env: { TOKEN: "!cmd SECRET" } },
		{
			url: "https://fixture.invalid",
			headers: { Authorization: "  !cmd SECRET" },
		},
	])
		await assert.rejects(
			f.load({ mcpServers: { fixture: entry } }),
			(error: Error) => {
				assert.match(error.message, /command helpers/);
				assert.ok(!error.message.includes("SECRET"));
				return true;
			},
		);
});

test("HTTP delegates URL semantics upstream and expands only header values", async (t) => {
	const f = await fixture(t);
	for (const url of [
		"https://fixture.invalid/mcp?key=SECRET",
		"http://fixture.invalid/mcp",
		"http://127.0.0.1/mcp",
		"http://localhost/mcp",
		"http://[::1]/mcp",
		"https://user:SECRET@fixture.invalid",
		"https://fixture.invalid/#SECRET",
		"https://fixture.invalid/${TOKEN}",
	]) {
		const server = (
			await f.load(
				{
					mcpServers: {
						fixture: {
							type: "streamable-http",
							url,
							headers: { Authorization: "Bearer ${TOKEN}" },
						},
					},
				},
				{ TOKEN: "private" },
			)
		).servers[0];
		assert.ok(server?.kind === "http");
		assert.equal(server.config.url, url);
		assert.deepEqual(server.config.headers, {
			Authorization: "Bearer private",
		});
	}
});

test("exposure aliases normalize; exact names beat first matching wildcard with literal regex characters", async (t) => {
	const f = await fixture(t);
	const server = (
		await f.load({
			mcpServers: {
				fixture: {
					command: "x",
					exposure: "hidden",
					toolExposure: {
						"read*": "hidden",
						"*": "codemode-deferred",
						read_exact: "codemode",
					},
				},
			},
		})
	).servers[0];
	assert.ok(server?.kind === "stdio");
	assert.equal(getMcpToolExposure(server, "read_exact"), "codemode");
	assert.equal(getMcpToolExposure(server, "read_other"), "hidden");
	assert.equal(getMcpToolExposure(server, "other"), "codemode");
	const literal = (
		await f.load({
			mcpServers: {
				fixture: { command: "x", toolExposure: { "tool.[*": "hidden" } },
			},
		})
	).servers[0];
	assert.ok(literal?.kind === "stdio");
	assert.equal(getMcpToolExposure(literal, "tool.[value"), "hidden");
	assert.equal(getMcpToolExposure(literal, "toolXvalue"), "codemode");
	assert.equal(getMcpToolExposure(literal, "toString"), "codemode");
	for (const toolExposure of [[], "hidden", { tool: false }])
		await assert.rejects(
			f.load({ mcpServers: { fixture: { command: "x", toolExposure } } }),
			/toolExposure|exposure/,
		);
});

test("selected user config follows ordinary file and symlink permissions", async (t) => {
	const f = await fixture(t);
	await f.load({ mcpServers: {} });
	await chmod(f.path, 0o666);
	await chmod(f.root, 0o777);
	const alias = join(f.root, "alias.json");
	await symlink(f.path, alias);
	assert.deepEqual(await loadMcpConfig({ path: alias, required: true }, {}), {
		servers: [],
	});
	const directoryAlias = join(f.root, "directory-alias");
	await symlink(f.root, directoryAlias);
	assert.deepEqual(
		await loadMcpConfig(
			{ path: join(directoryAlias, "mcp.json"), required: true },
			{},
		),
		{ servers: [] },
	);
	await assert.rejects(
		loadMcpConfig({ path: f.root, required: true }, {}),
		/Could not read/,
	);
});
