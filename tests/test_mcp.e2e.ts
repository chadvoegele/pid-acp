import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { persistenceFixture } from "./helpers/persistence.ts";
import { waitFor } from "./helpers/client.ts";
import { assertChildrenStopped } from "./helpers/processes.ts";
import { readText } from "./helpers/updates.ts";
import { startMcpHttpFixture } from "./helpers/mcp-http-fixture.ts";

const request = (code: string) =>
	JSON.stringify({ name: "codemode", args: { code } });
function parentUpdates(updates: SessionUpdate[]) {
	return updates.filter(
		(update) =>
			update.sessionUpdate === "tool_call" ||
			update.sessionUpdate === "tool_call_update",
	);
}
async function fixture(t: TestContext) {
	const f = await persistenceFixture(t);
	const http = await startMcpHttpFixture();
	t.after(() => http.close());
	const path = join(f.root, "mcp.json");
	const log = join(f.root, "mcp.log");
	await writeFile(log, "");
	async function configure({
		tools = "value,hold,old,a-b,a_b,hidden",
		required = false,
		enabled = true,
		removed = false,
		token = "fixture-token",
		hung = false,
		httpTimeout = 60,
	} = {}) {
		await writeFile(
			path,
			JSON.stringify({
				mcpServers: {
					stdio: removed
						? undefined
						: {
								command: process.execPath,
								args: [resolve("tests/helpers/mcp-stdio-fixture.ts")],
								env: {
									MCP_FIXTURE_LOG: log,
									MCP_FIXTURE_TOOLS: tools,
									MCP_FIXTURE_PAGE_SIZE: "2",
									MCP_FIXTURE_REQUIRED: required ? "1" : "0",
									MCP_FIXTURE_HUNG: hung ? "1" : "0",
									MCP_FIXTURE_STDERR: "1",
								},
								enabled,
								toolExposure: { hidden: "hidden" },
								description: "Disposable stdio fixture",
							},
					http: {
						url: http.url,
						timeout: httpTimeout,
						headers: { Authorization: `Bearer ${token}` },
					},
				},
			}),
			{ mode: 0o600 },
		);
	}
	await configure();
	function records() {
		return readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as { event: string; pid: number; cwd: string },
			);
	}
	async function openClient(env: NodeJS.ProcessEnv = {}) {
		const scoped = new Map<string, SessionUpdate[]>();
		const client = await f.client(
			{
				PID_ACP_MCP_CONFIG: path,
				PID_ACP_PROVIDERS: resolve("tests/helpers/mcp-provider.ts"),
				PID_ACP_MODEL: "faux-1",
				...env,
			},
			(id, update) => {
				const updates = scoped.get(id) ?? [];
				updates.push(update);
				scoped.set(id, updates);
			},
		);
		return Object.assign(client, { scoped });
	}
	async function run(
		client: Awaited<ReturnType<typeof openClient>>,
		sessionId: string,
		code: string,
	) {
		const scoped = client.scoped.get(sessionId) ?? [];
		const start = scoped.length;
		assert.equal(
			(
				await client.prompt(request(code), sessionId).catch((error) => {
					throw new Error(
						`Fixture prompt failed: ${code}; stderr: ${client.stderr}`,
						{ cause: error },
					);
				})
			).stopReason,
			"end_turn",
		);
		await waitFor(() => {
			try {
				JSON.parse(
					(client.scoped.get(sessionId) ?? [])
						.slice(start)
						.map(readText)
						.join(""),
				);
				return true;
			} catch {
				return false;
			}
		});
		const delivered = (client.scoped.get(sessionId) ?? []).slice(start);
		const updates = parentUpdates(delivered);
		const calls = updates.filter(
			(update) => update.sessionUpdate === "tool_call",
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.title, "codemode");
		assert.ok(
			updates.every((update) => update.toolCallId === calls[0]?.toolCallId),
		);
		assert.ok(
			updates.some(
				(update) => update.status === "completed" || update.status === "failed",
			),
		);
		assert.equal(client.stderr, "");
		return delivered.map(readText).join("");
	}
	async function stopped() {
		await assertChildrenStopped(
			records()
				.filter((record) => record.event === "start")
				.map((record) => record.pid),
		);
	}
	return { ...f, http, configure, records, client: openClient, run, stopped };
}

