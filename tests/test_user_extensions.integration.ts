import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../dist/runtime.js";
import { persistenceFixture } from "./helpers/persistence.ts";

test("native tool precedence, hooks and wrappers apply to model and codemode calls", async (t) => {
	const f = await persistenceFixture(t);
	await symlink(resolve("node_modules"), join(f.root, "node_modules"), "dir");
	const first = join(f.root, "first.mjs");
	const directory = join(f.root, "second");
	await mkdir(directory);
	await writeFile(
		join(f.root, "echo.mjs"),
		`
		import { defineTool } from "@earendil-works/pi-durable";
		export function createEcho(label) {
			return defineTool({
				name: "fixture_echo",
				description: "Echo a test value",
				parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
				async execute({ value }) {
					return { output: [{ type: "text", text: label + ":" + value }] };
				},
			});
		}
	`,
	);
	await writeFile(
		first,
		`
		import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
		import { createEcho } from "./echo.mjs";
		const tool = createEcho("first");
		export default defineExtension({
			name: "user.first",
			tools: [tool],
			wraps: [wrapTool(tool, (next) => ({
				...next,
				execute: (args, api, ctx) => next.execute({ value: "wrapped:" + args.value }, api, ctx),
			}))],
		});
	`,
	);
	await writeFile(
		join(directory, "index.mts"),
		`
		import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
		import { createEcho } from "../echo.mjs";
		const label: string = "second";
		export default defineExtension({
			name: "user.second",
			tools: [createEcho(label)],
			hooks: [hook(ToolTask, {
				beforeTool(call) {
					if (call.name === "fixture_echo") return { arguments: { value: "hook:" + call.arguments.value } };
				},
			})],
		});
	`,
	);

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const runtime = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{},
		f.sessions,
		undefined,
		[first, directory],
	);
	t.after(() => runtime.close());
	const session = await runtime.createSession(f.cwd);
	const agent = await session.conversation.agent(context);
	assert.deepEqual(
		agent.tools.map(({ name }) => name),
		["bash", "read", "edit", "write", "codemode", "fixture_echo"],
	);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("fixture_echo", { value: "model" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			[
				fauxToolCall("codemode", {
					code: 'text(await tools.fixture_echo({ value: "nested" }));',
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	const submission = await session.conversation.submit(
		{ type: "input", content: "probe" },
		context,
	);
	await submission.wait(withAbortSignal(AbortSignal.timeout(5000), context));
	const results = (await session.conversation.context(context)).messages.filter(
		(message) => message.role === "toolResult",
	);
	assert.deepEqual(
		results.map(({ toolName, isError }) => [toolName, isError]),
		[
			["fixture_echo", false],
			["codemode", false],
		],
	);
	assert.match(JSON.stringify(results[0].content), /second:wrapped:hook:model/);
	assert.match(
		JSON.stringify(results[1].content),
		/second:wrapped:hook:nested/,
	);
	await session.close();
	await runtime.close();
});
