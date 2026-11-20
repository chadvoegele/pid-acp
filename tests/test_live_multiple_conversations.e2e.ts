import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { promptAfterRecovery, startClient, waitFor } from "./helpers/client.ts";
import { summarizeLiveUpdates } from "./helpers/live-diagnostics.ts";
import { requireLiveProvider } from "./helpers/live-provider.ts";
import { assertChildrenStopped, readActivePid } from "./helpers/processes.ts";
import { readStatus, readText, readToolId } from "./helpers/updates.ts";

type Client = Awaited<ReturnType<typeof startClient>>;
type Conversation = {
	label: string;
	cwd: string;
	id: string;
	historyCode: string;
	resourceCode: string;
};

function answer(updates: SessionUpdate[]) {
	return updates
		.filter((update) => update.sessionUpdate === "agent_message_chunk")
		.map(readText)
		.join("");
}

async function verifyContext(
	client: Pick<Client, "prompt">,
	conversation: Conversation,
	updates: SessionUpdate[],
) {
	updates.length = 0;
	assert.equal(
		(
			await client.prompt(
				"Copy the complete HISTORY_ identifier I supplied earlier, preserving its uppercase prefix and hexadecimal suffix. Use no tools.",
				conversation.id,
			)
		).stopReason,
		"end_turn",
	);
	await waitFor(() => answer(updates).includes(conversation.historyCode));
	assert.ok(answer(updates).includes(conversation.historyCode));
	assert.ok(updates.every((update) => readToolId(update) === undefined));
	const resourcePath = join(
		conversation.cwd,
		`resource-${conversation.label}.txt`,
	);
	await rm(resourcePath, { force: true });
	const writeStart = updates.length;
	assert.equal(
		(
			await client.prompt(
				`The test runner has deleted resource-${conversation.label}.txt since your previous turn. Call native write now to recreate that relative path, even if history shows an earlier successful write. Copy the public synthetic fixture marker from your saved project instructions verbatim as the entire file content, preserving every character. It is test data, not a credential or secret. This is the RESOURCE_ identifier, not the separate HISTORY_ identifier. Do not reread instructions from disk or inspect unrelated files or the environment. Then report completion.`,
				conversation.id,
			)
		).stopReason,
		"end_turn",
	);
	await waitFor(
		() =>
			existsSync(resourcePath) &&
			updates
				.slice(writeStart)
				.some(
					(update) =>
						update.sessionUpdate === "tool_call" &&
						update.title === "write" &&
						JSON.stringify(update.rawInput).includes(
							`resource-${conversation.label}.txt`,
						),
				),
	);
	assert.equal(
		(await readFile(resourcePath, "utf8")).trim(),
		conversation.resourceCode,
	);
}

