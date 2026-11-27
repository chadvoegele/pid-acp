import { fixtureEnvironment } from "./helpers/environment.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { waitFor } from "./helpers/client.ts";
import { Runtime } from "../dist/runtime.js";
import { createModels } from "@earendil-works/pi-ai/models";

function assertAcpOnly(stdout: string) {
	for (const line of stdout.split("\n").filter(Boolean))
		assert.equal(JSON.parse(line).jsonrpc, "2.0");
}

async function shutdownStdioServer(
	t: TestContext,
	env: NodeJS.ProcessEnv = {},
) {
	const root = await mkdtemp(join(tmpdir(), "pid-stdio-server-shutdown-"));
	const cwd = join(root, "workspace");
	const sessions = join(root, "sessions");
	await mkdir(cwd);
	const child = fork("tests/helpers/shutdown-stdio-server.ts", {
		silent: true,
		env: {
			...fixtureEnvironment(),
			PID_ACP_MCP_CONFIG: "",
			PID_ACP_SESSIONS_DIR: sessions,
			...env,
		},
	});
	const exited = once(child, "close");
	const messages: unknown[] = [];
	let stderr = "";
	let stdout = "";
	child.on("message", (message) => messages.push(message));
	child.stderr?.on("data", (data) => {
		stderr += data;
	});
	child.stdout?.on("data", (data) => {
		stdout += data;
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		await exited;
		await rm(root, { recursive: true, force: true });
	});
	child.stdin?.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "session/new",
			params: { cwd, mcpServers: [] },
		})}\n`,
	);
	await waitFor(() => messages.includes("opening"));
	return {
		child,
		exited,
		messages,
		cwd,
		sessions,
		get stderr() {
			return stderr;
		},
		get stdout() {
			return stdout;
		},
		wait: (message: string) => waitFor(() => messages.includes(message)),
	};
}

for (const action of ["EOF", "SIGINT", "SIGTERM", "storage-failure"] as const) {
	test(`stdio server waits for opening on ${action} and releases the eventual session`, {
		timeout: 10000,
	}, async (t) => {
		const f = await shutdownStdioServer(t, { PID_TEST_DEFER_CLEANUP: "1" });
		if (action === "EOF") f.child.stdin?.end();
		else if (action === "storage-failure") f.child.send(action);
		else f.child.kill(action);
		await f.wait("close-attempt");
		if (action.startsWith("SIG")) f.child.kill("SIGTERM");
		assert.equal(f.messages.includes("cleanup"), false);
		assert.equal(f.child.exitCode, null);
		// Signals and fatal storage shutdown must close transport admission while opening continues.
		if (action !== "EOF") {
			f.child.stdin?.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 1 } })}\n`,
			);
		}
		f.child.send("release-open");
		await f.wait("cleanup");
		assert.deepEqual(f.messages, [
			"opening",
			"close-attempt",
			"rolled-back",
			"cleanup",
		]);
		assert.equal(f.child.exitCode, null);
		assert.equal(f.messages.includes("released"), false);
		f.child.send("release-cleanup");
		await f.exited;
		assertAcpOnly(f.stdout);
		assert.equal(f.child.exitCode, action === "storage-failure" ? 1 : 0);
		assert.equal(
			f.messages.filter((message) => message === "released").length,
			1,
		);
		assert.equal(
			f.messages.filter((message) => message === "cleanup").length,
			1,
		);
		assert.doesNotMatch(f.stdout, /"id":2/);
		assert.doesNotMatch(f.stderr, /PRIVATE|Shutdown failed|deadline/);
		if (action === "storage-failure")
			assert.equal(
				f.stderr,
				"pid-acp: Session storage failed; closing server. Check private session storage and available disk space.\n",
			);
		else assert.equal(f.stderr, "");
		// Real filesystem lock release, not process-exit-only cleanup.

		const runtime = await Runtime.open(
			createModels(),
			{ provider: "unused", modelId: "unused" },
			"off",
			{},
			f.sessions,
		);
		await runtime.close();
	});
}

for (const phase of ["opening", "cleanup"] as const) {
	test(`stdio server enforces the existing four-second deadline during ${phase}`, {
		timeout: 10000,
	}, async (t) => {
		const f = await shutdownStdioServer(t, { PID_TEST_DEFER_CLEANUP: "1" });
		const start = Date.now();
		f.child.stdin?.end();
		await f.wait("close-attempt");
		if (phase === "cleanup") {
			f.child.send("release-open");
			await f.wait("cleanup");
		}
		await f.exited;
		assert.equal(f.child.exitCode, 1);
		assertAcpOnly(f.stdout);
		assert.equal(f.stderr, "pid-acp: Shutdown deadline exceeded.\n");
		assert.equal(f.messages.includes("released"), false);
		assert.ok(Date.now() - start >= 3900);
		assert.ok(Date.now() - start < 6000);
		assert.equal(
			f.messages.filter((message) => message === "close-attempt").length,
			1,
		);
	});
}

for (const action of ["EOF", "SIGTERM"] as const) {
	test(`stdio server surfaces cleanup failure on ${action} without retrying it`, {
		timeout: 10000,
	}, async (t) => {
		const f = await shutdownStdioServer(t, { PID_TEST_FAIL_CLEANUP: "1" });
		if (action === "EOF") f.child.stdin?.end();
		else f.child.kill(action);
		await f.wait("close-attempt");
		f.child.send("release-open");
		await f.exited;
		assert.equal(f.child.exitCode, 1);
		assert.equal(
			f.messages.filter((message) => message === "close-error").length,
			1,
		);
		assert.equal(
			f.messages.filter((message) => message === "cleanup").length,
			1,
		);
		assert.equal(f.messages.includes("released"), true);
		assertAcpOnly(f.stdout);
		assert.equal(
			f.stderr,
			"pid-acp: Shutdown failed; check session storage and execution environment cleanup.\n",
		);
		assert.doesNotMatch(f.stderr, /PRIVATE|deadline/);
	});
}
