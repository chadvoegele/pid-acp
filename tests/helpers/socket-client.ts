import { fixtureEnvironment } from "./environment.ts";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Duplex } from "node:stream";
import type { TestContext } from "node:test";
import {
	client,
	ndJsonStream,
	PROTOCOL_VERSION,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { readText } from "./updates.ts";

export async function socketFixture(t: TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "pid-sock-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const path = join(cwd, "acp.sock");
	const selection: { cwd: string; mcpServers: [] } = { cwd, mcpServers: [] };

	function launch(overrides: NodeJS.ProcessEnv = {}) {
		const child = fork("dist/main.js", [], {
			execArgv: ["--import", "./tests/helpers/socket-observer.ts"],
			env: {
				...fixtureEnvironment(),
				PID_ACP_PROVIDERS: resolve("tests/helpers/socket-provider.ts"),
				PID_ACP_MODEL: "faux-1",
				PID_ACP_SOCKET_PATH: path,
				PID_ACP_SESSIONS_DIR: join(cwd, "sessions"),
				PID_ACP_MCP_CONFIG: "",
				PID_ACP_INSTRUCTIONS: "",
				PID_ACP_SKILLS_DIR: "",
				PID_TEST_RECOVER: undefined,
				PID_TEST_FOREIGN_OWNER: undefined,
				...overrides,
			},
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8").on("data", (data: string) => {
			stdout += data;
		});
		child.stderr?.setEncoding("utf8").on("data", (data: string) => {
			stderr += data;
		});
		child.stdin?.end();
		const events: string[] = [];
		const changed = new EventEmitter();
		child.on("message", (message) => {
			assert.equal(typeof message, "string");
			events.push(message as string);
			changed.emit("change");
		});
		const exited = once(child, "close");
		child.on("close", () => changed.emit("change"));
		t.after(async () => {
			child.kill("SIGKILL");
			await exited;
		});
		return {
			child,
			events,
			exited,
			get stdout() {
				return stdout;
			},
			get stderr() {
				return stderr;
			},
			send: (message: string) => child.send(message),
			async wait(message: string, count = 1) {
				while (events.filter((event) => event === message).length < count) {
					if (child.exitCode !== null || child.signalCode !== null)
						throw new Error(`Server exited waiting for ${message}: ${stderr}`);
					await once(changed, "change");
				}
			},
		};
	}

	async function connect() {
		const socket = createConnection(path);
		t.after(() => {
			socket.destroy();
		});
		await once(socket, "connect");
		const { writable, readable } = Duplex.toWeb(socket);
		const updates: SessionNotification[] = [];
		const changed = new EventEmitter();
		const wire = client({ name: "socket-test" })
			.onNotification("session/update", ({ params }) => {
				updates.push(params);
				changed.emit("update");
			})
			.connect(ndJsonStream(writable, readable));
		const initialized = await wire.agent.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
		const text = () => updates.map(({ update }) => readText(update)).join("");
		return {
			initialized,
			updates,
			wire,
			text,
			close: () => socket.destroy(),
			newSession: async () =>
				(await wire.agent.request("session/new", { cwd, mcpServers: [] }))
					.sessionId,
			load: (sessionId: string) =>
				wire.agent.request("session/load", { ...selection, sessionId }),
			prompt: (sessionId: string, text: string) =>
				wire.agent.request("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text }],
				}),
			steer: (sessionId: string, text: string) =>
				wire.agent.request("_session/steering", {
					sessionId,
					prompt: [{ type: "text", text }],
				}),
			cancel: (sessionId: string) =>
				wire.agent.notify("session/cancel", { sessionId }),
			async waitForText(answer: string) {
				while (!text().includes(answer)) await once(changed, "update");
			},
		};
	}

	return { cwd, path, launch, connect };
}