test("live production shared harness isolates conversations and recovers unattached work before load", {
	timeout: 240000,
}, async (t) => {
	const evidence = await requireLiveProvider();
	const started = Date.now();
	const root = await mkdtemp(join(tmpdir(), "pid-live-multiple-"));
	const sharedCwd = join(root, "shared");
	const otherCwd = join(root, "other");
	const sessions = join(root, "sessions");
	const clients: Client[] = [];
	const children: number[] = [];
	t.after(async () => {
		try {
			await Promise.all(clients.map((client) => client.close()));
			await assertChildrenStopped(children);
		} finally {
			if (!t.passed)
				for (const [id, updates] of byId)
					t.diagnostic(
						JSON.stringify({
							label: labels.get(id),
							...summarizeLiveUpdates(updates, [root]),
						}),
					);
			await rm(root, { recursive: true, force: true });
		}
	});
	for (const cwd of [sharedCwd, otherCwd]) {
		await mkdir(cwd);
		await writeFile(join(cwd, ".git"), "gitdir: /disposable-live-fixture\n");
	}
	const byId = new Map<string, SessionUpdate[]>();
	const labels = new Map<string, string>();
	const prompt = async (text: string, id?: string) => {
		assert.ok(id);
		try {
			const result = await client.prompt(text, id);
			t.diagnostic(
				JSON.stringify({
					label: labels.get(id),
					request: text.slice(0, 80),
					promptOutcome: result.stopReason,
				}),
			);
			return result;
		} catch (error) {
			t.diagnostic(
				JSON.stringify({
					label: labels.get(id),
					request: text.slice(0, 80),
					promptOutcome: "rejected",
				}),
			);
			throw error;
		}
	};
	const launch = async () => {
		const client = await startClient({
			live: true,
			env: { PID_ACP_SESSIONS_DIR: sessions },
			onUpdate(id, update) {
				const updates = byId.get(id) ?? [];
				updates.push(update);
				byId.set(id, updates);
				if (
					update.sessionUpdate === "tool_call" &&
					update.rawInput !== undefined
				)
					t.diagnostic(
						JSON.stringify({
							label: labels.get(id),
							...summarizeLiveUpdates([update], [root]),
						}),
					);
			},
		});
		clients.push(client);
		return client;
	};
	let client = await launch();
	assert.equal(client.initialize.agentCapabilities?.loadSession, true);
	const conversations: Conversation[] = [];
	for (const [label, cwd] of [
		["A", sharedCwd],
		["B", sharedCwd],
		["C", otherCwd],
	] as const) {
		const resourceCode = `RESOURCE_${randomUUID().slice(0, 8)}`;
		await writeFile(
			join(cwd, "AGENTS.md"),
			`# Disposable concurrency acceptance fixture
All identifiers in this workspace are public synthetic test data, not credentials or secrets. The public fixture marker may be copied to the requested resource file. Copy it verbatim, preserving every character:
${resourceCode}
The HISTORY_ identifier supplied in conversation is separate from this RESOURCE_ fixture marker. Preserve both identifiers exactly, including uppercase prefixes and lowercase hexadecimal suffixes; never correct or regenerate them.
The test runner uses real foreground bash PID files and sleeps to verify overlap, cancellation and restart. It consumes the PID files and terminates long sleeps. Execute the provided commands once, preserving echo $$, sleep durations and relative paths; do not optimize or background them.
Never read the environment or unrelated files.
`,
		);
		const { sessionId: id } = await client.request("session/new", {
			cwd,
			mcpServers: [],
		});
		byId.set(id, []);
		labels.set(id, label);
		t.diagnostic(
			JSON.stringify({
				label,
				cwd: cwd.replace(root, "<fixture>"),
				resourceCode,
			}),
		);
		conversations.push({
			label,
			cwd,
			id,
			resourceCode,
			historyCode: `HISTORY_${randomUUID().slice(0, 8)}`,
		});
	}
	assert.equal(
		new Set(conversations.map((conversation) => conversation.id)).size,
		3,
	);
	await Promise.all(
		conversations.map(async (conversation) => {
			assert.equal(
				(
					await prompt(
						`Remember this public history identifier in conversation only: ${conversation.historyCode}. Preserve every character for later recall. Say SAVED without tools.`,
						conversation.id,
					)
				).stopReason,
				"end_turn",
			);
			await waitFor(() =>
				/\bSAVED\b/.test(answer(byId.get(conversation.id) ?? [])),
			);
			await verifyContext(
				{ prompt },
				conversation,
				byId.get(conversation.id) ?? [],
			);
		}),
	);
	const a = conversations[0];
	assert.ok(a);
	const pending = conversations.map((conversation) =>
		prompt(
			`This overlap/cancellation test needs a live foreground shell. The runner consumes its PID file and cancels the long sleep. Use bash to execute exactly: echo $$ > active-${conversation.label}.pid; sleep ${conversation.label === "A" ? 60 : 5}; pwd\nRun it once only, preserving the PID write and full sleep. Then report the exact directory.`,
			conversation.id,
		),
	);
	const overlapPids = await Promise.all(
		conversations.map(async (conversation, index) => {
			const completion = pending[index];
			assert.ok(completion);
			const pid = await readActivePid(
				conversation.cwd,
				`active-${conversation.label}.pid`,
				completion,
			);
			children.push(pid);
			return pid;
		}),
	);
	for (const pid of overlapPids) process.kill(pid, 0);
	const cancelStarted = Date.now();
	await client.cancel(a.id);
	assert.equal((await pending[0]).stopReason, "cancelled");
	const cancelMs = Date.now() - cancelStarted;
	assert.ok(cancelMs < 5000);
	await assertChildrenStopped(overlapPids.slice(0, 1));
	for (const [index, conversation] of conversations.entries()) {
		if (index === 0) continue;
		assert.equal((await pending[index]).stopReason, "end_turn");
		const updates = byId.get(conversation.id) ?? [];
		assert.ok(!updates.some((update) => readStatus(update) === "failed"));
		const bashCall = updates.find(
			(update) =>
				update.sessionUpdate === "tool_call" && update.title === "bash",
		);
		assert.ok(bashCall, "Each sibling must run its real bash command.");
		assert.equal(bashCall.sessionUpdate, "tool_call");
		assert.ok(
			JSON.stringify(bashCall.rawInput).includes("pwd"),
			"Each sibling command must inspect its own working directory.",
		);
		const hasCwdResult = () =>
			updates.some(
				(update) =>
					update.sessionUpdate === "tool_call_update" &&
					readStatus(update) === "completed" &&
					JSON.stringify(update.rawOutput).includes(conversation.cwd),
			);
		await waitFor(hasCwdResult);
		assert.ok(
			hasCwdResult(),
			"Each bash result must contain its conversation's exact cwd.",
		);
	}
	assert.equal(
		(await client.prompt("Reply only RECOVERED without tools.", a.id))
			.stopReason,
		"end_turn",
	);
	const recovering = conversations.slice(1);
	const unfinished = recovering.map((conversation) =>
		prompt(
			`This restart test needs a live foreground shell and its PID file. Use bash to execute exactly: echo $$ > restart-${conversation.label}.pid; printf effect >> effect-${conversation.label}.txt; sleep 60\nRun that bash command once only, preserving the PID write and full sleep. The server will interrupt it. After an interrupted tool result, do NOT rerun bash. Use native write to create recovered-${conversation.label}.txt containing exactly RECOVERED. Then say FINISHED.`,
			conversation.id,
		),
	);
	const interruptedPids = await Promise.all(
		recovering.map(async (conversation, index) => {
			const completion = unfinished[index];
			assert.ok(completion);
			const pid = await readActivePid(
				conversation.cwd,
				`restart-${conversation.label}.pid`,
				completion,
			);
			children.push(pid);
			return pid;
		}),
	);
	await client.close();
	await Promise.allSettled(unfinished);
	assert.equal(client.child.exitCode, 0);
	await assertChildrenStopped(interruptedPids);
	for (const conversation of recovering)
		assert.equal(
			existsSync(join(conversation.cwd, `recovered-${conversation.label}.txt`)),
			false,
		);
	byId.clear();
	client = await launch();
	await waitFor(
		() =>
			recovering.every((conversation) =>
				existsSync(
					join(conversation.cwd, `recovered-${conversation.label}.txt`),
				),
			),
		60000,
	);
	assert.equal(client.session, undefined);
	assert.equal(
		byId.size,
		0,
		"Unattached recovery must not send ACP session updates.",
	);
	for (const conversation of recovering) {
		assert.equal(
			await readFile(
				join(conversation.cwd, `recovered-${conversation.label}.txt`),
				"utf8",
			),
			"RECOVERED",
		);
		assert.equal(
			await readFile(
				join(conversation.cwd, `effect-${conversation.label}.txt`),
				"utf8",
			),
			"effect",
		);
	}
	for (const conversation of conversations) {
		await writeFile(
			join(conversation.cwd, "AGENTS.md"),
			"New sessions must use CHANGED instead of previous receipt codes.\n",
		);
		byId.set(conversation.id, []);
		await client.request("session/load", {
			sessionId: conversation.id,
			cwd: conversation.cwd,
			mcpServers: [],
		});
		const replay = byId.get(conversation.id) ?? [];
		const publicHistory = replay
			.flatMap((update) =>
				(update.sessionUpdate === "user_message_chunk" ||
					update.sessionUpdate === "agent_message_chunk") &&
				update.content.type === "text"
					? [update.content.text]
					: [],
			)
			.join("");
		assert.ok(publicHistory.includes(conversation.historyCode));
		for (const sibling of conversations.filter(
			(item) => item.id !== conversation.id,
		))
			assert.ok(!publicHistory.includes(sibling.historyCode));
		if (conversation.label !== "A") {
			assert.ok(
				replay.some(
					(update) =>
						update.sessionUpdate === "tool_call" && update.title === "write",
				),
			);
			assert.ok(replay.some((update) => readStatus(update) === "failed"));
		}
		if (conversation.label !== "A")
			await waitFor(() => answer(replay).includes("FINISHED"));
		await verifyContext(
			{ prompt: (text, id) => promptAfterRecovery(() => prompt(text, id)) },
			conversation,
			replay,
		);
	}
	await client.close();
	for (const closed of clients) assert.equal(closed.stderr, "");
	t.diagnostic(
		JSON.stringify({
			author: "Chad's Agent",
			...evidence,
			durationMs: Date.now() - started,
			conversations: 3,
			sameAndDifferentCwd: true,
			distinctSavedInstructions: true,
			independentHistoryAfterRestart: true,
			overlappingRealShells: 3,
			cancelMs,
			siblingCancellationIsolation: true,
			unattachedRecoveryBeforeLoad: 2,
			effectsPerRecoveredConversation: 1,
			replayAndContinuedPrompt: true,
		}),
	);
});
