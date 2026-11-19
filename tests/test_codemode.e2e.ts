import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { waitFor } from "./helpers/client.ts";
import { persistenceFixture } from "./helpers/persistence.ts";
import { assertChildrenStopped } from "./helpers/processes.ts";
import { readText } from "./helpers/updates.ts";

function request(code: string) {
	return JSON.stringify({ name: "codemode", args: { code } });
}

function toolUpdates(updates: SessionUpdate[]) {
	return updates.filter(
		(update) =>
			update.sessionUpdate === "tool_call" ||
			update.sessionUpdate === "tool_call_update",
	);
}

function assertParent(
	updates: SessionUpdate[],
	code: string,
	status: "completed" | "failed",
) {
	const tools = toolUpdates(updates);
	const start = tools[0];
	assert.ok(start?.sessionUpdate === "tool_call");
	assert.deepEqual(start, {
		sessionUpdate: "tool_call",
		toolCallId: start.toolCallId,
		title: "codemode",
		kind: "other",
		status: "in_progress",
		rawInput: { code },
	});
	assert.equal(
		tools.filter((update) => update.sessionUpdate === "tool_call").length,
		1,
	);
	assert.ok(tools.every((update) => update.toolCallId === start.toolCallId));
	const terminal = tools.at(-1);
	assert.ok(terminal?.sessionUpdate === "tool_call_update");
	assert.equal(terminal.status, status);
	assert.equal(tools.filter((update) => update.status === status).length, 1);
	return { start, terminal };
}

async function waitForTerminal(updates: SessionUpdate[], start = 0) {
	await waitFor(() =>
		toolUpdates(updates.slice(start)).some(
			(update) => update.status === "completed" || update.status === "failed",
		),
	);
}

test("codemode batches native tools, chains file calls and replays only upstream parent success/error results", {
	timeout: 20000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const provider = {
		PID_ACP_PROVIDER_CONFIG: resolve("tests/helpers/file-provider.ts"),
		PID_ACP_MODEL: "files",
	};
	const client = await f.client(provider);
	const { sessionId } = await client.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const code = `const batch = await Promise.all([
		tools.bash({ command: "printf alpha" }),
		tools.bash({ command: "printf beta; exit 7" })
	]);
	await tools.write({ path: "combined.txt", content: batch.map(result => result.output).join(":") });
	await tools.edit({ path: "combined.txt", oldText: "beta", newText: "gamma" });
	text({ batch, read: await tools.read({ path: "combined.txt" }) });`;
	const calls = [
		{ code, status: "completed" as const, expected: /alpha:gamma/ },
		{
			code: 'await tools.read({ path: "missing.txt" });',
			status: "failed" as const,
			expected: /missing.txt/,
		},
	];
	const saved: ReturnType<typeof assertParent>[] = [];
	for (const call of calls) {
		const start = client.updates.length;
		assert.equal(
			(await client.prompt(request(call.code), sessionId)).stopReason,
			"end_turn",
		);
		await waitForTerminal(client.updates, start);
		await client.waitForAnswer((text) => {
			try {
				JSON.parse(text);
				return true;
			} catch {
				return false;
			}
		}, start);
		const parent = assertParent(
			client.updates.slice(start),
			call.code,
			call.status,
		);
		assert.match(parent.start.toolCallId, /^file-\d+$/);
		const result = JSON.parse(
			client.updates.slice(start).map(readText).join(""),
		) as ToolResultMessage;
		assert.equal(result.toolCallId, parent.start.toolCallId);
		assert.equal(result.toolName, "codemode");
		assert.equal(result.isError, call.status === "failed");
		assert.deepEqual(parent.terminal.rawOutput, result.content);
		assert.deepEqual(
			parent.terminal.content,
			result.content.map((content) => ({ type: "content", content })),
		);
		const output = result.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
		assert.match(output, call.expected);
		if (call.status === "completed") {
			assert.match(output, /Script completed/);
			assert.ok(
				output.includes(
					JSON.stringify({
						batch: [
							{ output: "alpha", truncated: false, exitCode: 0 },
							{ output: "beta", truncated: false, exitCode: 7 },
						],
						read: "alpha:gamma",
					}),
				),
			);
		} else {
			assert.match(output, /Script failed/);
		}
		saved.push(parent);
	}
	assert.equal(
		await readFile(join(f.cwd, "combined.txt"), "utf8"),
		"alpha:gamma",
	);
	await client.close();
	const next = await f.client(provider);
	await next.request("session/load", { sessionId, cwd: f.cwd, mcpServers: [] });
	assert.deepEqual(
		toolUpdates(next.updates),
		saved.flatMap(({ start, terminal }) => [start, terminal]),
	);
	assert.equal(client.stderr, "");
	assert.equal(next.stderr, "");
});