test("production startup preserves only sanitized MCP configuration categories and remediation", async (t) => {
	const f = await persistenceFixture(t);
	const path = join(f.root, "PRIVATE_CONFIG_PATH.json");
	for (const [source, category] of [
		['{"mcpServers": PRIVATE_PARSER_SECRET}', "Expected valid JSON"],
		[
			JSON.stringify({
				mcpServers: {
					fixture: {
						command: "PRIVATE_COMMAND",
						oauth: { token: "PRIVATE_TOKEN" },
					},
				},
			}),
			"OAuth requires a streamable HTTP URL",
		],
	] as const) {
		await writeFile(path, source, { mode: 0o600 });
		const child = spawnSync(process.execPath, ["dist/main.js"], {
			env: {
				...process.env,
				PID_ACP_PROVIDERS: resolve("tests/helpers/mcp-provider.ts"),
				PID_ACP_MODEL: "faux-1",
				PID_ACP_MCP_CONFIG: path,
				PID_ACP_INSTRUCTIONS: "",
				PID_ACP_SKILLS_DIR: "",
				PID_ACP_SESSIONS_DIR: undefined,
			},
			encoding: "utf8",
			timeout: 5000,
		});
		assert.equal(child.error, undefined);
		assert.equal(child.status, 1);
		assert.equal(child.stdout, "");
		assert.ok(child.stderr.includes(category));
		assert.match(
			child.stderr,
			/Correct the selected mcp.json or set PID_ACP_MCP_CONFIG empty/,
		);
		assert.doesNotMatch(child.stderr, /PRIVATE_|Startup failed/);
	}
});

test("production stdio inherits upstream process env by default and honors explicit isolation/overrides", {
	timeout: 20000,
}, async (t) => {
	const f = await fixture(t);
	for (const [inheritEnv, explicit, expected] of [
		[undefined, undefined, "inherited-fixture-value"],
		[true, undefined, "inherited-fixture-value"],
		[false, undefined, "stdio-fixture"],
		[false, "explicit-fixture-value", "explicit-fixture-value"],
		[true, "explicit-fixture-value", "explicit-fixture-value"],
	] as const) {
		await writeFile(
			join(f.root, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					stdio: {
						command: process.execPath,
						args: [resolve("tests/helpers/mcp-stdio-fixture.ts")],
						inheritEnv,
						env: {
							MCP_FIXTURE_LOG: join(f.root, "mcp.log"),
							MCP_FIXTURE_TOKEN: explicit,
						},
						extra: "inert extension",
					},
					disabled: {
						enabled: false,
						command: "must-not-launch",
						exposure: "direct",
					},
				},
			}),
		);
		const client = await f.client({
			MCP_FIXTURE_TOKEN: "inherited-fixture-value",
		});
		const { sessionId } = await client.request("session/new", {
			cwd: f.cwd,
			mcpServers: [],
		});
		const output = await f.run(
			client,
			sessionId,
			"text((await tools.mcp__stdio__value({})).structuredContent.token)",
		);
		assert.ok(output.includes(expected), output);
		await client.close();
		assert.deepEqual(await client.exited, [0, null]);
		await f.stopped();
	}
});

test("production ACP discovers real multipage stdio/HTTP tools and preserves envelopes with parent-only presentation", {
	timeout: 20000,
}, async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.cwd, ".pi"));
	await writeFile(
		join(f.cwd, ".pi", "mcp.json"),
		"invalid project configuration must never be read",
	);
	const client = await f.client();
	const { sessionId } = await client.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const output = await f.run(
		client,
		sessionId,
		`
		text(ALL_TOOLS);
		text(await describeNamespace("mcp__stdio"));
		text(await tools.mcp__stdio__value({}));
		text(await tools.mcp__http__null({}));
		text(await tools.mcp__http__array({}));
		const failure = await tools.mcp__http__error({}); text({ checkedError: failure.isError });
		try { await tools.mcp__http__protocol({}); } catch { text("protocol-rejected"); }
		text(await tools.bash({ command: "printf native-still-works" }));`,
	);
	assert.match(output, /stdio-fixture/);
	assert.match(output, /structuredContent.*null/);
	assert.match(output, /application/);
	assert.match(output, /checkedError.*true/);
	assert.match(output, /protocol-rejected/);
	assert.match(output, /native-still-works/);
	assert.match(output, /mcp__stdio__a_b_[a-f0-9]{8}/);
	assert.doesNotMatch(output, /mcp__stdio__hidden|PRIVATE_/);
	assert.equal(
		f.records().filter((record) => record.event === "list").length,
		3,
	);
	assert.equal(
		f.http.requests.filter((record) => record.message.method === "tools/list")
			.length,
		4,
	);
	assert.ok(
		f.http.requests.every(
			(record) => record.authorization === "Bearer fixture-token",
		),
	);
	await client.close();
	assert.deepEqual(await client.exited, [0, null]);
	await f.stopped();
	assert.equal(f.http.deleted.length, 2);
	for (const entry of await readdir(f.sessions, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (!entry.isFile()) continue;
		assert.doesNotMatch(
			await readFile(join(entry.parentPath, entry.name), "utf8"),
			/fixture-token|PRIVATE_/,
		);
	}
});

