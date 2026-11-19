import assert from "node:assert/strict";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ToolCall } from "@earendil-works/pi-ai";
import { persistenceFixture } from "./helpers/persistence.ts";
import type { TodoRequest } from "./helpers/todo-provider.ts";
import { readToolId } from "./helpers/updates.ts";

type Call = { name: string; args: ToolCall["arguments"] };

async function stageTodoPackage(root: string) {
	const directory = join(root, "external-todo");
	await cp(new URL("./fixtures/external-todo/", import.meta.url), directory, {
		recursive: true,
	});
	const { dependencies } = JSON.parse(
		await readFile(join(directory, "package.json"), "utf8"),
	) as { dependencies: Record<string, string> };
	for (const [name, version] of Object.entries(dependencies)) {
		// Reuse the locked install without a network request or a custom resolver.
		const source = fileURLToPath(
			new URL(`../node_modules/${name}`, import.meta.url),
		);
		const installed = JSON.parse(
			await readFile(join(source, "package.json"), "utf8"),
		);
		assert.equal(installed.version, version, `Fixture dependency ${name}`);
		const target = join(directory, "node_modules", name);
		await mkdir(dirname(target), { recursive: true });
		await symlink(source, target, "dir");
	}
	return directory;
}

async function startHost(
	fixture: Awaited<ReturnType<typeof persistenceFixture>>,
	phase: string,
	extensionPaths: string[],
) {
	const log = join(fixture.root, `${phase}.jsonl`);
	const client = await fixture.client({
		PID_ACP_EXTENSIONS: JSON.stringify(extensionPaths),
		PID_ACP_PROVIDER_CONFIG: fileURLToPath(
			new URL("./helpers/todo-provider.ts", import.meta.url),
		),
		PID_TEST_TODO_REQUEST_LOG: log,
	});
	let seen = 0;
	return {
		client,
		async prompt(sessionId: string, call: Call | null = null) {
			const start = client.updates.length;
			assert.equal(
				(await client.prompt(JSON.stringify(call), sessionId)).stopReason,
				"end_turn",
			);
			await client.waitForAnswer(
				(text) => text === "Fixture turn complete.",
				start,
			);
			const requests = (await readFile(log, "utf8"))
				.trimEnd()
				.split("\n")
				.slice(seen)
				.map((line) => JSON.parse(line) as TodoRequest);
			seen += requests.length;
			assert.equal(requests.length, call ? 2 : 1);
			assert.equal(requests[0].result, undefined);
			const tools = client.updates
				.slice(start)
				.filter((update) => readToolId(update));
			if (!call) {
				assert.deepEqual(tools, []);
				return requests[0];
			}
			const result = requests[1].result;
			assert.ok(result);
			assert.equal(result.toolName, call.name);
			assert.equal(result.isError, false, JSON.stringify(result.content));
			assert.deepEqual(tools, [
				{
					sessionUpdate: "tool_call",
					toolCallId: result.toolCallId,
					title: call.name,
					kind: call.name === "read" ? "read" : "other",
					status: "in_progress",
					rawInput: call.args,
				},
				{
					sessionUpdate: "tool_call_update",
					toolCallId: result.toolCallId,
					status: "completed",
					content: result.content.map((content) => ({
						type: "content",
						content,
					})),
					rawOutput: result.content,
				},
			]);
			return requests[1];
		},
		async close() {
			await client.close();
			assert.deepEqual(await client.exited, [0, null]);
			assert.equal(client.stderr, "");
		},
	};
}

function assertTodos(request: TodoRequest, ...items: string[]) {
	assert.equal(
		request.todos,
		items.length ? `<todos>\n${items.join("\n")}\n</todos>` : null,
	);
	assert.deepEqual(request.tools, [
		"bash",
		"read",
		"edit",
		"write",
		"codemode",
		"todo",
	]);
}

test("external todo persists per conversation over production ACP stdio", {
	timeout: 20000,
}, async (t) => {
	const fixture = await persistenceFixture(t);
	const directory = await stageTodoPackage(fixture.root);
	const workspace = { cwd: fixture.cwd, mcpServers: [] };
	const first = await startHost(fixture, "js-file", [
		join(directory, "entry.js"),
	]);
	const { sessionId: a } = await first.client.request("session/new", workspace);
	const { sessionId: b } = await first.client.request("session/new", workspace);
	const alpha = "review the build";
	const beta = "archive the notes";
	const gamma = "publish the report";

	assertTodos(await first.prompt(a));
	const direct = await first.prompt(a, { name: "todo", args: { item: alpha } });
	assert.deepEqual(direct.result?.content, [
		{ type: "text", text: `Added ${alpha}` },
	]);
	assertTodos(direct, alpha);
	assertTodos(await first.prompt(a), alpha);
	assertTodos(await first.prompt(b));
	const nested = await first.prompt(b, {
		name: "codemode",
		args: {
			code: `text(await tools.todo({ item: ${JSON.stringify(beta)} }));`,
		},
	});
	assert.ok(JSON.stringify(nested.result?.content).includes(`Added ${beta}`));
	assertTodos(nested, beta);
	assertTodos(await first.prompt(a), alpha);
	await first.close();

	const next = await startHost(fixture, "ts-directory", [directory]);
	await next.client.request("session/load", { ...workspace, sessionId: a });
	await next.client.request("session/load", { ...workspace, sessionId: b });
	assertTodos(await next.prompt(a), alpha);
	assertTodos(await next.prompt(b), beta);
	await next.prompt(a, { name: "todo", args: { item: gamma } });
	assertTodos(await next.prompt(b), beta);
	await writeFile(
		join(fixture.cwd, "built-in.txt"),
		"Native read still works.",
	);
	const readFileCall = { name: "read", args: { path: "built-in.txt" } };
	const enabledRead = await next.prompt(a, readFileCall);
	assertTodos(enabledRead, alpha, gamma);
	assert.deepEqual(enabledRead.result?.content, [
		{ type: "text", text: "Native read still works." },
	]);
	await next.close();

	const disabled = await startHost(fixture, "disabled", []);
	await disabled.client.request("session/load", { ...workspace, sessionId: a });
	const disabledRead = await disabled.prompt(a, readFileCall);
	assert.deepEqual(disabledRead.tools, [
		"bash",
		"read",
		"edit",
		"write",
		"codemode",
	]);
	assert.equal(disabledRead.todos, null);
	assert.deepEqual(disabledRead.result?.content, enabledRead.result?.content);
	await disabled.close();
});
