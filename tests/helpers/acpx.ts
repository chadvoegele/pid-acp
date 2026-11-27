import { fixtureEnvironment } from "./environment.ts";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { waitFor } from "./client.ts";

export interface AcpxTrace {
	pid: number;
	launcherPid: number;
	ownerPid: number;
	direction: "client" | "server";
	message: {
		id?: number;
		method?: string;
		params?: { sessionId?: string; update?: SessionUpdate };
		result?: { sessionId?: string; stopReason?: string };
		error?: { message: string; data?: unknown };
	};
}

export async function acpxFixture(t: TestContext, live = false) {
	const cli = process.env.ACPX_CLI;
	assert.ok(cli && isAbsolute(cli), "Set ACPX_CLI to acpx 0.20.0.");
	const cliPath = cli;
	assert.equal(
		execFileSync(process.execPath, [cli, "--version"], {
			encoding: "utf8",
		}).trim(),
		"0.20.0",
	);
	const root = await mkdtemp(join(tmpdir(), "pid-acpx-"));
	const cwd = join(root, "workspace");
	const sessions = join(root, "sessions");
	const trace = join(root, "wire.ndjson");
	await mkdir(cwd);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const command = [
		process.execPath,
		resolve("tests/helpers/acpx-server.ts"),
		resolve("dist/main.js"),
		trace,
	]
		.map(quote)
		.join(" ");
	const children: ReturnType<typeof spawn>[] = [];
	const records = new Set<string>();
	const readTrace = (): AcpxTrace[] => {
		try {
			return readFileSync(trace, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	function start(args: string[], env: NodeJS.ProcessEnv = {}) {
		const child = spawn(
			process.execPath,
			[
				cliPath,
				"--agent",
				command,
				"--cwd",
				cwd,
				"--format",
				"json",
				"--json-strict",
				"--timeout",
				"30",
				"--ttl",
				"0.1",
				...args,
			],
			{
				env: {
					...(live ? process.env : fixtureEnvironment()),
					PID_ACP_MCP_CONFIG: "",
					PID_ACP_INSTRUCTIONS: "",
					PID_ACP_SKILLS_DIR: "",
					PID_ACP_THINKING: "off",
					...(!live && {
						PID_ACP_PROVIDERS: resolve("tests/helpers/persistence-provider.ts"),
						PID_ACP_MODEL: "faux-1",
					}),
					PID_ACP_SESSIONS_DIR: sessions,
					...env,
				},
			},
		);
		children.push(child);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (data) => {
			stdout += data;
		});
		child.stderr?.on("data", (data) => {
			stderr += data;
		});
		const done = once(child, "close").then(([code]) => {
			for (const line of stdout.split("\n").slice(0, -1)) {
				if (!line) continue;
				const row = JSON.parse(line);
				if (row.action !== "session_ensured" || !row.created) continue;
				assert.match(row.acpxRecordId, /^[0-9a-f-]{36}$/);
				records.add(row.acpxRecordId);
			}
			return { code: code as number | null, stdout, stderr };
		});
		return { child, done };
	}
	const stopped = () =>
		waitFor(
			() =>
				readTrace()
					.filter((item) => item.message.method === "started")
					.every((item) =>
						[item.pid, item.launcherPid, item.ownerPid].every(
							(pid) => !isRunning(pid),
						),
					),
			10000,
		);
	t.after(async () => {
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGTERM");
		for (const { pid } of readTrace().filter(
			(item) => item.message.method === "started",
		)) {
			if (!isRunning(pid)) continue;
			try {
				process.kill(pid, "SIGTERM");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		await stopped();
		// acpx has no scoped prune command. Remove only this fixture's records.
		const directory = join(homedir(), ".acpx", "sessions");
		const files = await readdir(directory).catch(() => [] as string[]);
		for (const id of records) {
			const file = `${id}.json`;
			const record = JSON.parse(await readFile(join(directory, file), "utf8"));
			if (record.cwd !== cwd || record.agent_command !== command) continue;
			for (const name of files)
				if (name === file || name.startsWith(`${id}.stream.`))
					await rm(join(directory, name), { force: true });
		}
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		cwd,
		sessions,
		readTrace,
		start,
		stopped,
		async run(args: string[], env?: NodeJS.ProcessEnv) {
			return await start(args, env).done;
		},
		async create(name = "acceptance", id?: string, env?: NodeJS.ProcessEnv) {
			const result = await start(
				[
					"sessions",
					"new",
					"--name",
					name,
					...(id ? ["--resume-session", id] : []),
				],
				env,
			).done;
			assert.equal(result.code, 0, result.stdout + result.stderr);
			await stopped();
			const created = result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.findLast((row) => row.action === "session_ensured")?.acpxSessionId;
			assert.equal(typeof created, "string");
			if (id) assert.equal(created, id);
			return created as string;
		},
		async prompt(text: string, name = "acceptance") {
			const result = await start(["prompt", "--session", name, text]).done;
			assert.equal(result.code, 0, result.stdout + result.stderr);
			await stopped();
			return result;
		},
	};
}

function isRunning(pid: number) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return !/^\d+ \(.*\) Z /.test(stat);
	} catch {
		return false;
	}
}

export function acpxUpdates(trace: AcpxTrace[]) {
	return trace.flatMap((item) =>
		item.direction === "server" && item.message.params?.update
			? [item.message.params.update]
			: [],
	);
}

export function assertAcpxLoad(
	trace: AcpxTrace[],
	sessionId: string,
	{ allowLiveUpdates = false } = {},
) {
	assert.ok(
		!trace.some((item) =>
			["session/resume", "session/new"].includes(item.message.method ?? ""),
		),
		"Load must have no resume/new fallback",
	);
	const loads = trace.flatMap((item, index) =>
		item.direction === "client" && item.message.method === "session/load"
			? [index]
			: [],
	);
	assert.ok(loads.length > 0);
	const snapshots = loads.map((load) =>
		assertLoadResponse(trace, load, sessionId, allowLiveUpdates),
	);
	const first = snapshots[0];
	assert.ok(first);
	return first;
}

function assertLoadResponse(
	trace: AcpxTrace[],
	load: number,
	sessionId: string,
	allowLiveUpdates: boolean,
) {
	const request = trace[load];
	assert.ok(request);
	assert.equal(request.message.params?.sessionId, sessionId);
	const response = trace.findIndex(
		(item, index) =>
			index > load &&
			item.pid === request.pid &&
			item.direction === "server" &&
			item.message.id === request.message.id,
	);
	assert.ok(response > load);
	assert.ok(!trace[response]?.message.error);
	const prompt = trace.findIndex(
		(item, index) =>
			index > response &&
			item.pid === request.pid &&
			item.message.method === "session/prompt",
	);
	const beforePrompt = trace
		.slice(response + 1, prompt < 0 ? undefined : prompt)
		.filter((item) => item.pid === request.pid);
	if (!allowLiveUpdates)
		assert.equal(
			acpxUpdates(beforePrompt).length,
			0,
			"Idle history must finish before the load response",
		);
	return {
		response,
		history: acpxUpdates(
			trace
				.slice(load + 1, response)
				.filter((item) => item.pid === request.pid),
		),
	};
}
