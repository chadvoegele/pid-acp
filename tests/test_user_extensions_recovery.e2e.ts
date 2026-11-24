import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type ConversationId,
	createRegistry,
	Harness,
	type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { persistenceFixture } from "./helpers/persistence.ts";
import { assertChildrenStopped } from "./helpers/processes.ts";

const startupTimeout = 5000;

async function installFixture(root: string) {
	await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
	const path = join(root, "recovery.mts");
	await copyFile(
		new URL("./helpers/recovery-extension.mts", import.meta.url),
		path,
	);
	const {
		default: extension,
		task,
		result,
	} = (await import(
		pathToFileURL(path).href
	)) as typeof import("./helpers/recovery-extension.mts");
	return { path, extension, task, result };
}

async function seedTask(
	db: string,
	conversationId: ConversationId,
	{ extension, task }: Awaited<ReturnType<typeof installFixture>>,
	started: string,
) {
	const registry = createRegistry();
	registry.install(extension);
	// Opening the native Harness without resuming it makes the pending seed deterministic.
	const harness = await Harness.open(
		await openNodeJsonlStorage(db, context, { fsync: true }),
		{ models: createModels(), registry },
		context,
	);
	try {
		const conversation = await harness.conversation(conversationId, context);
		assert.ok(conversation);
		return await conversation.commit(
			(tx) =>
				tx.createTask(
					task,
					{ started },
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
	} finally {
		await harness.close(context);
	}
}

async function readSavedTask(db: string, id: TaskId) {
	const storage = await openNodeJsonlStorage(db, context, { readOnly: true });
	try {
		return await storage.task(id, context);
	} finally {
		await storage.close(context);
	}
}

function launch(env: NodeJS.ProcessEnv) {
	const child = spawn(process.execPath, ["dist/main.js"], {
		env,
		timeout: 2 * startupTimeout,
		killSignal: "SIGKILL",
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (text) => {
		stdout += text;
	});
	child.stderr.setEncoding("utf8").on("data", (text) => {
		stderr += text;
	});
	const exited = once(child, "close");
	return {
		child,
		exited,
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

async function writeMcpConfig(root: string) {
	const mcpConfig = join(root, "mcp.json");
	const mcpLog = join(root, "mcp.log");
	await writeFile(
		mcpConfig,
		JSON.stringify({
			mcpServers: {
				fixture: {
					command: process.execPath,
					args: [resolve("tests/helpers/mcp-stdio-fixture.ts")],
					env: { MCP_FIXTURE_LOG: mcpLog },
				},
			},
		}),
		{ mode: 0o600 },
	);
	return { mcpConfig, mcpLog };
}

test("production CLI recovers a user task before ACP input, even after a failed startup", {
	timeout: 25000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const db = join(f.sessions, "db");
	const started = join(f.root, "task-started");
	const fixture = await installFixture(f.root);
	const { path: extension, result } = fixture;
	const runtime = await f.runtime();
	const session = await runtime.createSession(f.cwd);
	await session.close();
	await runtime.close();
	const id = await seedTask(db, session.conversation.id, fixture, started);
	const pending = await readSavedTask(db, id);
	assert.equal(pending?.state.status, "pending");

	const invalid = join(f.root, "invalid.mjs");
	const privateDetail = "private-fixture-detail";
	await writeFile(
		invalid,
		`
		export default {
			name: "fixture.invalid",
			tools: [{ name: ${JSON.stringify(privateDetail)} }, { name: ${JSON.stringify(privateDetail)} }],
		};
	`,
	);
	const { mcpConfig, mcpLog } = await writeMcpConfig(f.root);
	const env = {
		PID_ACP_PROVIDERS: resolve("tests/helpers/native-provider.ts"),
		PID_ACP_MODEL: "faux-1",
		PID_ACP_SESSIONS_DIR: f.sessions,
		PID_ACP_INSTRUCTIONS: "",
		PID_ACP_SKILLS_DIR: "",
		PID_ACP_MCP_CONFIG: mcpConfig,
	};

	const failed = launch({
		...env,
		PID_ACP_EXTENSIONS: JSON.stringify([extension, invalid]),
	});
	assert.deepEqual(await failed.exited, [1, null]);
	assert.equal(failed.stdout, "");
	assert.match(
		failed.stderr,
		/^pid-acp: PID_ACP_EXTENSIONS entry 2 \(registration\): Check[^\n]+\n$/,
	);
	assert.ok(!failed.stderr.includes(privateDetail));
	await assert.rejects(stat(started), { code: "ENOENT" });
	assert.deepEqual(await readSavedTask(db, id), pending);

	const valid = launch({
		...env,
		PID_ACP_EXTENSIONS: JSON.stringify([extension]),
	});
	try {
		// Poll the commit log first: a live write can reclaim the pending task's sidecar.
		const deadline = Date.now() + startupTimeout;
		while (
			!(await readFile(join(db, "main.jsonl"), "utf8"))
				.split("\n")
				.slice(0, -1)
				.some((line) => line.includes(result))
		) {
			assert.equal(valid.child.exitCode, null, valid.stderr);
			assert.ok(
				Date.now() < deadline,
				`Task did not commit before ACP input. ${valid.stderr}`,
			);
			await delay(10);
		}
		assert.deepEqual((await readSavedTask(db, id))?.state, {
			status: "terminal",
			outcome: { status: "completed", result },
		});
		assert.equal(valid.stdout, "");
		// Stdin has received no bytes. EOF now exercises the normal host shutdown.
		valid.child.stdin.end();
		assert.deepEqual(await valid.exited, [0, null]);
		assert.equal(valid.stdout, "");
		assert.equal(valid.stderr, "");
	} finally {
		if (valid.child.exitCode === null && valid.child.signalCode === null)
			valid.child.kill("SIGKILL");
		await valid.exited;
	}

	const events = (await readFile(mcpLog, "utf8"))
		.trimEnd()
		.split("\n")
		.map(
			(line) => JSON.parse(line) as { event: string; pid: number; cwd: string },
		);
	const workspaceEvents = events.filter(({ cwd }) => cwd === f.cwd);
	assert.deepEqual(
		workspaceEvents.map(({ event }) => event),
		["start", "close"],
	);
	await assertChildrenStopped(
		events.filter(({ event }) => event === "start").map(({ pid }) => pid),
	);
});
