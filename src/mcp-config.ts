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
export type BlockedMcpServer = { kind: "blocked"; name: string; issue: string };

export type McpConfiguration = {
	servers: (McpServer | BlockedMcpServer)[];
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
	field: "headers" | "env",
) {
	if (!values) return undefined;
	const entries = Object.entries(values);
	if (entries.some(([, value]) => value.trimStart().startsWith("!")))
		rejectConfig(`${field} command helpers are unsupported.`);
	return Object.fromEntries(
		entries.map(([key, value]) => [
			key,
			value.replace(
				/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
				(_match, name: string) => {
					const replacement = Object.hasOwn(env, name) ? env[name] : undefined;
					if (replacement === undefined) throw new MissingVariable(field);
					return replacement;
				},
			),
		]),
	);
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

export function isSecureMcpOAuthUrl(url: URL) {
	return (
		!url.username &&
		!url.password &&
		!url.href.includes("#") &&
		(url.protocol === "https:" ||
			(url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
	);
}

function readPublicOAuth(server: ValidatedServer): PublicMcpOAuth | undefined {
	if (server.config.oauth === undefined) return undefined;
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
	const { clientId, scope, ...options } = oauth;
	if (
		!clientId?.trim() ||
		[clientId, scope].some(
			(value) =>
				value !== undefined &&
				(value.trimStart().startsWith("!") || value.includes("${")),
		) ||
		Object.keys(options).some(
			(key) => key !== "callbackPort" && key !== "callbackUrl",
		)
	)
		rejectConfig(
			"OAuth requires a literal pre-registered public clientId; only scope, callbackPort and callbackUrl may also be set.",
		);
	return { ...oauth, clientId };
}

function validateLocalFields(config: Record<string, unknown>) {
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

function validateServer(name: string, raw: unknown): ValidatedServer {
	const checked = validateMcpServerConfig(name, raw);
	if (checked.kind === "invalid") {
		const prefix = `server "${name}"`;
		rejectConfig(
			checked.error.startsWith(prefix)
				? checked.error.slice(prefix.length).replace(/^:? /, "")
				: "Server names require letters, digits, underscores or dashes.",
		);
	}
	validateLocalFields(checked.config);
	return checked;
}

function bindServer(
	name: string,
	server: ValidatedServer,
	oauth: PublicMcpOAuth | undefined,
	env: NodeJS.ProcessEnv,
): McpServer | BlockedMcpServer {
	const { config } = server;
	const exposure = normalizeExposure(config.exposure);
	const toolExposure = isRecord(config.toolExposure)
		? Object.fromEntries(
				Object.entries(config.toolExposure).map(([tool, mode]) => [
					tool,
					normalizeExposure(mode),
				]),
			)
		: undefined;
	try {
		if (server.kind === "http") {
			const headers = expandValues(server.config.headers, env, "headers");
			return {
				name,
				kind: "http",
				config: { ...server.config, exposure, toolExposure, oauth, headers },
			};
		}
		const variables = expandValues(server.config.env, env, "env");
		return {
			name,
			kind: "stdio",
			config: { ...server.config, exposure, toolExposure, env: variables },
		};
	} catch (error) {
		if (!(error instanceof MissingVariable)) throw error;
		return { kind: "blocked", name, issue: error.message };
	}
}

export async function loadMcpConfig(
	selection: McpConfigPath | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<McpConfiguration> {
	const config = await readConfig(selection);
	if (!isRecord(config) || !isRecord(config.mcpServers))
		rejectConfig("Expected an object containing an mcpServers object.");
	if (
		config.autoEnableCodemode !== undefined &&
		config.autoEnableCodemode !== true
	)
		rejectConfig("autoEnableCodemode must be true when supplied.");

	const servers: McpConfiguration["servers"] = [];
	const namespaces = new Map<string, boolean>();
	for (const [name, raw] of Object.entries(config.mcpServers).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (isRecord(raw) && raw.enabled === false) continue;
		const server = validateServer(name, raw);
		const oauth = readPublicOAuth(server);
		const namespace = mcpNamespace(name);
		const previous = namespaces.get(namespace);
		if (previous !== undefined && (previous || oauth !== undefined))
			rejectConfig(
				"Enabled server names cannot share a namespace when either uses OAuth.",
			);
		namespaces.set(namespace, oauth !== undefined);
		servers.push(bindServer(name, server, oauth, env));
	}
	return { servers };
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
