import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadResources } from "../dist/resources.js";

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "pid-resources-"));
	const cwd = join(root, "project", "nested");
	const agent = join(root, "agent");
	const paths = {
		instructionsPath: join(agent, "AGENTS.md"),
		skillsDir: join(agent, "skills"),
	};
	await mkdir(cwd, { recursive: true });
	await mkdir(agent);
	return {
		root,
		cwd,
		agent,
		paths,
		async put(path: string, content: string) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content);
		},
		async close() {
			await rm(root, { recursive: true, force: true });
		},
	};
}
const createSkillSource = (name: string, description: string, extra = "") =>
	`---\nname: ${name}\ndescription: ${description}\n${extra}---\nBODY_NOT_IN_CATALOG\n`;

test("resources order global and project instructions, excluding descendants and outside repositories", async () => {
	const f = await createFixture();
	try {
		await f.put(f.paths.instructionsPath, "GLOBAL_MARKER");
		await f.put(join(f.root, "AGENTS.md"), "OUTSIDE_MARKER");
		const project = dirname(f.cwd);
		await f.put(join(project, ".git"), "gitdir: /worktree-marker");
		await f.put(join(project, "AGENTS.md"), "PROJECT_MARKER");
		await f.put(join(f.cwd, "AGENTS.md"), "CWD_MARKER");
		await f.put(join(f.cwd, "child", "AGENTS.md"), "DESCENDANT_MARKER");
		const { instructions: text, skills } = await loadResources(f.cwd, f.paths);
		assert.ok(text);
		assert.equal(skills, undefined);
		assert.ok(text.indexOf("GLOBAL_MARKER") < text.indexOf("PROJECT_MARKER"));
		assert.ok(text.indexOf("PROJECT_MARKER") < text.indexOf("CWD_MARKER"));
		assert.ok(text.includes(join(f.cwd, "AGENTS.md")));
		assert.ok(!text.includes("DESCENDANT_MARKER"));
		assert.ok(!text.includes("OUTSIDE_MARKER"));
		assert.ok(
			!(await loadResources(f.cwd)).instructions?.includes("GLOBAL_MARKER"),
		);
	} finally {
		await f.close();
	}
});

test("canonical instruction links are injected only once", async () => {
	const f = await createFixture();
	try {
		await f.put(f.paths.instructionsPath, "UNIQUE_INSTRUCTION_MARKER");
		await symlink(f.paths.instructionsPath, join(f.cwd, "AGENTS.md"));
		const { instructions } = await loadResources(f.cwd, f.paths);
		assert.equal(instructions?.match(/UNIQUE_INSTRUCTION_MARKER/g)?.length, 1);
	} finally {
		await f.close();
	}
});

test("skill catalogs are sorted, lazy, YAML-aware and prefer local names", async () => {
	const f = await createFixture();
	try {
		await f.put(
			join(f.agent, "skills", "one", "SKILL.md"),
			createSkillSource("alpha", "global"),
		);
		await f.put(
			join(f.root, ".agents", "skills", "one", "SKILL.md"),
			createSkillSource("alpha", "ancestor"),
		);
		const local = join(f.cwd, ".agents", "skills", "one", "SKILL.md");
		await f.put(
			local,
			createSkillSource("alpha", ">\n  local description\n  with folded lines"),
		);
		await f.put(
			join(f.agent, "skills", "package", "two", "SKILL.md"),
			createSkillSource("beta", '"quoted: description"'),
		);
		await f.put(join(f.cwd, ".pi", "skills", "SKILL.md"), "not loaded");
		const ignored = join(f.agent, "skills", "node_modules", "SKILL.md");
		await f.put(ignored, "invalid");
		await f.put(join(f.agent, "skills", ".hidden", "SKILL.md"), "invalid");
		const { skills: text, instructions } = await loadResources(f.cwd, f.paths);
		assert.ok(text);
		assert.equal(instructions, undefined);
		assert.ok(
			text.includes('"description":"local description with folded lines"'),
		);
		assert.ok(text.includes(local));
		assert.ok(text.indexOf('"name":"alpha"') < text.indexOf('"name":"beta"'));
		assert.ok(!text.includes("BODY_NOT_IN_CATALOG"));
		for (const value of ["global", "ancestor", ignored])
			assert.ok(!text.includes(value));
	} finally {
		await f.close();
	}
});

test("skill directory links work without cycles or duplicate catalog entries", async () => {
	const f = await createFixture();
	try {
		const skills = f.paths.skillsDir;
		await f.put(
			join(skills, "real", "SKILL.md"),
			createSkillSource("linked", "linked skill"),
		);
		await symlink(skills, join(skills, "cycle"));
		await symlink(join(skills, "real"), join(skills, "alias"));
		await symlink(join(skills, "missing"), join(skills, "broken"));
		await symlink(join(skills, "real", "SKILL.md"), join(skills, "file-link"));
		const { skills: text } = await loadResources(f.cwd, f.paths);
		assert.equal(text?.match(/"name":"linked"/g)?.length, 1);
	} finally {
		await f.close();
	}
});

test("disable-model-invocation hides skills, including an overridden global skill", async () => {
	const f = await createFixture();
	try {
		await f.put(
			join(f.agent, "skills", "one", "SKILL.md"),
			createSkillSource("hidden", "global"),
		);
		await f.put(
			join(f.cwd, ".agents", "skills", "one", "SKILL.md"),
			createSkillSource("hidden", "local", "disable-model-invocation: true\n"),
		);
		assert.equal((await loadResources(f.cwd, f.paths)).skills, undefined);
	} finally {
		await f.close();
	}
});

test("invalid or duplicate skill metadata fails without exposing contents", async () => {
	const f = await createFixture();
	try {
		const path = join(f.agent, "skills", "one", "SKILL.md");
		for (const contents of [
			"SECRET_VALUE",
			"---\nname: [SECRET_VALUE\n---\n",
			"---\nname: Uppercase\ndescription: SECRET_VALUE\n---\n",
			"---\nname: okay\ndescription: 123\n---\n",
			"---\nname: okay\ndescription: ''\n---\n",
		]) {
			await f.put(path, contents);
			await assert.rejects(loadResources(f.cwd, f.paths), {
				message: `Could not load instruction or skill resources at ${JSON.stringify(path)}. Check YAML front matter: use a lowercase hyphen-separated name (up to 64 characters) and a nonempty description (up to 1024 characters). Retry session creation after repair.`,
			});
		}
		await f.put(path, createSkillSource("same", "one"));
		await f.put(
			join(f.agent, "skills", "two", "SKILL.md"),
			createSkillSource("same", "two"),
		);
		await assert.rejects(
			loadResources(f.cwd, f.paths),
			/Use unique skill names/,
		);
	} finally {
		await f.close();
	}
});

test("missing resources are optional, filesystem errors are not", async () => {
	const f = await createFixture();
	try {
		assert.deepEqual(await loadResources(f.cwd, f.paths), {
			instructions: undefined,
			skills: undefined,
		});
		await f.put(f.paths.skillsDir, "not a directory");
		await assert.rejects(loadResources(f.cwd, f.paths), {
			message: `Could not load instruction or skill resources at ${JSON.stringify(f.paths.skillsDir)}. Check that the resource has the expected file/directory type and is readable. Retry session creation after repair.`,
		});
		await rm(f.paths.skillsDir);
		await mkdir(join(f.cwd, "AGENTS.md"));
		await assert.rejects(loadResources(f.cwd), /Could not load/);
	} finally {
		await f.close();
	}
});
