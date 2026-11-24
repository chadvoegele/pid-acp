import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startClient } from "./helpers/client.ts";
import { readText } from "./helpers/updates.ts";

test("empty overrides disable home resources without rediscovering them as project resources", {
	timeout: 15000,
}, async () => {
	const home = await mkdtemp(join(tmpdir(), "pid-resource-disabled-"));
	const cwd = join(home, "project");
	let client: Awaited<ReturnType<typeof startClient>> | undefined;
	try {
		const badSkill = join(home, ".agents", "skills", "bad");
		await mkdir(badSkill, { recursive: true });
		await mkdir(join(home, ".agents", "AGENTS.md"));
		await writeFile(join(badSkill, "SKILL.md"), "INVALID_DISABLED_SKILL");
		await mkdir(cwd);
		client = await startClient({
			live: true,
			cwd,
			env: {
				HOME: home,
				PID_ACP_PROVIDERS: resolve("tests/helpers/native-provider.ts"),
				PID_ACP_MODEL: "faux-1",
				PID_ACP_THINKING: "off",
				PID_ACP_INSTRUCTIONS: "",
				PID_ACP_SKILLS_DIR: "",
			},
		});
		assert.equal((await client.prompt("Hello")).stopReason, "end_turn");
		assert.equal(client.stderr, "");
	} finally {
		await client?.close();
		await rm(home, { recursive: true, force: true });
	}
});

for (const defaults of [true, false]) {
	test(`production ${defaults ? "canonical paths" : "path overrides"} snapshot instructions and load skills by native read over ACP`, {
		timeout: 15000,
	}, async () => {
		const root = await mkdtemp(join(tmpdir(), "pid-resource-acp-"));
		const cwd = join(root, "project");
		const agent = join(root, defaults ? ".agents" : "custom");
		const instructionsPath = join(agent, defaults ? "AGENTS.md" : "rules.md");
		const skillsDir = join(agent, defaults ? "skills" : "custom-skills");
		const skills = join(skillsDir, "fixture");
		const skillPath = join(skills, "SKILL.md");
		let client: Awaited<ReturnType<typeof startClient>> | undefined;
		try {
			await mkdir(skills, { recursive: true });
			await mkdir(cwd);
			if (!defaults) {
				const excluded = join(root, ".agents", "skills", "excluded");
				await mkdir(excluded, { recursive: true });
				await writeFile(join(excluded, "SKILL.md"), "INVALID_DEFAULT_SKILL");
				await writeFile(
					join(root, ".agents", "AGENTS.md"),
					"EXCLUDED_DEFAULT_INSTRUCTIONS",
				);
			}
			await writeFile(instructionsPath, "GLOBAL_RESOURCE_MARKER");
			await writeFile(join(cwd, "AGENTS.md"), "PROJECT_RESOURCE_MARKER");
			// Failure to create a session must not occupy the one-session slot.
			await writeFile(skillPath, "INVALID_METADATA_SECRET");
			client = await startClient({
				live: true,
				env: {
					PID_ACP_PROVIDERS: resolve("tests/helpers/resources-provider.ts"),
					PID_ACP_MODEL: "faux-1",
					PID_ACP_THINKING: "off",
					HOME: root,
					PID_ACP_INSTRUCTIONS: defaults ? undefined : instructionsPath,
					PID_ACP_SKILLS_DIR: defaults ? undefined : skillsDir,
					PID_TEST_SKILL_PATH: skillPath,
				},
			});
			await assert.rejects(
				client.request("session/new", { cwd, mcpServers: [] }),
				(error: Error) =>
					error.message.includes(JSON.stringify(skillPath)) &&
					error.message.includes("Check YAML front matter") &&
					error.message.includes("Retry session creation after repair") &&
					!error.message.includes("INVALID_METADATA_SECRET"),
			);
			await writeFile(
				skillPath,
				"---\nname: fixture\ndescription: fixture skill description\n---\nLAZY_SKILL_BODY_MARKER\n",
			);
			const session = await client.request("session/new", {
				cwd,
				mcpServers: [],
			});
			await writeFile(join(cwd, "AGENTS.md"), "CHANGED_INSTRUCTIONS_MARKER");
			assert.equal(
				(await client.prompt("Use the fixture skill.", session.sessionId))
					.stopReason,
				"end_turn",
			);
			await client.waitForAnswer((text) =>
				text.includes("Skill loaded through the native read tool."),
			);
			const call = client.updates.find(
				(update) => update.sessionUpdate === "tool_call",
			);
			assert.ok(call && call.sessionUpdate === "tool_call");
			assert.equal(call.title, "read");
			assert.deepEqual(call.rawInput, { path: skillPath });
			assert.ok(
				client.updates
					.map(readText)
					.join("")
					.includes("Skill loaded through the native read tool."),
			);
			assert.equal(
				(await client.prompt("Again.", session.sessionId)).stopReason,
				"end_turn",
			);
			await client.waitForAnswer((text) =>
				text.includes("Instructions remain a session snapshot."),
			);
			assert.ok(
				client.updates
					.map(readText)
					.join("")
					.includes("Instructions remain a session snapshot."),
			);
			assert.ok(!client.stderr.includes("INVALID_METADATA_SECRET"));
		} finally {
			await client?.close();
			await rm(root, { recursive: true, force: true });
		}
	});
}