test("persistent production restart uses current config, removal and schemas without blocking historical presentation", {
	timeout: 30000,
}, async (t) => {
	const f = await fixture(t);
	let client = await f.client();
	const { sessionId } = await client.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await f.run(
		client,
		sessionId,
		"text(await tools.mcp__stdio__old({})); text(await tools.mcp__stdio__value({}));",
	);
	await f.configure({ tools: "value", required: true, token: "rotated-token" });
	// Launch configuration is immutable until process restart, including new conversations.
	const sibling = await client.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await f.run(
		client,
		sibling.sessionId,
		"text(await tools.mcp__stdio__old({}));",
	);
	await client.close();
	await f.stopped();
	client = await f.client();
	const before = f.http.requests.length;
	await client.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.equal(
		f.http.requests.length,
		before,
		"load only attaches; dormant saved conversations allocate no execution clients",
	);
	assert.match(JSON.stringify(client.updates), /stdio-fixture/);
	const count = f
		.records()
		.filter((record) => record.event === "call:value").length;
	const output = await f.run(
		client,
		sessionId,
		`
		try { await tools.mcp__stdio__old({}); } catch { text("removed-tool-failed"); }
		try { await tools.mcp__stdio__value({}); } catch { text("current-schema-rejected"); }
		text(await tools.mcp__stdio__value({ current: 1 }));`,
	);
	assert.match(output, /removed-tool-failed/);
	assert.match(output, /current-schema-rejected/);
	assert.match(output, /stdio-fixture/);
	assert.equal(
		f.records().filter((record) => record.event === "call:value").length,
		count + 1,
	);
	assert.equal(
		f.records().filter((record) => record.event === "call:old").length,
		2,
	);
	assert.ok(
		f.http.requests
			.slice(before - 2)
			.some((record) => record.authorization === "Bearer rotated-token"),
	);
	await client.close();
	await f.configure({ enabled: false });
	client = await f.client();
	const starts = f
		.records()
		.filter((record) => record.event === "start").length;
	await client.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	const disabled = await f.run(
		client,
		sessionId,
		`try { await tools.mcp__stdio__value({}); } catch { text("disabled-server-failed"); } text(await tools.mcp__http__value({}));`,
	);
	assert.match(disabled, /disabled-server-failed/);
	assert.match(disabled, /http-fixture/);
	assert.equal(
		f.records().filter((record) => record.event === "start").length,
		starts,
	);
	await client.close();
	await f.configure({ removed: true });
	client = await f.client();
	await client.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	const removed = await f.run(
		client,
		sessionId,
		`try { await tools.mcp__stdio__value({}); } catch { text("removed-server-failed"); } text(await tools.bash({ command: "printf native-after-removal" }));`,
	);
	assert.match(removed, /removed-server-failed/);
	assert.match(removed, /native-after-removal/);
	assert.equal(
		f.records().filter((record) => record.event === "start").length,
		starts,
	);
	await client.close();
	await f.stopped();
});

test("real HTTP response resumption consumes the result without reposting a mutation", {
	timeout: 15000,
}, async (t) => {
	const f = await fixture(t);
	const client = await f.client();
	const { sessionId } = await client.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.match(
		await f.run(client, sessionId, "text(await tools.mcp__http__resume({}));"),
		/resumed-without-repost/,
	);
	assert.equal(f.http.resumptions.length, 1);
	assert.equal(
		f.http.requests.filter(
			(record) =>
				(record.message.params as { name?: string })?.name === "resume",
		).length,
		1,
	);
	await client.close();
	await f.stopped();
});

