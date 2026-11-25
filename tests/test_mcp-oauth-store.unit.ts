import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	McpOAuthProvider,
	McpRefreshLockBusyError,
} from "@earendil-works/pi-mcp/oauth";
import lockfile from "proper-lockfile";
import { McpOAuthStoreError, piMcpStore } from "../dist/mcp-oauth-store.js";

const name = "project-docs";
const url = "https://mcp.example.test/api";
const key = `mcp__project_docs|${url}`;
const other = `mcp__other|${url}`;
// Equivalent synthetic shape to Pi CLI login with a configured clientId.
const fixture = await readFile(
	new URL("./fixtures/pi-mcp-auth.json", import.meta.url),
	"utf8",
);
const sentinel = "fake-private-value";

async function setup(t: TestContext) {
	const root = await mkdtemp(
		join(await realpath(tmpdir()), "pid-mcp-auth-test-"),
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "agent");
	const path = join(dir, "mcp-auth.json");
	const seed = (value = fixture) => writeFile(path, value, { mode: 0o600 });
	const store = piMcpStore(path, name, url);
	return { root, dir, path, seed, store };
}

function safeStoreError(code: McpOAuthStoreError["code"]) {
	return (error: unknown) => {
		assert.ok(error instanceof McpOAuthStoreError);
		assert.equal(error.code, code);
		assert.equal(error.cause, undefined);
		assert.ok(!error.stack?.includes(sentinel));
		assert.ok(!error.message.includes("mcp-auth.json"));
		return true;
	};
}

test("loads only the exact Pi namespace and normalized URL", async (t) => {
	const { dir, path, seed } = await setup(t);
	await mkdir(dir, { mode: 0o700 });
	await seed();
	const normalized = piMcpStore(path, name, "HTTPS://MCP.example.test:443/api");
	assert.deepEqual(await normalized.load(), JSON.parse(fixture)[key]);
	assert.equal(
		(await piMcpStore(path, "other", url).load())?.tokens?.access_token,
		"other-access",
	);
	assert.equal(await piMcpStore(path, "absent", url).load(), undefined);
	assert.equal(await piMcpStore(path, name, `${url}/`).load(), undefined);
});

test("reports missing bootstrap without creating a store or migrating legacy entries", async (t) => {
	const { root, dir, path, seed, store } = await setup(t);
	const initial = { serverUrl: url };
	assert.equal(await store.load(), undefined);
	await assert.rejects(
		async () => store.save(initial),
		safeStoreError("missing"),
	);
	await assert.rejects(
		store.withRefreshLock(async () => assert.fail("callback ran")),
		safeStoreError("missing"),
	);
	assert.deepEqual(await readdir(root), []);
	await mkdir(dir, { mode: 0o700 });
	assert.equal(await store.load(), undefined);
	await assert.rejects(
		async () => store.save(initial),
		safeStoreError("missing"),
	);
	assert.deepEqual(await readdir(dir), []);

	const legacy = JSON.stringify({ [url]: JSON.parse(fixture)[key] });
	await seed(legacy);
	assert.equal(await store.load(), undefined);
	await assert.rejects(
		async () => store.save(initial),
		safeStoreError("missing"),
	);
	assert.equal(await readFile(path, "utf8"), legacy);
});

