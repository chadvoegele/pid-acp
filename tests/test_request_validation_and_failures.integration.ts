import { existsSync } from "node:fs";
import type { McpServer } from "@agentclientprotocol/sdk";
import { readStatus } from "./helpers/updates.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startClient, waitFor } from "./helpers/client.ts";

test("explicit errors, creation races, overlap, provider failure and failed shell", {
	timeout: 15000,
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pid-acp-errors-"));
	const started = join(cwd, "model-started");
	const client = await startClient({
		env: {
			PID_ACP_API_KEY: "never-print-this-test-key",
			PID_TEST_MODEL_STARTED: started,
		},
	});
	try {
		assert.equal(client.initialize.agentCapabilities?.loadSession, false);
		await assert.rejects(
			client.request("session/load", {
				sessionId: "transient",
				cwd,
				mcpServers: [],
			}),
			/PID_ACP_SESSIONS_DIR/,
		);
		assert.equal(
			client.initialize.agentCapabilities?.sessionCapabilities?.resume,
			undefined,
		);
		await assert.rejects(
			client.request("session/resume", { sessionId: "transient", cwd }),
			/Method not found/,
		);
		const create = (cwd: string, mcpServers: McpServer[] = []) =>
			client.request("session/new", { cwd, mcpServers });
		await assert.rejects(create("relative"), /absolute directory/);
		await assert.rejects(create(join(cwd, "missing")), /absolute directory/);
		await assert.rejects(
			create(cwd, [
				{ name: "unsupported", command: "echo", args: [], env: [] },
			]),
			/MCP/,
		);
		const [created, sibling] = await Promise.all([create(cwd), create(cwd)]);
		assert.notEqual(created.sessionId, sibling.sessionId);
		const sessionId = created.sessionId;
		await assert.rejects(client.prompt("hello", "unknown"), /Unknown session/);
		await assert.rejects(
			client.request("session/prompt", {
				sessionId,
				prompt: [{ type: "image", data: "", mimeType: "image/png" }],
			}),
			/text/,
		);
		await assert.rejects(
			client.request("session/prompt", { sessionId, prompt: [] }),
			/text/,
		);
		await assert.rejects(
			client.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "  " }],
			}),
			/text/,
		);
		const blocked = client.prompt("model-block", sessionId);
		await waitFor(() => existsSync(started));
		const independent = await create(cwd);
		assert.equal(
			(await client.prompt("independent", independent.sessionId)).stopReason,
			"end_turn",
		);
		await client.cancel(sessionId);
		assert.equal((await blocked).stopReason, "cancelled");
		await assert.rejects(
			client.prompt("provider-error", sessionId),
			/Prompt failed/,
		);
		assert.ok(!client.stderr.includes("never-print-this-test-key"));
		assert.ok(
			!JSON.stringify(client.wire).includes("never-print-this-test-key"),
		);
		assert.equal(
			(await client.prompt("shell-fail", sessionId)).stopReason,
			"end_turn",
		);
		await client.waitForAnswer((text) =>
			text.includes("The shell returned: failure"),
		);
		const failed = client.updates.find(
			(update) => readStatus(update) === "failed",
		);
		assert.ok(failed);
		assert.ok(JSON.stringify(failed).includes("failure"));
		assert.equal(
			(await client.prompt("healthy", sessionId)).stopReason,
			"end_turn",
		);
	} finally {
		await client.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
