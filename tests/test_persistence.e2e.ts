import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { persistenceFixture } from "./helpers/persistence.ts";
import { readText, readToolId } from "./helpers/updates.ts";

test("production load replays history before response and continues with prior context exactly once", {
	timeout: 20000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const first = await f.client();
	assert.equal(first.initialize.agentCapabilities?.loadSession, true);
	assert.deepEqual(
		first.initialize.agentCapabilities?.sessionCapabilities?.resume,
		undefined,
	);
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await first.prompt("remember this", sessionId);
	for (const request of [
		{ name: "write", args: { path: "file", content: "original" } },
		{
			name: "edit",
			args: {
				path: "file",
				edits: [{ oldText: "original", newText: "changed" }],
			},
		},
		{ name: "read", args: { path: "file" } },
		{ name: "bash", args: { command: "printf shell-result" } },
		{ name: "bash", args: { command: "printf failed-result; exit 3" } },
	])
		assert.equal(
			(await first.prompt(JSON.stringify(request), sessionId)).stopReason,
			"end_turn",
		);
	assert.equal(await readFile(join(f.cwd, "file"), "utf8"), "changed");
	await first.close();
	const second = await f.client();
	await second.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.ok(
		second.updates.some(
			(update) => update.sessionUpdate === "user_message_chunk",
		),
	);
	const loadResponse = second.wire.findLastIndex(
		(message) => message.result !== undefined,
	);
	assert.ok(loadResponse >= 0);
	assert.ok(
		second.wire
			.slice(0, loadResponse)
			.some((message) => message.method === "session/update"),
	);
	assert.ok(
		!second.wire
			.slice(loadResponse + 1)
			.some((message) => message.method === "session/update"),
	);
	const replay = [...second.updates];
	for (const kind of [
		"user_message_chunk",
		"agent_message_chunk",
		"agent_thought_chunk",
		"tool_call",
		"tool_call_update",
	])
		assert.ok(replay.some((update) => update.sessionUpdate === kind));
	assert.equal(
		replay.filter((update) => update.sessionUpdate === "tool_call_update")
			.length,
		5,
	);
	const start = second.updates.length;
	assert.equal(
		(await second.prompt("context", sessionId)).stopReason,
		"end_turn",
	);
	await second.waitForAnswer((text) => {
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	}, start);
	const text = second.updates.slice(start).map(readText).join("");
	const history = JSON.parse(text) as { role: string; content: unknown }[];
	assert.equal(
		history.filter(
			(message) =>
				message.role === "user" && message.content === "remember this",
		).length,
		1,
	);
	assert.equal(
		history.filter(
			(message) =>
				message.role === "assistant" &&
				JSON.stringify(message.content).includes("Answer: remember this"),
		).length,
		1,
	);
	assert.equal(
		history.filter((message) => message.role === "toolResult").length,
		5,
	);
	assert.ok(
		second.updates
			.slice(start)
			.every((update) => readToolId(update) === undefined),
	);
	assert.equal(first.stderr + second.stderr, "");
});

test("idle SIGKILL preserves acknowledged history and distinct session UUIDs isolate stores", {
	timeout: 15000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const first = await f.client();
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await first.prompt("survive idle kill", sessionId);
	first.child.kill("SIGKILL");
	await first.exited;
	const second = await f.client();
	await second.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.ok(
		second.updates.some(
			(update) => update.sessionUpdate === "user_message_chunk",
		),
	);
	await second.prompt("context", sessionId);
	assert.match(
		second.updates.map(readText).join(""),
		/Answer: survive idle kill/,
	);
	await second.close();
	const third = await f.client();
	const other = await third.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.notEqual(other.sessionId, sessionId);
	await third.prompt("different history", other.sessionId);
	await third.close();
	const fourth = await f.client();
	await fourth.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.ok(!JSON.stringify(fourth.updates).includes("different history"));
});

test("two subprocess owners race at startup and SIGKILL releases the namespace lock", {
	timeout: 15000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const creator = await f.client();
	const { sessionId } = await creator.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await creator.close();
	const inode = (await stat(join(f.sessions, "owner.lock"))).ino;
	const before = await readFile(join(f.sessions, "db", "main.jsonl"));
	const results = await Promise.allSettled([f.client(), f.client()]);
	const winners = results.filter((result) => result.status === "fulfilled");
	assert.equal(winners.length, 1);
	const rejected = results.find((result) => result.status === "rejected");
	assert.ok(rejected);
	const winner = winners[0];
	assert.ok(winner?.status === "fulfilled");
	assert.deepEqual(
		await readFile(join(f.sessions, "db", "main.jsonl")),
		before,
	);
	await winner.value.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	winner.value.child.kill("SIGKILL");
	await winner.value.exited;
	const next = await f.client();
	await next.request("session/load", { sessionId, cwd: f.cwd, mcpServers: [] });
	assert.equal((await stat(join(f.sessions, "owner.lock"))).ino, inode);
});

test("disk write failure fails both sessions, closes process, releases ownership and never reports a saved answer", {
	timeout: 15000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const first = await f.client();
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const directory = join(f.sessions, "db");
	const main = join(directory, "main.jsonl");
	const sibling = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const committed = await readFile(main);
	const { rename, mkdir, rm } = await import("node:fs/promises");
	await rename(main, join(directory, "saved-main"));
	await mkdir(main);
	await Promise.all(
		[sessionId, sibling.sessionId].map((id) =>
			assert.rejects(first.prompt("must not succeed", id)),
		),
	);
	const [code] = await first.exited;
	assert.equal(code, 1);
	assert.match(first.stderr, /storage failed/);
	assert.ok(!first.stderr.includes("must not succeed"));
	assert.equal(first.updates.map(readText).join(""), "");
	await rm(main, { recursive: true });
	await rename(join(directory, "saved-main"), main);
	assert.deepEqual(await readFile(main), committed);
	const next = await f.client();
	for (const id of [sessionId, sibling.sessionId])
		await next.request("session/load", {
			sessionId: id,
			cwd: f.cwd,
			mcpServers: [],
		});
});

test("load admission rejects MCP, extra roots and duplicate loads while preserving independent attachments", {
	timeout: 15000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const creator = await f.client();
	const { sessionId } = await creator.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	await creator.close();
	const next = await f.client();
	await assert.rejects(
		next.request("session/load", {
			sessionId,
			cwd: f.cwd,
			mcpServers: [],
			additionalDirectories: [f.root],
		}),
		/Additional workspace/,
	);
	await assert.rejects(
		next.request("session/load", {
			sessionId,
			cwd: f.cwd,
			mcpServers: [
				{ name: "unsupported", command: "false", args: [], env: [] },
			],
		}),
		/MCP servers/,
	);
	await next.request("session/load", {
		sessionId,
		cwd: f.cwd,
		mcpServers: [],
	});
	const sibling = await next.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	assert.notEqual(sibling.sessionId, sessionId);
	await assert.rejects(
		next.request("session/load", { sessionId, cwd: f.cwd, mcpServers: [] }),
		/already attached or opening/,
	);
	assert.equal(
		(await next.prompt("still attached", sessionId)).stopReason,
		"end_turn",
	);
});