test("a disconnected stdio call fails without starting another server or replaying the call", {
	timeout: 15000,
}, async (t) => {
	const f = await fixture(t);
	const client = await f.client();
	const { sessionId } = await client.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const pending = f.run(
		client,
		sessionId,
		'try { await tools.mcp__stdio__hold({}); } catch { text("disconnected"); }',
	);
	void pending.catch(() => {});
	await waitFor(() =>
		f.records().some((record) => record.event === "call:hold"),
	);
	const child = f.records().findLast((record) => record.event === "start");
	assert.ok(child);
	process.kill(child.pid, "SIGTERM");
	assert.match(await pending, /disconnected/);
	assert.match(
		await f.run(
			client,
			sessionId,
			'try { await tools.mcp__stdio__value({}); } catch { text("still-disconnected"); }',
		),
		/still-disconnected/,
	);
	assert.equal(
		f.records().filter((record) => record.event === "start").length,
		2,
	);
	assert.equal(
		f.records().filter((record) => record.event === "call:hold").length,
		1,
	);
	assert.equal(
		f.records().filter((record) => record.event === "call:value").length,
		0,
	);
	await client.close();
	await f.stopped();
});

test("same-cwd production conversations have separate clients and cancellation does not affect siblings or the next prompt", {
	timeout: 20000,
}, async (t) => {
	const f = await fixture(t);
	const client = await f.client();
	const a = await client.request("session/new", { cwd: f.cwd, mcpServers: [] });
	const b = await client.request("session/new", { cwd: f.cwd, mcpServers: [] });
	const pendingA = client.prompt(
		request("text(await tools.mcp__http__hold({}));"),
		a.sessionId,
	);
	const pendingB = client.prompt(
		request("text(await tools.mcp__http__hold({}));"),
		b.sessionId,
	);
	void pendingA.catch(() => {});
	void pendingB.catch(() => {});
	await waitFor(
		() =>
			f.http.requests.filter(
				(record) =>
					(record.message.params as { name?: string })?.name === "hold",
			).length === 2,
	);
	const holds = f.http.requests.filter(
		(record) => (record.message.params as { name?: string })?.name === "hold",
	);
	assert.notEqual(holds[0]?.session, holds[1]?.session);
	await client.cancel(a.sessionId);
	assert.equal((await pendingA).stopReason, "cancelled");
	await waitFor(() => f.http.cancellations.length === 1);
	const cancelled = f.http.cancellations[0];
	const sibling = holds.find((record) => record.session !== cancelled)?.session;
	assert.ok(cancelled && sibling);
	assert.equal(f.http.deleted.length, 1, "only discovery has closed");
	f.http.release(sibling);
	assert.equal((await pendingB).stopReason, "end_turn");
	f.http.release(cancelled);
	assert.match(
		await f.run(client, a.sessionId, "text(await tools.mcp__http__value({}));"),
		/http-fixture/,
	);
	assert.equal(
		f.http.requests.filter((record) => record.message.method === "initialize")
			.length,
		3,
	);
	assert.equal(
		f.records().filter((record) => record.event === "start").length,
		3,
	);
	const starts = f.records().filter((record) => record.event === "start");
	assert.equal(
		starts[0]?.cwd,
		process.cwd(),
		"temporary discovery uses launch cwd",
	);
	assert.ok(starts.slice(1).every((record) => record.cwd === f.cwd));
	assert.doesNotMatch(
		JSON.stringify(client.scoped.get(a.sessionId)),
		/held-complete|PRIVATE_/,
	);
	assert.doesNotMatch(client.stderr, /PRIVATE_/);
	await client.close();
	await f.stopped();
	assert.equal(f.http.deleted.length, 3);
});

