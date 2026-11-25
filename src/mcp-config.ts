import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	mcpNamespace,
	validateMcpServerConfig,
	type McpOAuthConfig,
	type McpServerConfigResult,
	type StdioTransportOptions,
} from "@earendil-works/pi-mcp";

export type McpConfigPath = { path: string; required: boolean };
type McpExposure = "codemode" | "hidden";
type McpConfig = { mcpServers: Record<string, Record<string, unknown>> };
type ValidatedServer = Exclude<McpServerConfigResult, { kind: "invalid" }>;
export type PublicMcpOAuth = Pick<
	McpOAuthConfig,
	"scope" | "callbackPort" | "callbackUrl"
> & { clientId: string };
export type McpServer = ValidatedServer & {
	name: string;
	config: {
		exposure: McpExposure;
		oauth?: PublicMcpOAuth;
		toolExposure?: Record<string, McpExposure>;
	};
};
export type McpConfiguration = {
	servers: McpServer[];
	issues: { server: string; message: string }[];
	oauthFile?: string;
};

export class McpConfigurationError extends Error {}

function rejectConfig(message: string): never {
	throw new McpConfigurationError(
		`MCP configuration: ${message} Correct the selected mcp.json or set PID_ACP_MCP_CONFIG empty to disable MCP.`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExposure(value: unknown) {
	if (
		value !== undefined &&
		value !== "codemode" &&
		value !== "codemode-deferred" &&
		value !== "hidden"
	)
		rejectConfig("Only codemode or hidden exposure is supported.");
}

function normalizeExposure(value: unknown): McpExposure {
	return value === "hidden" ? "hidden" : "codemode";
}

function expandValues(
	values: Record<string, string> | undefined,
	env: NodeJS.ProcessEnv,
	field: string,
) {
	if (!values) return;
	for (const [key, value] of Object.entries(values)) {
		values[key] = value.replace(
			/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
			(_match, name: string) => {
				const replacement = Object.hasOwn(env, name) ? env[name] : undefined;
				if (replacement === undefined) throw new MissingVariable(field);
				return replacement;
			},
		);
	}
}

class MissingVariable extends Error {
	constructor(field: string) {
		super(
			`Server disabled: missing launch environment variable in ${field}. Set the variable and restart.`,
		);
	}
}

async function readConfig(
	selection: McpConfigPath | undefined,
): Promise<unknown> {
	if (!selection) return { mcpServers: {} };
	let source: string;
	try {
		source = await readFile(selection.path, "utf8");
	} catch (error) {
		if (
			!selection.required &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		)
			return { mcpServers: {} };
		return rejectConfig("Could not read the selected trusted file.");
	}
	try {
		return JSON.parse(source);
	} catch {
		return rejectConfig("Expected valid JSON (parser details withheld).");
	}
}

const publicOAuthKeys = new Set([
	"clientId",
	"scope",
	"callbackPort",
	"callbackUrl",
]);

export function isSecureMcpOAuthUrl(url: URL) {
	return (
		!url.username &&
		!url.password &&
		!url.hash &&
		(url.protocol === "https:" ||
			(url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
	);
}

function validateOAuth(server: ValidatedServer) {
	if (server.config.oauth === undefined) return;
	if (
		server.kind !== "http" ||
		!isSecureMcpOAuthUrl(new URL(server.config.url))
	)
		rejectConfig(
			"OAuth requires a streamable HTTP URL over HTTPS or loopback HTTP, without userinfo or a fragment.",
		);
	const { oauth, headers } = server.config;
	if (
		Object.keys(headers ?? {}).some(
			(key) => key.trim().toLowerCase() === "authorization",
		)
	)
		rejectConfig("OAuth cannot be combined with an Authorization header.");
	if (
		!oauth.clientId?.trim() ||
		[oauth.clientId, oauth.scope].some(
			(value) =>
				value !== undefined &&
				(value.trimStart().startsWith("!") || value.includes("${")),
		) ||
		Object.keys(oauth).some((key) => !publicOAuthKeys.has(key))
	)
		rejectConfig(
			"OAuth requires a literal pre-registered public clientId; only scope, callbackPort and callbackUrl may also be set.",
		);
}

function validateServer(config: Record<string, unknown>) {
	if (
		["auth", "authProvider", "roots"].some((key) => config[key] !== undefined)
	)
		rejectConfig("Custom auth providers and configured roots are unsupported.");
	if (config.inheritEnv !== undefined && typeof config.inheritEnv !== "boolean")
		rejectConfig("inheritEnv must be a boolean when supplied.");
	validateExposure(config.exposure);
	if (config.toolExposure === undefined) return;
	if (!isRecord(config.toolExposure))
		rejectConfig(
			"toolExposure must map tool names/patterns to exposure modes.",
		);
	for (const mode of Object.values(config.toolExposure)) validateExposure(mode);
}

function validateConfig(config: unknown): asserts config is McpConfig {
	if (!isRecord(config) || !isRecord(config.mcpServers))
		rejectConfig("Expected an object containing an mcpServers object.");
	if (
		config.autoEnableCodemode !== undefined &&
		config.autoEnableCodemode !== true
	)
		rejectConfig("autoEnableCodemode must be true when supplied.");
	const namespaces = new Map<string, boolean>();
	for (const [name, raw] of Object.entries(config.mcpServers).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (isRecord(raw) && raw.enabled === false) continue;
		const checked = validateMcpServerConfig(name, raw);
		if (checked.kind === "invalid") {
			// Pinned upstream reasons are static; remove the only interpolated value.
			const prefix = `server "${name}"`;
			rejectConfig(
				checked.error.startsWith(prefix)
					? checked.error.slice(prefix.length).replace(/^:? /, "")
					: "Server names require letters, digits, underscores or dashes.",
			);
		}
		validateServer(checked.config);
		validateOAuth(checked);
		const namespace = mcpNamespace(name);
		const oauth = checked.config.oauth !== undefined;
		const previous = namespaces.get(namespace);
		if (previous !== undefined && (previous || oauth))
			rejectConfig(
				"Enabled server names cannot share a namespace when either uses OAuth.",
			);
		namespaces.set(namespace, oauth);
		const field = checked.kind === "http" ? "headers" : "env";
		const values =
			checked.kind === "http" ? checked.config.headers : checked.config.env;
		if (
			Object.values(values ?? {}).some((value) =>
				value.trimStart().startsWith("!"),
			)
		)
			rejectConfig(`${field} command helpers are unsupported.`);
	}
}

function normalizeConfig(
	config: McpConfig,
	env: NodeJS.ProcessEnv,
): McpConfiguration {
	const servers: McpServer[] = [];
	const issues: { server: string; message: string }[] = [];
	for (const [name, raw] of Object.entries(config.mcpServers).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (raw.enabled === false) continue;
		const http =
			typeof raw.url === "string" &&
			(raw.type === undefined ||
				raw.type === "http" ||
				raw.type === "streamable-http");
		try {
			expandValues(
				(http ? raw.headers : raw.env) as Record<string, string> | undefined,
				env,
				http ? "headers" : "env",
			);
			raw.exposure = normalizeExposure(raw.exposure);
			if (isRecord(raw.toolExposure)) {
				for (const [tool, mode] of Object.entries(raw.toolExposure))
					raw.toolExposure[tool] = normalizeExposure(mode);
			}
			servers.push({
				name,
				kind: http ? "http" : "stdio",
				config: raw,
			} as McpServer);
		} catch (error) {
			if (!(error instanceof MissingVariable)) throw error;
			issues.push({ server: name, message: error.message });
		}
	}
	return { servers, issues };
}

export async function loadMcpConfig(
	selection: McpConfigPath | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<McpConfiguration> {
	const config = await readConfig(selection);
	validateConfig(config);
	return normalizeConfig(config, env);
}

export function resolveMcpStdioOptions(
	server: Extract<McpServer, { kind: "stdio" }>,
	canonicalCwd: string,
): StdioTransportOptions {
	return {
		command: server.config.command,
		args: server.config.args,
		env: server.config.env,
		cwd: resolve(canonicalCwd, server.config.cwd ?? "."),
		inheritEnv: server.config.inheritEnv === false ? false : undefined,
	};
}

export function getMcpToolExposure(
	server: McpServer,
	tool: string,
): McpExposure {
	const modes = server.config.toolExposure;
	if (!modes) return server.config.exposure;
	if (Object.hasOwn(modes, tool)) return modes[tool];
	for (const [pattern, mode] of Object.entries(modes)) {
		if (!pattern.includes("*")) continue;
		const escaped = pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		if (new RegExp(`^${escaped}$`, "s").test(tool)) return mode;
	}
	return server.config.exposure;
}
