import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { startClient, waitFor, withClientDeadline } from "./helpers/client.ts";
import { requireLiveProvider } from "./helpers/live-provider.ts";
import { startMcpHttpFixture } from "./helpers/mcp-http-fixture.ts";
import { assertChildrenStopped } from "./helpers/processes.ts";
import { readNativeToolTrace } from "./helpers/native-tool-trace.ts";

function collectToolUpdates(updates: SessionUpdate[]) {
	return updates.filter(
		(update) =>
			update.sessionUpdate === "tool_call" ||
			update.sessionUpdate === "tool_call_update",
	);
}

async function requireParent(
	updates: SessionUpdate[],
	start: number,
	status: "completed" | "failed",
) {
	await waitFor(() =>
		collectToolUpdates(updates.slice(start)).some(
			(update) => update.status === status,
		),
	);
	const tools = collectToolUpdates(updates.slice(start));
	const calls = tools.filter((update) => update.sessionUpdate === "tool_call");
	assert.equal(calls.length, 1, "Only the codemode parent row is presented.");
	const call = calls[0];
	assert.ok(call);
	assert.equal(call.title, "codemode");
	assert.equal(typeof (call.rawInput as { code?: unknown })?.code, "string");
	assert.deepEqual(Object.keys(call.rawInput as object), ["code"]);
	const native = await readNativeToolTrace(
		join(root, "sessions"),
		call.toolCallId,
	);
	assert.equal(native.call.name, "codemode");
	assert.deepEqual(call.rawInput, native.call.arguments);
	assert.ok(tools.every((update) => update.toolCallId === call.toolCallId));
	assert.equal(tools.filter((update) => update.status === status).length, 1);
	assert.equal(tools.at(-1)?.status, status);
	return {
		toolCallId: call.toolCallId,
		rawInput: call.rawInput,
		status,
		parentRows: 1,
		nestedRows: 0,
		output: JSON.stringify(tools.at(-1)?.rawOutput),
	};
}

function createPrompt(code: string, instruction: string) {
	return `This is an explicit MCP codemode acceptance test in a disposable workspace. Call codemode exactly once to perform the operations shown in this JavaScript example. Do not issue any other tool calls in the same response or afterward: no discovery, direct bash, read or filesystem inspection. After codemode returns, answer directly from its output without additional tools. Then ${instruction}\n\n${code}`;
}

const evidence = { ...(await requireLiveProvider()), checks: [] as object[] };
const root = await mkdtemp(join(tmpdir(), "pid-acp-live-mcp-"));
const cwd = join(root, "workspace");
const config = join(root, "mcp.json");
const log = join(root, "stdio.jsonl");
const stdioToken = randomUUID();
const httpToken = randomUUID();
const recoveredToken = randomUUID();
const http = await startMcpHttpFixture(httpToken);
const clients: Awaited<ReturnType<typeof startClient>>[] = [];

function readRecords() {
	return (existsSync(log) ? readFileSync(log, "utf8") : "")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; pid: number });
}

function countCalls(name: string) {
	return readRecords().filter((record) => record.event === `call:${name}`)
		.length;
}

async function configure(tools: string, token = stdioToken) {
	await writeFile(
		config,
		JSON.stringify({
			mcpServers: {
				stdio: {
					command: process.execPath,
					args: [resolve("tests/helpers/mcp-stdio-fixture.ts")],
					env: {
						MCP_FIXTURE_LOG: log,
						MCP_FIXTURE_TOOLS: tools,
						MCP_FIXTURE_TOKEN: token,
					},
					description: "Disposable live stdio fixture",
				},
				http: { url: http.url, description: "Disposable live HTTP fixture" },
			},
		}),
		{ mode: 0o600 },
	);
}

async function openClient() {
	const client = await startClient({
		live: true,
		env: {
			PID_ACP_MCP_CONFIG: config,
			PID_ACP_SESSIONS_DIR: join(root, "sessions"),
		},
	});
	clients.push(client);
	assert.equal(client.initialize.agentCapabilities?.loadSession, true);
	return client;
}

async function closeClient(client: Awaited<ReturnType<typeof startClient>>) {
	await client.close();
	assert.deepEqual(await client.exited, [0, null]);
	assert.equal(client.stderr, "");
	await assertChildrenStopped(
		readRecords()
			.filter((record) => record.event === "start")
			.map((record) => record.pid),
	);
}

function record(name: string, started: number, details: object) {
	const check = { name, durationMs: Date.now() - started, ...details };
	evidence.checks.push(check);
	process.stdout.write(`${JSON.stringify(check)}\n`);
}

async function runPrompt(
	client: Awaited<ReturnType<typeof startClient>>,
	sessionId: string,
	code: string,
	matches: (answer: string) => boolean,
	instruction = "report every token from the tool results verbatim.",
) {
	const start = client.updates.length;
	assert.equal(
		(await client.prompt(createPrompt(code, instruction), sessionId))
			.stopReason,
		"end_turn",
	);
	await client.waitForAnswer(matches, start);
	return requireParent(client.updates, start, "completed");
}

