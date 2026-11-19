import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

export interface ResourcePaths {
	readonly instructionsPath?: string;
	readonly skillsDir?: string;
}

interface Skill {
	readonly disabled: boolean;
	readonly name: string;
	readonly description: string;
	readonly path: string;
}

export class ResourceLoadError extends Error {
	constructor(path: string, remedy: string) {
		super(
			`Could not load instruction or skill resources at ${JSON.stringify(path)}. ${remedy} Retry session creation after repair.`,
		);
	}
}

async function loadResource<T>(
	path: string,
	load: () => Promise<T>,
): Promise<T> {
	try {
		return await load();
	} catch (error) {
		if (error instanceof ResourceLoadError) throw error;
		throw new ResourceLoadError(
			path,
			"Check that the resource has the expected file/directory type and is readable.",
		);
	}
}

async function loadOptional<T>(load: () => Promise<T>): Promise<T | undefined> {
	try {
		return await load();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function findAncestors(cwd: string): Promise<string[]> {
	const paths: string[] = [];
	let current = await realpath(cwd);
	const home = (await loadOptional(() => realpath(homedir()))) ?? homedir();
	for (;;) {
		// Home resources are selected only through explicit global configuration.
		if (current === home) return paths;
		paths.unshift(current);
		const parent = dirname(current);
		if (
			parent === current ||
			(await loadOptional(() => stat(join(current, ".git"))))
		)
			return paths;
		current = parent;
	}
}

function validateSkillMetadata(source: string, path: string): Skill {
	const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
		source,
	);
	if (!frontmatter) throw new Error("Skill requires YAML front matter.");
	const data: unknown = parse(frontmatter[1] ?? "");
	if (!data || typeof data !== "object")
		throw new Error("Skill metadata must be a mapping.");
	const { name, description } = data as Record<string, unknown>;
	if (
		typeof name !== "string" ||
		name.length > 64 ||
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
		typeof description !== "string" ||
		!description.trim() ||
		description.length > 1024
	)
		throw new Error("Invalid skill name or description.");
	return {
		name,
		description: description.trim(),
		path,
		disabled:
			(data as Record<string, unknown>)["disable-model-invocation"] === true,
	};
}

function parseSkillMetadata(source: string, path: string): Skill {
	try {
		return validateSkillMetadata(source, path);
	} catch {
		// Parser diagnostics can contain instruction text; expose only fixed guidance.
		throw new ResourceLoadError(
			path,
			"Check YAML front matter: use a lowercase hyphen-separated name (up to 64 characters) and a nonempty description (up to 1024 characters).",
		);
	}
}

async function discoverSkills(root: string): Promise<Skill[]> {
	const visited = new Set<string>();
	const skills: Skill[] = [];
	async function visit(path: string): Promise<void> {
		await loadResource(path, () => visitDirectory(path));
	}
	async function visitDirectory(path: string): Promise<void> {
		const canonical = await loadOptional(() => realpath(path));
		if (!canonical || visited.has(canonical)) return;
		visited.add(canonical);
		const entries = await readdir(canonical, { withFileTypes: true });
		if (entries.some((entry) => entry.name === "SKILL.md")) {
			const file = join(canonical, "SKILL.md");
			skills.push(
				await loadResource(file, async () =>
					parseSkillMetadata(await readFile(file, "utf8"), file),
				),
			);
			return;
		}
		for (const entry of entries.sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		)) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			if (entry.isDirectory()) await visit(join(canonical, entry.name));
			else if (entry.isSymbolicLink()) {
				const target = join(canonical, entry.name);
				if ((await loadOptional(() => stat(target)))?.isDirectory())
					await visit(target);
			}
		}
	}
	await visit(root);
	return skills;
}

async function loadInstructions(
	paths: readonly string[],
): Promise<string | undefined> {
	const sections: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		await loadResource(path, async () => {
			const canonical = await loadOptional(() => realpath(path));
			if (!canonical || seen.has(canonical)) return;
			seen.add(canonical);
			const text = await readFile(canonical, "utf8");
			if (text.trim())
				sections.push(`## ${JSON.stringify(canonical)}\n\n${text}`);
		});
	}
	if (!sections.length) return undefined;
	return (
		"# Instructions\n\nGlobal instructions precede project instructions, ordered from project root to session cwd. More specific project instructions take precedence within their directory scope. Before working in a descendant directory, read any additional AGENTS.md files along that path.\n\n" +
		sections.join("\n\n")
	);
}

async function loadSkillCatalog(
	roots: readonly string[],
): Promise<string | undefined> {
	const skills = new Map<string, Skill>();
	for (const root of roots) {
		const local = new Set<string>();
		for (const skill of await discoverSkills(root)) {
			if (local.has(skill.name))
				throw new ResourceLoadError(
					skill.path,
					"Use unique skill names within each discovery root.",
				);
			local.add(skill.name);
			skills.set(skill.name, skill);
		}
	}
	const visible = [...skills.values()]
		.filter((skill) => !skill.disabled)
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.map(({ name, description, path }) => ({ name, description, path }));
	if (!visible.length) return undefined;
	return (
		"When a task matches a skill's description, use read to load its path before acting. Resolve relative paths in that skill against the directory containing SKILL.md. Skills are instructions, not additional tools or permission grants.\n\n" +
		JSON.stringify(visible)
	);
}

/** Snapshot trusted text resources at session creation, never Pi settings or code. */
export async function loadResources(
	cwd: string,
	paths: ResourcePaths = {},
): Promise<{ instructions?: string; skills?: string }> {
	const parents = await loadResource(cwd, () => findAncestors(cwd));
	return {
		instructions: await loadInstructions([
			...(paths.instructionsPath ? [paths.instructionsPath] : []),
			...parents.map((path) => join(path, "AGENTS.md")),
		]),
		skills: await loadSkillCatalog([
			...(paths.skillsDir ? [paths.skillsDir] : []),
			...parents.map((path) => join(path, ".agents", "skills")),
		]),
	};
}