test("ordinary conversation cancellation reaches a running codemode script and the next prompt works", {
	timeout: 15000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const client = await f.client({
		PID_ACP_PROVIDER_CONFIG: resolve("tests/helpers/file-provider.ts"),
		PID_ACP_MODEL: "files",
	});
	const { sessionId } = await client.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const code =
		'await tools.bash({ command: "echo $$ > shell.pid; sleep 60" });';
	const pending = client.prompt(request(code), sessionId);
	void pending.catch(() => {});
	await waitFor(() => existsSync(join(f.cwd, "shell.pid")));
	const pid = Number(await readFile(join(f.cwd, "shell.pid"), "utf8"));
	t.after(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	});
	await waitFor(() =>
		toolUpdates(client.updates).some(
			(update) => update.sessionUpdate === "tool_call",
		),
	);
	await client.cancel(sessionId);
	assert.equal((await pending).stopReason, "cancelled");
	await waitForTerminal(client.updates);
	assertParent(client.updates, code, "failed");
	await assertChildrenStopped([pid]);
	const start = client.updates.length;
	const nextCode =
		'text(await tools.bash({ command: "printf after-cancel" }));';
	assert.equal(
		(await client.prompt(request(nextCode), sessionId)).stopReason,
		"end_turn",
	);
	await waitForTerminal(client.updates, start);
	await client.waitForAnswer((text) => text.includes("after-cancel"), start);
	const { terminal } = assertParent(
		client.updates.slice(start),
		nextCode,
		"completed",
	);
	assert.match(JSON.stringify(terminal.rawOutput), /after-cancel/);
	assert.equal(client.stderr, "");
});

test("fresh production process resumes codemode without ACP input and later loads committed parent history", {
	timeout: 20000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const first = await f.client();
	const { sessionId } = await first.request("session/new", {
		cwd: f.cwd,
		mcpServers: [],
	});
	const code = `try {
		await tools.bash({ command: "echo $$ > shell.pid; sleep 60" });
	} catch (error) { text(String(error)); }
	await tools.write({ path: "recovered.txt", content: "native startup recovery" });
	text("CODEMODE_RECOVERED");`;
	void first.prompt(request(code), sessionId).catch(() => {});
	await waitFor(() => existsSync(join(f.cwd, "shell.pid")));
	const pid = Number(await readFile(join(f.cwd, "shell.pid"), "utf8"));
	t.after(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	});
	await waitFor(() =>
		toolUpdates(first.updates).some(
			(update) => update.sessionUpdate === "tool_call",
		),
	);
	const original = toolUpdates(first.updates)[0];
	assert.ok(original?.sessionUpdate === "tool_call");
	first.child.kill("SIGKILL");
	await first.exited;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {}
	const log = join(f.root, "recovery-requests");
	const recovery = spawn(process.execPath, ["dist/main.js"], {
		env: {
			...process.env,
			PID_ACP_PROVIDER_CONFIG: resolve("tests/helpers/persistence-provider.ts"),
			PID_ACP_MODEL: "faux-1",
			PID_ACP_THINKING: "off",
			PID_ACP_MCP_CONFIG: "",
			PID_ACP_INSTRUCTIONS: "",
			PID_ACP_SKILLS_DIR: "",
			PID_ACP_SESSIONS_DIR: f.sessions,
			PID_TEST_REQUEST_LOG: log,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const exited = once(recovery, "exit");
	let stdout = "";
	let stderr = "";
	recovery.stdout.on("data", (data) => {
		stdout += data;
	});
	recovery.stderr.on("data", (data) => {
		stderr += data;
	});
	t.after(async () => {
		if (recovery.exitCode === null && recovery.signalCode === null)
			recovery.kill("SIGKILL");
		await exited;
	});
	await waitFor(() => existsSync(join(f.cwd, "recovered.txt")));
	await waitFor(
		() =>
			existsSync(log) &&
			readFileSync(log, "utf8").includes('"lastRole":"toolResult"'),
	);
	assert.equal(
		await readFile(join(f.cwd, "recovered.txt"), "utf8"),
		"native startup recovery",
	);
	recovery.stdin.end();
	assert.deepEqual(await exited, [0, null]);
	assert.equal(
		stdout,
		"",
		"Recovery must not require any ACP request or emit unsolicited output",
	);
	assert.equal(stderr, "");
	const next = await f.client();
	await next.request("session/load", { sessionId, cwd: f.cwd, mcpServers: [] });
	const { start, terminal } = assertParent(next.updates, code, "completed");
	assert.equal(start.toolCallId, original.toolCallId);
	assert.match(JSON.stringify(terminal.rawOutput), /CODEMODE_RECOVERED/);
	assert.match(JSON.stringify(terminal.rawOutput), /interrupted/i);
	const offset = next.updates.length;
	assert.equal(
		(await next.prompt("continuation", sessionId)).stopReason,
		"end_turn",
	);
	await next.waitForAnswer(
		(text) => text.includes("Answer: continuation"),
		offset,
	);
	assert.equal(next.stderr, "");
});