async function verifyResultConsumption(
	client: Awaited<ReturnType<typeof startClient>>,
	sessionId: string,
) {
	const started = Date.now();
	const code = `text(await tools.mcp__stdio__old({}));
text(await tools.mcp__http__value({}));`;
	const initial = await runPrompt(
		client,
		sessionId,
		code,
		(answer) => answer.includes(stdioToken) && answer.includes(httpToken),
	);
	assert.ok(initial.output.includes(stdioToken));
	assert.ok(initial.output.includes(httpToken));
	assert.equal(countCalls("old"), 1);
	assert.equal(
		http.requests.filter((request) => request.message.method === "tools/call")
			.length,
		1,
	);
	record("stdio-http-result-consumption", started, {
		...initial,
		modelConsumedUnpromptedValues: true,
		stdioCalls: 1,
		httpCalls: 1,
	});
}

async function verifyCancellation(
	client: Awaited<ReturnType<typeof startClient>>,
	sessionId: string,
) {
	let started = Date.now();
	const start = client.updates.length;
	const cancelCode = "text(await tools.mcp__http__hold({}));";
	const pending = client.prompt(
		createPrompt(cancelCode, "wait for completion; the client will cancel."),
		sessionId,
	);
	void pending.catch(() => {});
	await waitFor(
		() =>
			http.requests.some(
				(request) =>
					(request.message.params as { name?: string })?.name === "hold",
			),
		60000,
	);
	const cancelStarted = Date.now();
	await client.cancel(sessionId);
	assert.equal((await pending).stopReason, "cancelled");
	await waitFor(() => http.cancellations.length === 1);
	const cancelled = await requireParent(client.updates, start, "failed");
	assert.equal(
		http.deleted.length,
		1,
		"Cancel must not close a healthy client.",
	);
	const cancelledSession = http.cancellations[0];
	assert.ok(cancelledSession);
	http.release(cancelledSession);
	record("observed-in-flight-mcp-cancellation", started, {
		...cancelled,
		cancelMs: Date.now() - cancelStarted,
		protocolCancellations: http.cancellations.length,
		stopReason: "cancelled",
	});

	started = Date.now();
	const next = await runPrompt(
		client,
		sessionId,
		"text(await tools.mcp__http__value({}));",
		(answer) => answer.includes(httpToken),
	);
	assert.ok(next.output.includes(httpToken));
	assert.doesNotMatch(
		JSON.stringify(client.updates.slice(start)),
		/held-complete/,
	);
	record("next-prompt-after-cancel", started, next);
}

async function openWithRemovedTool(sessionId: string) {
	const started = Date.now();
	await configure("value,mutate_hold,after_restart");
	const client = await openClient();
	const requestsBeforeLoad = http.requests.length;
	await client.request("session/load", { sessionId, cwd, mcpServers: [] });
	assert.equal(http.requests.length, requestsBeforeLoad);
	assert.ok(JSON.stringify(client.updates).includes(stdioToken));
	const missing = await runPrompt(
		client,
		sessionId,
		`let failed = false;
try { await tools.mcp__stdio__old({}); } catch (error) { failed = true; text(String(error)); }
if (!failed) throw new Error("Removed tool unexpectedly succeeded");
text("REMOVED_TOOL_FAILED");
text(await tools.mcp__http__value({}));`,
		(answer) =>
			answer.includes("REMOVED_TOOL_FAILED") && answer.includes(httpToken),
		"report REMOVED_TOOL_FAILED and the HTTP result token verbatim.",
	);
	assert.match(missing.output, /REMOVED_TOOL_FAILED/);
	assert.equal(countCalls("old"), 1, "Removed tool must not dispatch again.");
	record("persistent-restart-current-config-removal", started, {
		...missing,
		oldToolCalls: countCalls("old"),
		loadEstablishedNoConnections: true,
	});
	return client;
}

