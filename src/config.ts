import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createModels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models, Provider } from "@earendil-works/pi-ai/models";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { McpConfigPath } from "./mcp-config.js";
import { withCodexOverloadMessage } from "./provider-errors.js";
import type { ResourcePaths } from "./resources.js";
import { UserExtensionError } from "./user-extensions.js";

export interface Config {
	readonly providerPaths: readonly string[];
	readonly providerId: string | undefined;
	readonly modelId: string;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly resources: ResourcePaths;
	readonly sessionsDir?: string;
	readonly socketPath?: string;
	readonly mcpConfig: McpConfigPath | undefined;
	readonly extensionPaths: readonly string[];
}

export class SocketConfigurationError extends Error {}

export class ModelConfigurationError extends Error {}

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
	const providerPaths = parseProviderPaths(env.PID_ACP_PROVIDERS);
	if (!env.PID_ACP_MODEL?.trim())
		throw new ModelConfigurationError(
			"Set PID_ACP_MODEL to a literal chat model ID.",
		);
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
		providerPaths,
		providerId: env.PID_ACP_PROVIDER,
		modelId: env.PID_ACP_MODEL,
		thinkingLevel,
	};
}

function parseProviderPaths(value: string | undefined): readonly string[] {
	let paths: unknown;
	if (value && isAbsolute(value)) paths = [value];
	else if (value) {
		try {
			paths = JSON.parse(value);
		} catch {
			// Invalid JSON is handled by the same diagnostic as other invalid input.
		}
	}
	if (!Array.isArray(paths) || paths.length === 0)
		throw new ModelConfigurationError(
			"Set PID_ACP_PROVIDERS to an absolute provider module path or a nonempty JSON array of absolute paths.",
		);
	return paths.map((path: unknown, index) => {
		if (typeof path !== "string" || !isAbsolute(path))
			throw new ModelConfigurationError(
				`PID_ACP_PROVIDERS entry ${index + 1}: Use an absolute provider module path.`,
			);
		return path;
	});
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

export async function configureModels({
	providerPaths,
	providerId,
	modelId,
}: Config) {
	const models = createModels();
	models.streamSimple = withCodexOverloadMessage(
		models.streamSimple.bind(models),
	);
	// Provider modules are trusted executable code selected by the operator.
	for (const [index, path] of providerPaths.entries()) {
		try {
			const { default: provider } = (await import(
				pathToFileURL(path).href
			)) as {
				default: Provider;
			};
			models.setProvider(provider);
		} catch {
			throw new ModelConfigurationError(
				`PID_ACP_PROVIDERS entry ${index + 1}: Could not load or register provider. Check that the module exists, loads successfully, and default-exports a Pi AI Provider.`,
			);
		}
	}

	return { models, model: resolveDefaultModel(models, providerId, modelId) };
}

function resolveDefaultModel(
	models: Models,
	providerId: string | undefined,
	modelId: string,
) {
	const providers = models.getProviders();
	const provider =
		providerId ?? (providers.length === 1 ? providers[0]?.id : undefined);
	if (provider === undefined)
		throw new ModelConfigurationError(
			"Set PID_ACP_PROVIDER to a registered provider ID when more than one provider is registered.",
		);
	if (!models.getProvider(provider))
		throw new ModelConfigurationError(
			"PID_ACP_PROVIDER is not registered. Set it to the ID of a provider loaded by PID_ACP_PROVIDERS.",
		);
	if (!models.getModel(provider, modelId))
		throw new ModelConfigurationError(
			"PID_ACP_MODEL is not registered by the selected provider. Set it to a literal chat model ID from that provider.",
		);
	return { provider, modelId };
}
