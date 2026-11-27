import { fixtureEnvironment } from "./environment.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type {
	InitializeRequest,
	InitializeResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
	ResumeSessionRequest,
	ResumeSessionResponse,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
	client,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
} from "@agentclientprotocol/sdk";
import { readText, type WireMessage } from "./updates.ts";

export async function startClient({
	live = false,
	inheritPidAcpEnv = false,
	cwd,
	env = {},
	executable = process.execPath,
	onUpdate,
}: {
	live?: boolean;
	inheritPidAcpEnv?: boolean;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	executable?: string;
	onUpdate?: (sessionId: string, update: SessionUpdate) => void;
} = {}) {
	const child = spawn(
		executable,
		[live ? "dist/main.js" : "tests/helpers/faux-server.ts"],
		{
			env: {
				...(inheritPidAcpEnv ? process.env : fixtureEnvironment()),
				PID_ACP_MCP_CONFIG: "",
				PID_ACP_INSTRUCTIONS: "",
				PID_ACP_SKILLS_DIR: "",
				PID_ACP_SESSIONS_DIR: undefined,
				...env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const exited = once(child, "exit");
	const updates: SessionUpdate[] = [];
	const wire: WireMessage[] = [];
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	let partial = "";
	child.stdout.on("data", (data) => {
		partial += data;
		const lines = partial.split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) if (line) wire.push(JSON.parse(line));
	});
	const app = client({ name: "pid-acp-test" }).onNotification(
		"session/update",
		({ params }) => {
			updates.push(params.update);
			onUpdate?.(params.sessionId, params.update);
		},
	);
	const connection = app.connect(
		ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
	);
	type Requests = {
		initialize: InitializeRequest;
		"session/new": NewSessionRequest;
		"session/prompt": PromptRequest;
		"session/load": LoadSessionRequest;
		"session/resume": ResumeSessionRequest;
		"_session/steering": {
			sessionId: string;
			prompt: { type: "text"; text: string }[];
			_meta?: { steering: { idleBehavior: "promptRequired" } };
		};
	};
	type Responses = {
		initialize: InitializeResponse;
		"session/new": NewSessionResponse;
		"session/prompt": PromptResponse;
		"session/load": LoadSessionResponse;
		"session/resume": ResumeSessionResponse;
		"_session/steering":
			| { outcome: "injected" }
			| { outcome: "promptRequired"; reason: "noRunningTurn" };
	};
	const request = <M extends keyof Requests>(
		method: M,
		params: Requests[M],
	): Promise<Responses[M]> =>
		connection.agent.request(method, params, {
			cancellationSignal: AbortSignal.timeout(120000),
		});
	const initialize = await request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: {},
	});
	const session = cwd
		? await request("session/new", { cwd, mcpServers: [] })
		: undefined;
	return {
		child,
		exited,
		updates,
		wire,
		initialize,
		session,
		request,
		waitForAnswer: async (matches: (text: string) => boolean, start = 0) => {
			await waitFor(() => matches(updates.slice(start).map(readText).join("")));
		},
		prompt: (text: string, sessionId = session?.sessionId) => {
			assert.ok(sessionId, "Create a session before prompting.");
			return request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text }],
			});
		},
		cancel: (sessionId = session?.sessionId) => {
			assert.ok(sessionId, "Create a session before cancelling.");
			return connection.agent.notify("session/cancel", { sessionId });
		},
		get stderr() {
			return stderr;
		},
		async close() {
			child.stdin.end();
			try {
				await Promise.race([
					exited,
					delay(5000, undefined, { ref: false }).then(() => {
						throw new Error("Server did not exit on EOF");
					}),
				]);
			} finally {
				if (child.exitCode === null) child.kill("SIGKILL");
				connection.close();
			}
		},
	};
}
export async function withClientDeadline<T>(
	kill: () => void,
	name: string,
	timeoutMs: number,
	operation: () => Promise<T>,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			kill();
			reject(new Error(`${name} exceeded ${timeoutMs}ms.`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([operation(), deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

// Busy rejects admission without executing the prompt; accepted turns are never retried.
export async function promptAfterRecovery<T>(
	admit: () => Promise<T>,
	timeout = 5000,
) {
	const deadline = Date.now() + timeout;
	for (;;) {
		try {
			return await admit();
		} catch (error) {
			if (
				!(error instanceof RequestError) ||
				error.code !== -32000 ||
				error.message !==
					"A prompt is already active. Cancel it or wait for completion." ||
				Date.now() >= deadline
			)
				throw error;
			await delay(10);
		}
	}
}

export async function waitFor(predicate: () => boolean, timeout = 5000) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error("Timed out waiting for assertion");
		await delay(10);
	}
}