async function verifyNativeRecovery(
	client: Awaited<ReturnType<typeof startClient>>,
	sessionId: string,
) {
	const started = Date.now();
	const phaseStart = client.updates.length;
	const recoveryCode = `text(await tools.mcp__stdio__value({}));
try { await tools.mcp__stdio__mutate_hold({}); } catch (error) { text(String(error)); }
try { await tools.mcp__stdio__value({}); } catch (error) { text(String(error)); }
text(await tools.mcp__stdio__after_restart({}));
await tools.write({ path: "recovered.txt", content: "native-recovery-completed" });`;
	void client
		.prompt(
			createPrompt(
				recoveryCode,
				"report all result tokens and failures verbatim.",
			),
			sessionId,
		)
		.catch(() => {});
	await waitFor(() => countCalls("mutate_hold") === 1, 60000);
	assert.equal(countCalls("value"), 1);
	assert.equal(countCalls("after_restart"), 0);
	await waitFor(() =>
		collectToolUpdates(client.updates.slice(phaseStart)).some(
			(update) => update.sessionUpdate === "tool_call",
		),
	);
	const admitted = collectToolUpdates(client.updates.slice(phaseStart)).filter(
		(update) => update.sessionUpdate === "tool_call",
	);
	assert.equal(admitted.length, 1);
	const original = admitted[0];
	assert.ok(original);
	assert.equal(original.title, "codemode");
	client.child.kill("SIGKILL");
	assert.deepEqual(await client.exited, [null, "SIGKILL"]);
	await assertChildrenStopped(
		readRecords()
			.filter((entry) => entry.event === "start")
			.map((entry) => entry.pid),
	);
	await configure("after_restart", recoveredToken);
	client = await openClient();
	await waitFor(() => existsSync(join(cwd, "recovered.txt")), 60000);
	assert.equal(
		await readFile(join(cwd, "recovered.txt"), "utf8"),
		"native-recovery-completed",
	);
	assert.equal(client.updates.length, 0, "Recovery precedes ACP attachment.");
	await client.request("session/load", { sessionId, cwd, mcpServers: [] });
	await client.waitForAnswer((answer) => answer.includes(recoveredToken));
	await waitFor(() =>
		collectToolUpdates(client.updates).some(
			(update) =>
				update.status === "completed" &&
				JSON.stringify(update.rawOutput).includes(recoveredToken),
		),
	);
	const history = JSON.stringify(client.updates);
	assert.match(history, /interrupted/i);
	assert.match(history, /not available/);
	assert.ok(history.includes(stdioToken), "Completed nested results survive.");
	assert.equal(
		countCalls("value"),
		1,
		"Completed MCP call is reused, not replayed.",
	);
	assert.equal(
		countCalls("mutate_hold"),
		1,
		"Unsafe interrupted effect is not repeated.",
	);
	assert.equal(countCalls("after_restart"), 1);
	assert.ok(
		collectToolUpdates(client.updates)
			.filter((update) => update.sessionUpdate === "tool_call")
			.every((update) => update.title === "codemode"),
	);
	const recoveryStart = client.updates.findIndex(
		(update) =>
			update.sessionUpdate === "tool_call" &&
			update.toolCallId === original.toolCallId,
	);
	assert.ok(recoveryStart >= 0);
	const recovered = await requireParent(
		client.updates,
		recoveryStart,
		"completed",
	);
	assert.deepEqual(
		recovered.rawInput,
		original.rawInput,
		"Recovered history preserves the actual admitted input, not the prompted example.",
	);
	assert.ok(recovered.output.includes(stdioToken));
	assert.ok(recovered.output.includes(recoveredToken));
	assert.match(recovered.output, /interrupted/i);
	assert.match(recovered.output, /not available/);
	record("unattached-native-recovery-current-tools", started, {
		...recovered,
		completedCalls: countCalls("value"),
		unsafeEffectCalls: countCalls("mutate_hold"),
		afterRestartCalls: countCalls("after_restart"),
		modelConsumedNewRecoveryToken: true,
		nestedRows: 0,
	});
	await closeClient(client);
}

async function verifyLiveMcp() {
	await mkdir(cwd);
	await writeFile(log, "");
	await configure("value,old,mutate_hold,after_restart");
	const client = await openClient();
	const { sessionId } = await client.request("session/new", {
		cwd,
		mcpServers: [],
	});
	await verifyResultConsumption(client, sessionId);
	await verifyCancellation(client, sessionId);
	await closeClient(client);
	assert.equal(http.deleted.length, 2);
	const restarted = await openWithRemovedTool(sessionId);
	await verifyNativeRecovery(restarted, sessionId);
}

try {
	await withClientDeadline(
		() => {
			for (const client of clients) client.child.kill("SIGKILL");
		},
		"Live MCP acceptance",
		180000,
		verifyLiveMcp,
	);
} catch (error) {
	process.stderr.write(
		`${JSON.stringify({
			author: "Chad's Agent",
			passed: false,
			checks: evidence.checks,
			clients: clients.map((client) => ({
				tools: collectToolUpdates(client.updates),
				answer: client.updates
					.filter((update) => update.sessionUpdate === "agent_message_chunk")
					.map((update) => update.content)
					.slice(-40),
			})),
		}).slice(0, 65536)}\n`,
	);
	throw error;
} finally {
	try {
		await Promise.allSettled(clients.map((client) => client.close()));
		await assertChildrenStopped(
			readRecords()
				.filter((record) => record.event === "start")
				.map((record) => record.pid),
		);
	} finally {
		await http.close();
		await rm(root, { recursive: true, force: true });
	}
}
process.stdout.write(
	`${JSON.stringify({ ...evidence, childrenStopped: true, fixturesRemoved: true, passed: true })}\n`,
);