test("fails closed on malformed store, malformed selected entry, and URL mismatch", async (t) => {
	const { dir, path, seed, store } = await setup(t);
	await mkdir(dir, { mode: 0o700 });
	const records = [
		"",
		`"${sentinel}`,
		JSON.stringify([sentinel]),
		JSON.stringify({ [key]: null }),
		JSON.stringify({ [key]: { tokens: { access_token: sentinel } } }),
		JSON.stringify({
			[key]: {
				serverUrl: url,
				tokens: { access_token: sentinel, token_type: 2 },
			},
		}),
		JSON.stringify({
			[key]: {
				serverUrl: url,
				discovery: { authorizationServerUrl: sentinel },
			},
		}),
	];
	for (const content of records) {
		await seed(content);
		await assert.rejects(
			async () => store.load(),
			safeStoreError("invalid-state"),
		);
		await assert.rejects(
			async () => store.save({ serverUrl: url }),
			safeStoreError("invalid-state"),
		);
		assert.equal(await readFile(path, "utf8"), content);
	}
	const mismatch = JSON.stringify({
		[key]: {
			...JSON.parse(fixture)[key],
			serverUrl: `https://${sentinel}.test/`,
		},
	});
	await seed(mismatch);
	await assert.rejects(
		async () => store.load(),
		safeStoreError("identity-mismatch"),
	);
	await assert.rejects(
		async () => store.save({ serverUrl: url }),
		safeStoreError("identity-mismatch"),
	);
	assert.equal(await readFile(path, "utf8"), mismatch);

	await seed();
	await assert.rejects(
		async () => store.save({ serverUrl: `https://${sentinel}.test/` }),
		safeStoreError("identity-mismatch"),
	);
	assert.equal(await readFile(path, "utf8"), fixture);
});

test("updates in place, preserves unrelated and opaque state, and honors Pi token invalidation", async (t) => {
	const { dir, path, seed, store } = await setup(t);
	await mkdir(dir, { mode: 0o700 });
	const states = JSON.parse(fixture);
	const extension = { nested: [1, 2, 3] };
	states[key].extension = extension;
	await seed(JSON.stringify(states));
	const inode = (await stat(path)).ino;

	const tokens = {
		access_token: "new-access",
		refresh_token: "new-refresh",
		token_type: "Bearer",
	};
	await store.save({
		serverUrl: url,
		tokens,
		discovery: states[key].discovery,
	});
	const after = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(after, {
		...states,
		[key]: {
			serverUrl: url,
			tokens,
			discovery: states[key].discovery,
			extension,
		},
	});
	assert.deepEqual(await piMcpStore(path, name, url).load(), after[key]);

	const provider = new McpOAuthProvider({
		serverUrl: url,
		redirectUrl: "http://127.0.0.1/callback",
		clientMetadata: {},
		clientId: "test-public-client",
		onRedirect: () => assert.fail("unexpected redirect"),
		store,
	});
	await provider.invalidateCredentials("tokens");
	assert.deepEqual(await store.load(), {
		serverUrl: url,
		discovery: states[key].discovery,
		extension,
	});
	assert.deepEqual(
		JSON.parse(await readFile(path, "utf8"))[other],
		states[other],
	);
	const saved = await stat(path);
	assert.equal(saved.ino, inode);
	assert.equal(saved.mode & 0o777, 0o600);
	assert.deepEqual(await readdir(dir), ["mcp-auth.json"]);
});

test("rejects public modes, non-regular paths, and file and directory aliases", async (t) => {
	const { root, dir, path, seed, store } = await setup(t);
	await mkdir(dir, { mode: 0o700 });
	await seed();
	await chmod(path, 0o640);
	await assert.rejects(
		async () => store.load(),
		safeStoreError("unsafe-location"),
	);
	await assert.rejects(
		store.withRefreshLock(async () => assert.fail("callback ran")),
		safeStoreError("unsafe-location"),
	);
	assert.equal((await stat(path)).mode & 0o777, 0o640);
	await chmod(path, 0o600);
	await chmod(dir, 0o750);
	await assert.rejects(
		async () => store.load(),
		safeStoreError("unsafe-location"),
	);
	await chmod(dir, 0o700);

	const aliasDir = join(root, "directory-alias");
	await symlink(dir, aliasDir);
	const fileAlias = join(root, "mcp-auth.json");
	await symlink(path, fileAlias);
	for (const alias of [join(aliasDir, "mcp-auth.json"), fileAlias]) {
		await assert.rejects(
			async () => piMcpStore(alias, name, url).load(),
			safeStoreError("unsafe-location"),
		);
	}
	await rm(fileAlias);
	await link(path, fileAlias);
	await assert.rejects(
		async () => store.load(),
		safeStoreError("unsafe-location"),
	);
	await assert.rejects(
		async () => piMcpStore(fileAlias, name, url).load(),
		safeStoreError("unsafe-location"),
	);
	await rm(fileAlias);
	await mkdir(fileAlias, { mode: 0o700 });
	await assert.rejects(
		async () => piMcpStore(fileAlias, name, url).load(),
		safeStoreError("unsafe-location"),
	);
	assert.throws(
		() => piMcpStore("mcp-auth.json", name, url),
		safeStoreError("unsafe-location"),
	);
	assert.deepEqual(await readdir(dir), ["mcp-auth.json"]);
});

