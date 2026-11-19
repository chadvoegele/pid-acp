import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { McpConfigPath } from "./mcp-config.js";
import type { ResourcePaths } from "./resources.js";
import { UserExtensionError } from "./user-extensions.js";

export interface Config {
	readonly providerConfig: string;
	readonly modelId: string;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly resources: ResourcePaths;
	readonly sessionsDir?: string;
	readonly socketPath?: string;
	readonly mcpConfig: McpConfigPath | undefined;
	readonly extensionPaths: readonly string[];
}

export class SocketConfigurationError extends Error {}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const socketPath = env.PID_ACP_SOCKET_PATH;
	if (socketPath !== undefined && !isAbsolute(socketPath))
		throw new SocketConfigurationError(
			"Set PID_ACP_SOCKET_PATH to a nonempty absolute Unix socket path, or unset it for stdio.",
		);
	if (
		env.PID_ACP_SESSIONS_DIR !== undefined &&
		(!env.PID_ACP_SESSIONS_DIR || !isAbsolute(env.PID_ACP_SESSIONS_DIR))
	)
		throw new Error(
			"PID_ACP_SESSIONS_DIR must be a nonempty absolute directory.",
		);
	if (!env.PID_ACP_PROVIDER_CONFIG || !isAbsolute(env.PID_ACP_PROVIDER_CONFIG))
		throw new Error(
			"Set PID_ACP_PROVIDER_CONFIG to an absolute provider module path.",
		);
	if (!env.PID_ACP_MODEL?.trim()) throw new Error("Set PID_ACP_MODEL.");
	const thinkingLevel = MODEL_THINKING_LEVELS.find(
		(level) => level === (env.PID_ACP_THINKING ?? "off"),
	);
	if (!thinkingLevel)
		throw new Error(
			`PID_ACP_THINKING must be one of: ${MODEL_THINKING_LEVELS.join(", ")}.`,
		);
	const instructionsPath = resolveResourcePath(
		env.PID_ACP_INSTRUCTIONS,
		join(homedir(), ".agents", "AGENTS.md"),
		"PID_ACP_INSTRUCTIONS",
	);
	const skillsDir = resolveResourcePath(
		env.PID_ACP_SKILLS_DIR,
		join(homedir(), ".agents", "skills"),
		"PID_ACP_SKILLS_DIR",
	);
	return {
		...(env.PID_ACP_SESSIONS_DIR === undefined
			? {}
			: { sessionsDir: env.PID_ACP_SESSIONS_DIR }),
		...(socketPath === undefined ? {} : { socketPath }),
		mcpConfig: resolveMcpConfigPath(env),
		extensionPaths: parseExtensionPaths(env.PID_ACP_EXTENSIONS),
		resources: { instructionsPath, skillsDir },
		providerConfig: env.PID_ACP_PROVIDER_CONFIG,
		modelId: env.PID_ACP_MODEL,
		thinkingLevel,
	};
}

class UserExtensionConfigError extends UserExtensionError {
	constructor(index?: number) {
		super(
			"(config): Set a JSON array of absolute paths, or leave it empty to disable loading.",
			index,
		);
	}
}

function parseExtensionPaths(value: string | undefined): readonly string[] {
	if (!value) return [];
	let paths: unknown;
	try {
		paths = JSON.parse(value);
	} catch {
		throw new UserExtensionConfigError();
	}
	if (!Array.isArray(paths)) throw new UserExtensionConfigError();
	return paths.map((path: unknown, index) => {
		if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
			throw new UserExtensionConfigError(index);
		return path;
	});
}

function resolveMcpConfigPath(
	env: NodeJS.ProcessEnv,
): McpConfigPath | undefined {
	const value = env.PID_ACP_MCP_CONFIG;
	if (value === "") return undefined;
	if (value !== undefined && !isAbsolute(value))
		throw new Error(
			"PID_ACP_MCP_CONFIG must be absolute or empty to disable MCP.",
		);
	return {
		path: value ?? join(homedir(), ".pi", "agent", "mcp.json"),
		required: value !== undefined,
	};
}

function resolveResourcePath(
	value: string | undefined,
	fallback: string,
	name: string,
): string | undefined {
	const path = value ?? fallback;
	if (path && !isAbsolute(path))
		throw new Error(
			`${name} must be absolute or empty to disable the global resource.`,
		);
	return path || undefined;
}

export async function validateCwd(cwd: string): Promise<void> {
	if (!isAbsolute(cwd))
		throw new Error("cwd must be an existing absolute directory.");
	if (!(await stat(cwd).catch(() => undefined))?.isDirectory())
		throw new Error("cwd must be an existing absolute directory.");
}

export async function configureModels(config: Config) {
	// Configuration is trusted executable code, selected only by the launch environment.
	const { default: provider } = (await import(
		pathToFileURL(config.providerConfig).href
	)) as {
		default: Provider;
	};
	if (
		!provider ||
		typeof provider.id !== "string" ||
		!provider.id ||
		typeof provider.getModels !== "function" ||
		typeof provider.streamSimple !== "function"
	)
		throw new Error(
			"Provider module must default-export a Pi AI Provider with getModels() and streamSimple().",
		);
	const models = createModels();
	models.setProvider(provider);
	if (!models.getModel(provider.id, config.modelId))
		throw new Error("Configured chat model is not registered by the provider.");
	return { models, model: { provider: provider.id, modelId: config.modelId } };
}
