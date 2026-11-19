import { realpath, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension, Registry } from "@earendil-works/pi-durable";

export abstract class UserExtensionError extends Error {
	protected constructor(message: string, entryIndex?: number) {
		const entry = entryIndex === undefined ? "" : ` entry ${entryIndex + 1}`;
		super(`PID_ACP_EXTENSIONS${entry} ${message}`);
		this.name = new.target.name;
	}
}

class UserExtensionResolutionError extends UserExtensionError {
	constructor(index: number) {
		super(
			"(resolution): Select a readable .js, .mjs, .ts, or .mts file, or a directory with exactly one supported index file.",
			index,
		);
	}
}

class UserExtensionImportError extends UserExtensionError {
	constructor(index: number) {
		super(
			"(import): Check the module's syntax, module type, imports, dependencies, and top-level code.",
			index,
		);
	}
}

class UserExtensionExportError extends UserExtensionError {
	constructor(index: number) {
		super(
			"(export): Default-export a Durable extension object with a nonempty string name.",
			index,
		);
	}
}

class UserExtensionRegistrationError extends UserExtensionError {
	constructor(index: number) {
		super(
			"(registration): Check the extension’s contributions against the installed Durable version.",
			index,
		);
	}
}

async function isEntryFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function resolveEntrypoint(path: string): Promise<string | undefined> {
	const suffixes = [".js", ".mjs", ".ts", ".mts"];
	const target = await realpath(path);
	const info = await stat(target);
	if (info.isFile() && suffixes.includes(extname(path))) return target;
	if (!info.isDirectory()) return undefined;

	const candidates: string[] = [];
	for (const suffix of suffixes) {
		const candidate = join(target, `index${suffix}`);
		if (await isEntryFile(candidate)) candidates.push(candidate);
	}
	return candidates.length === 1 ? candidates[0] : undefined;
}

function isNamedExtension(value: unknown): value is Extension {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const { name } = value as { name?: unknown };
	return typeof name === "string" && name.trim().length > 0;
}

async function loadExtension(path: string, index: number): Promise<Extension> {
	const entrypoint = await resolveEntrypoint(path).catch(() => undefined);
	if (!entrypoint) throw new UserExtensionResolutionError(index);

	let module: { default?: unknown };
	try {
		module = await import(pathToFileURL(entrypoint).href);
	} catch {
		throw new UserExtensionImportError(index);
	}

	try {
		const extension = module.default;
		if (isNamedExtension(extension)) return extension;
	} catch {
		// Accessing the export's name can execute user code.
	}
	throw new UserExtensionExportError(index);
}

export async function loadUserExtensions(
	paths: readonly string[],
): Promise<Extension[]> {
	const extensions: Extension[] = [];
	for (const [index, path] of paths.entries())
		extensions.push(await loadExtension(path, index));
	return extensions;
}

export async function installUserExtensions(
	registry: Registry,
	paths: readonly string[],
): Promise<void> {
	const extensions = await loadUserExtensions(paths);
	for (const [index, extension] of extensions.entries()) {
		try {
			registry.install(extension);
		} catch {
			throw new UserExtensionRegistrationError(index);
		}
	}
}
