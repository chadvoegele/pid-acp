import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startClient, waitFor, withClientDeadline } from "./helpers/client.ts";
import { requireLiveProvider } from "./helpers/live-provider.ts";
import { summarizeLiveUpdates } from "./helpers/live-diagnostics.ts";
import { readToolId, requireToolUpdate } from "./helpers/updates.ts";

type Client = Awaited<ReturnType<typeof startClient>>;

async function writeFixtureFile(path: string, text: string) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text);
}

async function verifyRead(
	client: Client,
	cwd: string,
	path: string,
	token: string,
) {
	await waitFor(() =>
		client.updates.some(
			(u) =>
				u.sessionUpdate === "tool_call_update" &&
				u.status === "completed" &&
				JSON.stringify(u.rawOutput).includes(token),
		),
	);
	const initial = client.updates.find((update) => {
		if (update.sessionUpdate !== "tool_call" || update.title !== "read")
			return false;
		const input = update.rawInput as { path?: unknown } | undefined;
		return typeof input?.path === "string" && resolve(cwd, input.path) === path;
	});
	const observedReadPaths = client.updates.flatMap((update) =>
		update.sessionUpdate === "tool_call" && update.title === "read"
			? [(update.rawInput as { path?: unknown } | undefined)?.path]
			: [],
	);
	assert.ok(
		initial,
		`Model must discover and read the resource's catalog path; observed read paths: ${JSON.stringify(observedReadPaths)}`,
	);
	const call = requireToolUpdate(initial);
	assert.equal(call.kind, "read");
	assert.equal(call.status, "in_progress");
	assert.ok(call.toolCallId);
	const terminal = client.updates.find(
		(update) =>
			update.sessionUpdate === "tool_call_update" &&
			readToolId(update) === call.toolCallId &&
			update.status === "completed",
	);
	assert.ok(terminal, "Native read must complete with the same ACP ID.");
	assert.ok(client.updates.indexOf(terminal) > client.updates.indexOf(initial));
	const result = requireToolUpdate(terminal);
	assert.ok(Array.isArray(result.rawOutput));
	assert.ok(
		result.rawOutput.some(
			(block) => block.type === "text" && block.text.includes(token),
		),
		"Native read must return the hidden body/support marker.",
	);
	assert.deepEqual(
		result.content,
		result.rawOutput.map((content) => ({ type: "content", content })),
	);
	const terminalIndex = client.wire.findIndex(
		(message) =>
			message.params?.update?.sessionUpdate === "tool_call_update" &&
			readToolId(message.params.update) === call.toolCallId &&
			message.params.update.status === "completed",
	);
	assert.ok(terminalIndex >= 0);
	assert.ok(
		terminalIndex >
			client.wire.findIndex(
				(message) =>
					message.params?.update?.sessionUpdate === "tool_call" &&
					readToolId(message.params.update) === call.toolCallId,
			),
		"Read completion must follow its announcement independently of the response.",
	);
	return call.toolCallId;
}

