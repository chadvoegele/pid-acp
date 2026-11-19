import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
	mkdtemp,
	readFile,
	writeFile,
	mkdir,
	symlink,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startClient, waitFor } from "./helpers/client.ts";
import {
	readStatus,
	readToolId,
	readText,
	requireToolUpdate,
} from "./helpers/updates.ts";

async function createFileClient(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pid-files-"));
	const cwd = join(root, "session");
	await mkdir(cwd);
	const client = await startClient({
		live: true,
		cwd,
		env: {
			PID_ACP_PROVIDER_CONFIG: resolve("tests/helpers/file-provider.ts"),
			PID_ACP_MODEL: "files",
			FILE_VISION: "0",
			PID_ACP_THINKING: "off",
		},
	});
	t.after(async () => {
		try {
			await client.close();
			assert.equal(client.stderr, "");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	return { root, cwd, client };
}

async function callTool(
	client: Awaited<ReturnType<typeof startClient>>,
	name: string,
	args: Record<string, unknown>,
	failed = false,
) {
	const start = client.updates.length;
	assert.equal(
		(await client.prompt(JSON.stringify({ name, args }))).stopReason,
		"end_turn",
	);
	await client.waitForAnswer((text) => {
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	}, start);
	const updates = client.updates.slice(start);
	const tools = updates.filter((update) => readToolId(update) !== undefined);
	const id = readToolId(tools[0]);
	assert.match(id ?? "", /^file-\d+$/);
	assert.ok(tools.every((update) => readToolId(update) === id));
	const initial = requireToolUpdate(tools[0]);
	assert.equal(initial.sessionUpdate, "tool_call");
	assert.equal(initial.title, name);
	assert.equal(
		initial.kind,
		name === "read" ? "read" : name === "bash" ? "execute" : "edit",
	);
	assert.equal(
		tools.filter((update) => update.sessionUpdate === "tool_call").length,
		1,
	);
	assert.equal(
		tools.filter(
			(update) => readStatus(update) === (failed ? "failed" : "completed"),
		).length,
		1,
	);
	const lastTool = tools.at(-1);
	assert.ok(lastTool);
	const final = requireToolUpdate(lastTool);
	const providerResult = JSON.parse(updates.map(readText).join("")) as {
		content: unknown;
		isError: boolean;
		toolCallId: string;
	};
	assert.equal(providerResult.toolCallId, id);
	assert.equal(providerResult.isError, failed);
	assert.deepEqual(final.rawOutput, providerResult.content);
	assert.ok(
		updates.indexOf(final) <
			updates.findIndex(
				(update) => update.sessionUpdate === "agent_message_chunk",
			),
	);
	return {
		initial,
		final,
		text: Array.isArray(final.rawOutput)
			? final.rawOutput
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("")
			: "",
	};
}

test("native file round trips and paths preserve ACP identity and real bash behavior", {
	timeout: 30000,
}, async (t) => {
	const { root, cwd, client } = await createFileClient(t);
	assert.equal(
		client.initialize.agentCapabilities?.promptCapabilities?.image,
		false,
	);
	await callTool(client, "write", { path: "nested/file.txt", content: "old" });
	await callTool(client, "write", {
		path: "nested/file.txt",
		content: "alpha\nbeta\ngamma\n",
	});
	const bounded = await callTool(client, "read", {
		path: "nested/file.txt",
		offset: 2,
		limit: 1,
	});
	assert.deepEqual(bounded.initial.rawInput, {
		path: "nested/file.txt",
		offset: 2,
		limit: 1,
	});
	assert.ok(bounded.text.includes("beta"));
	assert.ok(!bounded.text.includes("alpha") && !bounded.text.includes("gamma"));
	const edits = [
		{ oldText: "alpha", newText: "ALPHA" },
		{ oldText: "gamma", newText: "GAMMA" },
	];
	const edited = await callTool(client, "edit", {
		path: "nested/file.txt",
		edits,
	});
	assert.deepEqual(edited.initial.rawInput, {
		path: "nested/file.txt",
		edits,
	});
	assert.equal(
		await readFile(join(cwd, "nested/file.txt"), "utf8"),
		"ALPHA\nbeta\nGAMMA\n",
	);
	assert.match(
		(await callTool(client, "read", { path: join(cwd, "nested/file.txt") }))
			.text,
		/ALPHA/,
	);
	await writeFile(join(root, "outside.txt"), "outside");
	await symlink(join(root, "outside.txt"), join(cwd, "alias"));
	for (const path of ["../outside.txt", "alias"])
		assert.match((await callTool(client, "read", { path })).text, /outside/);
	await callTool(client, "write", { path: "alias", content: "via symlink" });
	await callTool(client, "edit", {
		path: "alias",
		edits: [{ oldText: "symlink", newText: "edit" }],
	});
	assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "via edit");
	await callTool(client, "read", { path: 42 }, true);
	assert.match(
		(await callTool(client, "bash", { command: "pwd" })).text,
		new RegExp(cwd),
	);
	await callTool(client, "bash", { command: "printf failure; exit 7" }, true);
});

test("native reads preserve pagination, truncation, empty files and errors", {
	timeout: 30000,
}, async (t) => {
	const { cwd, client } = await createFileClient(t);
	await writeFile(
		join(cwd, "lines"),
		Array.from({ length: 2100 }, (_, i) => `line ${i + 1}`).join("\n"),
	);
	assert.match(
		(await callTool(client, "read", { path: "lines" })).text,
		/2000|truncat/i,
	);
	assert.match(
		(await callTool(client, "read", { path: "lines", offset: 2001, limit: 2 }))
			.text,
		/line 2001\nline 2002/,
	);
	const fractional = await callTool(client, "read", {
		path: "lines",
		offset: 2.5,
		limit: 1,
	});
	assert.ok(Array.isArray(fractional.final.rawOutput));
	assert.deepEqual(fractional.final.rawOutput[0], {
		type: "text",
		text: "line 2",
	});
	const zeroLimit = (
		await callTool(client, "read", { path: "lines", limit: 0 })
	).text;
	assert.match(zeroLimit, /offset=1/);
	assert.ok(!zeroLimit.includes("line 1\n"));
	await writeFile(
		join(cwd, "bytes"),
		Array.from({ length: 1000 }, () => "x".repeat(100)).join("\n"),
	);
	assert.match(
		(await callTool(client, "read", { path: "bytes" })).text,
		/50|truncat|showing/i,
	);
	await writeFile(join(cwd, "utf8"), "🙂".repeat(20000));
	const oversized = (await callTool(client, "read", { path: "utf8" })).text;
	assert.match(oversized, /bash/i);
	assert.ok(!oversized.includes("�"));
	await writeFile(join(cwd, "empty"), "");
	await callTool(client, "read", { path: "empty" });
	await callTool(client, "read", { path: "lines", offset: 3000 }, true);
	await callTool(client, "read", { path: "missing" }, true);
});

test("native edits preserve validation atomicity, matching, line endings and argument repair", {
	timeout: 30000,
}, async (t) => {
	const { cwd, client } = await createFileClient(t);
	for (const edits of [
		[],
		[{ oldText: "", newText: "z" }],
		[{ oldText: "absent", newText: "z" }],
		[{ oldText: "alpha", newText: "alpha" }],
		[
			{ oldText: "alpha", newText: "x" },
			{ oldText: "pha", newText: "y" },
		],
		[
			{ oldText: "alpha", newText: "x" },
			{ oldText: "missing", newText: "y" },
		],
		[
			{ oldText: "alpha", newText: "new" },
			{ oldText: "new", newText: "last" },
		],
	]) {
		await writeFile(join(cwd, "target"), "alpha\nbeta\n");
		await callTool(client, "edit", { path: "target", edits }, true);
		assert.equal(await readFile(join(cwd, "target"), "utf8"), "alpha\nbeta\n");
	}
	await writeFile(join(cwd, "target"), "same\nsame\n");
	await callTool(
		client,
		"edit",
		{ path: "target", edits: [{ oldText: "same", newText: "new" }] },
		true,
	);
	assert.equal(await readFile(join(cwd, "target"), "utf8"), "same\nsame\n");
	const ambiguous = '"quoted"\n“quoted”\n';
	await writeFile(join(cwd, "target"), ambiguous);
	await callTool(
		client,
		"edit",
		{ path: "target", edits: [{ oldText: '"quoted"', newText: "new" }] },
		true,
	);
	assert.equal(await readFile(join(cwd, "target"), "utf8"), ambiguous);
	await writeFile(
		join(cwd, "target"),
		"\ufeffkeep  \r\n“quoted”  \r\nlast\r\n",
	);
	await callTool(client, "edit", {
		path: "target",
		edits: [{ oldText: '"quoted"', newText: "changed" }],
	});
	assert.equal(
		await readFile(join(cwd, "target"), "utf8"),
		"\ufeffkeep  \r\nchanged\r\nlast\r\n",
	);
	for (const args of [
		{ oldText: "changed", newText: "next" },
		{ edits: { oldText: "next", newText: "again" } },
		{ edits: JSON.stringify([{ oldText: "again", newText: "final" }]) },
	]) {
		const result = await callTool(client, "edit", { path: "target", ...args });
		// The view exposes model arguments; repaired arguments are task-checkpoint state.
		assert.deepEqual(result.initial.rawInput, { path: "target", ...args });
	}
	await callTool(
		client,
		"edit",
		{ path: "missing", edits: [{ oldText: "x", newText: "y" }] },
		true,
	);
	await callTool(
		client,
		"edit",
		{ path: ".", edits: [{ oldText: "x", newText: "y" }] },
		true,
	);
	await callTool(client, "write", { path: ".", content: "x" }, true);
});

test("native image reads preserve content and diagnostics for text-only models", {
	timeout: 30000,
}, async (t) => {
	const { cwd, client } = await createFileClient(t);
	await writeFile(
		join(cwd, "pixel.png"),
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
			"base64",
		),
	);
	const image = await callTool(client, "read", { path: "pixel.png" });
	assert.ok(
		image.final.content?.some(
			(block) => block.type === "content" && block.content.type === "image",
		),
	);
	assert.match(image.text, /image|vision/i);
	const bmp = Buffer.alloc(58);
	bmp.write("BM");
	bmp.writeUInt32LE(58, 2);
	bmp.writeUInt32LE(54, 10);
	bmp.writeUInt16LE(1, 26);
	bmp.writeUInt16LE(24, 28);
	bmp.writeUInt32LE(40, 14);
	bmp.writeInt32LE(1, 18);
	bmp.writeInt32LE(1, 22);
	await writeFile(join(cwd, "pixel.bmp"), bmp);
	await callTool(client, "read", { path: "pixel.bmp" }, true);
	const png = await readFile(join(cwd, "pixel.png"));
	png.writeUInt32BE(3000, 16);
	await writeFile(join(cwd, "large.png"), png);
	await callTool(client, "read", { path: "large.png" }, true);
});

test("file cancellation settles and permits reads in the same session", {
	timeout: 30000,
}, async (t) => {
	const { client } = await createFileClient(t);
	const start = client.updates.length;
	const active = client.prompt(
		JSON.stringify({
			name: "write",
			args: { path: "cancelled", content: "actual" },
			block: true,
		}),
	);
	await waitFor(() =>
		client.updates
			.slice(start)
			.some(
				(update) =>
					readToolId(update) !== undefined &&
					readStatus(update) === "completed",
			),
	);
	await client.cancel();
	assert.equal((await active).stopReason, "cancelled");
	assert.match(
		(await callTool(client, "read", { path: "cancelled" })).text,
		/actual/,
	);
});