async function peer(t: TestContext, path: string, kind: "file" | "refresh") {
	const child = fork(
		fileURLToPath(new URL("./helpers/pi-mcp-lock-peer.ts", import.meta.url)),
		[path, kind],
		{
			env: {},
			execArgv: [],
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		},
	);
	const exited = once(child, "exit");
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await exited;
	});
	const [message] = await Promise.race([once(child, "message"), exited]);
	assert.equal(message, "locked");
	return async () => {
		child.send("release");
		assert.deepEqual(await exited, [0, null]);
	};
}

test("file transactions wait asynchronously on Pi's realpath lock in a separate process", {
	timeout: 10_000,
}, async (t) => {
	const { dir, path, seed, store } = await setup(t);
	await mkdir(dir, { mode: 0o700 });
	await seed();
	const release = await peer(t, path, "file");
	let ticked = false;
	const tick = delay(40).then(() => {
		ticked = true;
	});
	await assert.rejects(async () => store.load(), safeStoreError("io"));
	assert.equal(ticked, true);
	await tick;
	await release();
	assert.deepEqual(await store.load(), JSON.parse(fixture)[key]);
});

test("waits behind Pi's per-server refresh lock and sees the peer's rotation", {
	timeout: 10_000,
}, async (t) => {
	const { dir, path, seed, store } = await setup(t);
	await mkdir(dir, { mode: 0o700 });
	await seed();
	const release = await peer(t, path, "refresh");
	const old = await store.load(); // The refresh lock is not the file lock.
	let entered = false;
	const refresh = store.withRefreshLock(async () => {
		entered = true;
		return (await store.load())?.tokens;
	});
	try {
		await delay(150);
		assert.equal(entered, false);
	} finally {
		await release();
		await refresh;
	}
	assert.equal(old?.tokens?.refresh_token, "synthetic-refresh");
	assert.equal((await refresh)?.refresh_token, "rotated-refresh");
	assert.equal(
		(await piMcpStore(path, name, url).load())?.tokens?.access_token,
		"rotated-access",
	);
	assert.deepEqual(
		JSON.parse(await readFile(path, "utf8"))[other],
		JSON.parse(fixture)[other],
	);
	assert.deepEqual(await readdir(dir), ["mcp-auth.json"]);
});

test("only refresh-lock acquisition ELOCKED maps to busy, and callback failure releases the lock", async (t) => {
	const { dir, seed, store } = await setup(t);
	await mkdir(dir, { mode: 0o700 });
	await seed();
	const failure = Object.assign(new Error(sentinel), { code: "ELOCKED" });
	const run = () =>
		store.withRefreshLock(async () => {
			throw failure;
		});
	await assert.rejects(run(), (error) => error === failure);
	assert.deepEqual(await readdir(dir), ["mcp-auth.json"]);
	assert.equal(await store.withRefreshLock(async () => 42), 42);

	const locked = t.mock.method(lockfile, "lock", async () => {
		throw failure;
	});
	await assert.rejects(run(), McpRefreshLockBusyError);
	locked.mock.mockImplementation(async () => {
		throw Object.assign(new Error(sentinel), { code: "EACCES" });
	});
	await assert.rejects(run(), safeStoreError("io"));
});