async function runScenario(mode: "defaults" | "instructions" | "skills") {
	const started = Date.now();
	const root = await mkdtemp(join(tmpdir(), "pid-acp-live-resources-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	const instructionsPath = join(
		home,
		mode === "instructions" ? "custom/rules.md" : ".agents/AGENTS.md",
	);
	const skillsDir = join(
		home,
		mode === "skills" ? "custom/skills" : ".agents/skills",
	);
	const globalSkill = join(skillsDir, "global", "SKILL.md");
	const projectSkill = join(cwd, ".agents/skills/project/SKILL.md");
	const supportPath = join(dirname(globalSkill), "support.txt");
	const receiptToken = () => randomUUID().replaceAll("-", "").slice(0, 12);
	const tokens = {
		"global-instruction.txt": receiptToken(),
		"project-instruction.txt": receiptToken(),
		"global-skill.txt": receiptToken(),
		"project-skill.txt": receiptToken(),
		"global-support.txt": receiptToken(),
	};
	let client: Client | undefined;
	try {
		await writeFixtureFile(
			join(cwd, ".git"),
			"gitdir: /disposable-live-fixture\n",
		);
		await writeFixtureFile(
			instructionsPath,
			`For receipt requests, use native write to create global-instruction.txt in the session cwd containing the single line ${tokens["global-instruction.txt"]}.\n`,
		);
		await writeFixtureFile(
			join(cwd, "AGENTS.md"),
			`For receipt requests, also use native write to create project-instruction.txt in the session cwd containing the single line ${tokens["project-instruction.txt"]}.\n`,
		);
		await writeFixtureFile(
			globalSkill,
			`---\nname: global-receipt-${randomUUID()}\ndescription: Use when asked to prepare a global receipt.\n---\nUse native write to create global-skill.txt in the session cwd containing the single line ${tokens["global-skill.txt"]}. Read support.txt using native read: take the exact path you used to read this SKILL.md and replace its final SKILL.md with support.txt. Do not guess or abbreviate the directory name. Then copy the returned contents exactly using native write to global-support.txt in the session cwd.\n`,
		);
		await writeFixtureFile(supportPath, tokens["global-support.txt"]);
		await writeFixtureFile(
			projectSkill,
			`---\nname: project-receipt-${randomUUID()}\ndescription: Use when asked to prepare a project receipt.\n---\nUse native write to create project-skill.txt in the session cwd containing the single line ${tokens["project-skill.txt"]}.\n`,
		);
		if (mode === "instructions")
			await writeFixtureFile(
				join(home, ".agents/AGENTS.md"),
				"For receipt requests, write unexpected-default.txt in the session cwd.\n",
			);
		if (mode === "skills")
			await writeFixtureFile(
				join(home, ".agents/skills/excluded/SKILL.md"),
				"INVALID_EXCLUDED_DEFAULT_METADATA\n",
			);
		client = await startClient({
			live: true,
			inheritPidAcpEnv: true,
			cwd,
			env: {
				HOME: home,
				PID_ACP_INSTRUCTIONS:
					mode === "instructions" ? instructionsPath : undefined,
				PID_ACP_SKILLS_DIR: mode === "skills" ? skillsDir : undefined,
			},
		});
		const activeClient = client;
		assert.equal(
			(
				await withClientDeadline(
					() => activeClient.child.kill("SIGKILL"),
					`Live resources ${mode} prompt`,
					90000,
					() =>
						activeClient.prompt(
							"Prepare a global receipt and a project receipt using the matching available skills. Follow both global and project session instructions. Create all five files in the session cwd: global-instruction.txt, project-instruction.txt, global-skill.txt, project-skill.txt and global-support.txt. Obtain their exact contents only from the session instructions, matching SKILL.md files and supporting resources; do not invent values. Use native read to load each matching SKILL.md and its supporting resources, and native write for all five receipts. Keep all work in the fixture workspace and do not inspect unrelated files or the environment. Report completion only after all five writes succeed.",
						),
				)
			).stopReason,
			"end_turn",
		);
		for (const [file, token] of Object.entries(tokens))
			assert.equal((await readFile(join(cwd, file), "utf8")).trimEnd(), token);
		await assert.rejects(readFile(join(cwd, "unexpected-default.txt")), {
			code: "ENOENT",
		});
		const ids = await Promise.all([
			verifyRead(client, cwd, globalSkill, tokens["global-skill.txt"]),
			verifyRead(client, cwd, projectSkill, tokens["project-skill.txt"]),
			verifyRead(client, cwd, supportPath, tokens["global-support.txt"]),
		]);
		await client.waitForAnswer((text) => text.trim().length > 0);
		assert.equal(new Set(ids).size, ids.length);
		const calls = client.updates.filter(
			(update) => update.sessionUpdate === "tool_call",
		);
		const shellCommands = calls
			.filter((call) => call.title === "bash")
			.map((call) => {
				const input = call.rawInput as { command?: unknown } | undefined;
				return typeof input?.command === "string"
					? input.command.trim().split(/\s+/)[0]
					: "unknown";
			});
		await client.close();
		assert.equal(client.stderr, "");
		return {
			mode,
			filesVerified: Object.keys(tokens).length,
			nativeReadsVerified: ids.length,
			orderedEventualReadLifecycle: true,
			nativeWriteCalls: calls.filter((call) => call.title === "write").length,
			shellCommandNames: shellCommands,
			durationMs: Date.now() - started,
		};
	} catch (error) {
		process.stderr.write(
			`${JSON.stringify({ author: "Chad's Agent", mode, durationMs: Date.now() - started, passed: false, updates: client && summarizeLiveUpdates(client.updates, [root]) }).slice(0, 65536)}\n`,
		);
		throw error;
	} finally {
		try {
			await client?.close();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}

const evidence = await requireLiveProvider();
const checks = [];
for (const mode of ["defaults", "instructions", "skills"] as const) {
	const result = await runScenario(mode);
	checks.push(result);
	process.stdout.write(
		`${JSON.stringify({ author: "Chad's Agent", ...result, cleanedUp: true })}\n`,
	);
}
process.stdout.write(
	`${JSON.stringify({ author: "Chad's Agent", ...evidence, checks, passed: true, cleanedUp: true }, null, 2)}\n`,
);
