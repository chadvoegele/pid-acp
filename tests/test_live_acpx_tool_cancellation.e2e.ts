import type { WireMessage } from "./helpers/updates.ts";
import {
	readText,
	readStatus,
	readToolId,
	requireToolUpdate,
} from "./helpers/updates.ts";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { waitFor } from "./helpers/client.ts";

assert.ok(
	process.env.ACPX_CLI && isAbsolute(process.env.ACPX_CLI),
	"Set ACPX_CLI to the installed acpx 0.20.0 executable path.",
);
for (const key of [
	"PID_ACP_PROVIDERS",
	"PID_ACP_BASE_URL",
	"PID_ACP_MODEL",
	"PID_ACP_API_KEY",
])
	assert.ok(process.env[key], `Set ${key}.`);
const acpxCli = process.env.ACPX_CLI;
const version = execFileSync(process.execPath, [acpxCli, "--version"], {
	encoding: "utf8",
}).trim();
assert.equal(version, "0.20.0");
const cwd = await mkdtemp(join(tmpdir(), "pid-acp-external-"));
const quoteShellArgument = (value: string) =>
	`'${value.replaceAll("'", "'\\''")}'`;
const command = `${quoteShellArgument(process.execPath)} ${quoteShellArgument(resolve("dist/main.js"))}`;
const results = [];
function launch(prompt: string) {
	const child = spawn(
		process.execPath,
		[
			acpxCli,
			"--agent",
			command,
			"--cwd",
			cwd,
			"--format",
			"json",
			"--timeout",
			"30",
			"exec",
			prompt,
		],
		{ env: { ...process.env, PID_ACP_MCP_CONFIG: "" } },
	);
	const exited = once(child, "exit");
	const wire: WireMessage[] = [];
	let partial = "",
		stderr = "";
	child.stdout.on("data", (data) => {
		partial += data;
		const lines = partial.split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) if (line) wire.push(JSON.parse(line));
	});
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	return {
		child,
		exited,
		wire,
		get stderr() {
			return stderr;
		},
	};
}
let active: ReturnType<typeof launch> | undefined;
try {
	let started = Date.now();
	active = launch("Run pwd using the shell tool, then tell me the directory.");
	const [pwdCode] = await active.exited;
	assert.equal(pwdCode, 0);
	const updates = active.wire
		.filter((message) => message.method === "session/update")
		.flatMap((message) =>
			message.params?.update ? [message.params.update] : [],
		);
	const start = updates.find((update) => update.sessionUpdate === "tool_call");
	const terminal = updates.findIndex(
		(update) =>
			readToolId(update) === start?.toolCallId &&
			readStatus(update) === "completed",
	);
	assert.ok(start && terminal > updates.indexOf(start));
	assert.ok(
		JSON.stringify(requireToolUpdate(updates[terminal]).content).includes(cwd),
	);
	const chunks = updates
		.slice(terminal + 1)
		.filter((update) => update.sessionUpdate === "agent_message_chunk");
	assert.ok(
		chunks
			.map((update) => readText(update))
			.join("")
			.includes(cwd),
	);
	assert.ok(chunks.length > 1);
	assert.ok(
		active.wire.some((message) => message.result?.stopReason === "end_turn"),
		"The prompt response need not be the last wire message.",
	);
	assert.equal(active.stderr, "");
	results.push({
		name: "acpx-pwd",
		durationMs: Date.now() - started,
		exitCode: pwdCode,
		chunks: chunks.length,
		toolLifecycle: true,
		cwdVerified: true,
	});

	started = Date.now();
	active = launch(
		"Use bash to execute exactly: printf '%s\\n' $$ > shell.pid; sleep 60 & printf '%s\\n' $! > sleep.pid; printf 'pid-acp-external-ready\\n'; wait\nThe test client will cancel this foreground command.",
	);
	await waitFor(
		() =>
			active?.wire.some(
				(message) =>
					message.params?.update?.sessionUpdate === "tool_call_update" &&
					JSON.stringify(
						message.params?.update &&
							requireToolUpdate(message.params.update).content,
					).includes("pid-acp-external-ready"),
			) ?? false,
		20000,
	);
	const pids = await Promise.all(
		["shell.pid", "sleep.pid"].map(async (file) =>
			Number((await readFile(join(cwd, file), "utf8")).trim()),
		),
	);
	for (const pid of pids) process.kill(pid, 0);
	const cancelStart = Date.now();
	active.child.kill("SIGINT");
	const [cancelCode] = await active.exited;
	const cancelMs = Date.now() - cancelStart;
	assert.ok(active.wire.some((message) => message.method === "session/cancel"));
	assert.ok(
		active.wire.some((message) => message.result?.stopReason === "cancelled"),
	);
	assert.ok(cancelMs < 5000);
	for (const pid of pids) {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
		assert.ok(!stat || /^\d+ \(.*\) Z /.test(stat));
	}
	results.push({
		name: "acpx-SIGINT-cancel",
		durationMs: Date.now() - started,
		cancelMs,
		exitCode: cancelCode,
		wireCancel: true,
		stopReason: "cancelled",
		childrenStopped: true,
	});
	process.stdout.write(
		`${JSON.stringify({ date: new Date().toISOString(), client: `acpx ${version}`, node: process.version, results, passed: true }, null, 2)}\n`,
	);
} finally {
	if (active && active.child.exitCode === null) {
		active.child.kill("SIGTERM");
		await active.exited;
	}
	await rm(cwd, { recursive: true, force: true });
}
