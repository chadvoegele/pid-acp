import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Runtime } from "../dist/runtime.js";
import { persistenceFixture } from "./helpers/persistence.ts";

for (const equalCwd of [false, true]) {
	test(`shared providers and real bash tools overlap with independent snapshots (equal cwd: ${equalCwd})`, {
		timeout: 5000,
	}, async (t) => {
		const f = await persistenceFixture(t);
		const aCwd = join(f.root, "a");
		const bCwd = equalCwd ? aCwd : join(f.root, "b");
		for (const cwd of new Set([aCwd, bCwd])) {
			await mkdir(join(cwd, ".git"), { recursive: true });
			await mkdir(join(cwd, ".agents", "skills", "test"), { recursive: true });
		}
		const saveResources = async (cwd: string, label: string) => {
			await writeFile(join(cwd, "AGENTS.md"), `INSTRUCTIONS_${label}`);
			await writeFile(
				join(cwd, ".agents", "skills", "test", "SKILL.md"),
				`---\nname: test\ndescription: CATALOG_${label}\n---\nLAZY_BODY_${label}`,
			);
		};
		const both = Promise.withResolvers<void>();
		let entered = 0;
		const requests: string[] = [];
		const provider = fauxProvider({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
		});
		const step: Parameters<typeof provider.setResponses>[0][number] = async (
			request,
			_options,
			_state,
			model,
		) => {
			const user = request.messages.find((message) => message.role === "user");
			assert.ok(user?.role === "user" && typeof user.content === "string");
			const label = user.content;
			const text = JSON.stringify(request);
			requests.push(label);
			assert.match(text, new RegExp(`INSTRUCTIONS_${label}`));
			assert.match(text, new RegExp(`CATALOG_${label}`));
			assert.doesNotMatch(
				text,
				new RegExp(
					`INSTRUCTIONS_${label === "A" ? "B" : "A"}|CATALOG_${label === "A" ? "B" : "A"}|LAZY_BODY`,
				),
			);
			assert.equal(model.id, label === "A" ? "faux-1" : "faux-2");
			if (++entered === 2) both.resolve();
			await both.promise;
			return fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: `printf '${label}' > ${label}.txt; touch '${join(f.root, `ready-${label}`)}'; while [ ! -e '${join(f.root, `ready-${label === "A" ? "B" : "A"}`)}' ]; do sleep 0.01; done; cat ${label}.txt`,
					},
					{ id: "REUSED_CALL_ID" },
				),
				{ stopReason: "toolUse" },
			);
		};
		provider.setResponses([
			step,
			step,
			(request) => {
				const result = request.messages.at(-1);
				assert.equal(result?.role, "toolResult");
				return fauxAssistantMessage("done");
			},
			(request) => {
				const result = request.messages.at(-1);
				assert.equal(result?.role, "toolResult");
				return fauxAssistantMessage("done");
			},
		]);
		const models = createModels();
		models.setProvider(provider.provider);
		const runtime = await Runtime.open(
			models,
			{ provider: "faux", modelId: "faux-1" },
			"off",
			{ instructionsPath: "", skillsDir: "" },
			f.sessions,
		);
		t.after(() => runtime.close());
		await saveResources(aCwd, "A");
		const a = await runtime.createSession(aCwd);
		await saveResources(bCwd, "B");
		const b = await runtime.createSession(bCwd);
		await b.conversation.configure(
			{
				model: { provider: "faux", modelId: "faux-2" },
				thinkingLevel: "medium",
			},
			context,
		);
		const submissions = await Promise.all([
			a.conversation.submit(
				{ type: "input", content: "A", whenBusy: "reject" },
				context,
			),
			b.conversation.submit(
				{ type: "input", content: "B", whenBusy: "reject" },
				context,
			),
		]);
		await both.promise;
		await assert.rejects(
			a.conversation.submit(
				{ type: "input", content: "DO_NOT_QUEUE", whenBusy: "reject" },
				context,
			),
		);
		const results = await Promise.all(
			submissions.map((submission) => submission.wait(context)),
		);
		assert.ok(results.every((result) => result.status === "done"));
		assert.deepEqual(requests.sort(), ["A", "B"]);
		assert.equal(await readFile(join(aCwd, "A.txt"), "utf8"), "A");
		assert.equal(await readFile(join(bCwd, "B.txt"), "utf8"), "B");
		for (const [session, other] of [
			[a, "B"],
			[b, "A"],
		] as const) {
			const history = await session.conversation.context(context);
			assert.ok(
				!history.messages.some(
					(message) =>
						message.role === "user" &&
						(message.content === other || message.content === "DO_NOT_QUEUE"),
				),
			);
		}
	});
}