test("fresh production process reuses completed MCP results and fails interrupted unsafe intent without repeating external effects", {
	timeout: 25000,
}, async (t) => {
	const f = await fixture(t);
	await f.configure({ tools: "value,mutate_hold,after_restart" });
	const first = await f.client();
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const code = `text(await tools.mcp__stdio__value({}));
		try { await tools.mcp__stdio__mutate_hold({}); } catch (error) { text(String(error)); }
		try { await tools.mcp__stdio__value({}); } catch (error) { text(String(error)); }
		text(await tools.mcp__stdio__after_restart({}));
		await tools.write({ path: "recovered.txt", content: "unsafe-effect-not-repeated" });`;
	void first.prompt(request(code), sessionId).catch(() => {});
	await waitFor(() =>
		f.records().some((record) => record.event === "call:mutate_hold"),
	);
	assert.equal(
		f.records().filter((record) => record.event === "call:after_restart")
			.length,
		0,
	);
	first.child.kill("SIGKILL");
	assert.deepEqual(await first.exited, [null, "SIGKILL"]);
	await f.stopped();
	await f.configure({ tools: "current,after_restart" });
	const log = join(f.root, "provider.log");
	const next = await f.client({
		PID_TEST_REQUEST_LOG: log,
	});
	await waitFor(() => existsSync(join(f.cwd, "recovered.txt")));
	await waitFor(
		() =>
			existsSync(log) &&
			readFileSync(log, "utf8").includes('"lastRole":"toolResult"'),
	);
	assert.equal(
		await readFile(join(f.cwd, "recovered.txt"), "utf8"),
		"unsafe-effect-not-repeated",
	);
	assert.equal(
		next.updates.length,
		0,
		"recovery precedes presentation attachment",
	);
	await next.request("session/load", { sessionId, cwd: f.cwd, mcpServers: [] });
	const history = JSON.stringify(next.updates);
	assert.match(history, /stdio-fixture/);
	assert.match(history, /interrupted/i);
	assert.match(history, /not available/);
	assert.equal(
		f.records().filter((record) => record.event === "call:mutate_hold").length,
		1,
	);
	assert.equal(
		f.records().filter((record) => record.event === "call:value").length,
		1,
	);
	assert.equal(
		f.records().filter((record) => record.event === "call:after_restart")
			.length,
		1,
	);
	await next.close();
	assert.deepEqual(await next.exited, [0, null]);
	await f.stopped();
});

test("real HTTP progress renews idle timeout, timeout cancels only its call and the next prompt reuses the client", {
	timeout: 15000,
}, async (t) => {
	const f = await fixture(t);
	await f.configure({ httpTimeout: 1 });
	const client = await f.client();
	const { sessionId } = await client.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const pending = f.run(
		client,
		sessionId,
		"text(await tools.mcp__http__hold({}));",
	);
	void pending.catch(() => {});
	await waitFor(() =>
		f.http.requests.some(
			(record) => (record.message.params as { name?: string })?.name === "hold",
		),
	);
	const held = f.http.requests.find(
		(record) => (record.message.params as { name?: string })?.name === "hold",
	);
	assert.ok(held);
	for (let i = 0; i < 3; i++) {
		await delay(400);
		f.http.progress(held.session, i + 2);
	}
	assert.equal(f.http.cancellations.length, 0);
	f.http.release(held.session);
	assert.match(await pending, /held-complete/);
	const output = await f.run(
		client,
		sessionId,
		`try { await tools.mcp__http__hold({}); } catch (error) { text(String(error)); }`,
	);
	assert.match(output, /inspect the external system/);
	await waitFor(() => f.http.cancellations.length === 1);
	assert.equal(
		f.http.deleted.length,
		1,
		"timeout leaves execution client open",
	);
	f.http.release(held.session);
	assert.match(
		await f.run(client, sessionId, "text(await tools.mcp__http__value({}));"),
		/http-fixture/,
	);
	assert.equal(
		f.http.requests.filter((record) => record.message.method === "initialize")
			.length,
		2,
	);
	await client.close();
	await f.stopped();
});

for (const signal of ["EOF", "SIGINT", "SIGTERM"] as const) {
	test(`production ${signal} closes real MCP connections and escalates a hung stdio child`, {
		timeout: 15000,
	}, async (t) => {
		const f = await fixture(t);
		await f.configure({ hung: true });
		const client = await f.client();
		const { sessionId } = await client.request("session/new", {
			cwd: f.cwd,
			mcpServers: [],
		});
		void client
			.prompt(request("await tools.mcp__stdio__hold({});"), sessionId)
			.catch(() => {});
		await waitFor(() =>
			f.records().some((record) => record.event === "call:hold"),
		);
		if (signal === "EOF") client.child.stdin.end();
		else client.child.kill(signal);
		assert.deepEqual(await client.exited, [0, null]);
		await f.stopped();
		assert.ok(f.records().some((record) => record.event === "ignored-sigterm"));
		assert.equal(f.http.deleted.length, 2);
		assert.equal(client.stderr, "");
	});
}
