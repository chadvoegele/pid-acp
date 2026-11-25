import { pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import {
	defineTool,
	type ConversationId,
	type ToolRegistration,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import {
	McpClient,
	StdioTransport,
	StreamableHttpTransport,
	createMcpToolName,
	mcpNamespace,
	type McpTransport,
} from "@earendil-works/pi-mcp";
import type { McpAuthProvider } from "@earendil-works/pi-mcp/oauth";
import {
	McpConfigurationError,
	getMcpToolExposure,
	resolveMcpStdioOptions,
	type McpConfiguration,
	type McpServer,
} from "./mcp-config.js";
import {
	oauthFailure,
	piMcpAuthProvider,
	type McpOAuthFailure,
} from "./mcp-oauth.js";
import {
	MCP_ENVELOPE_SCHEMA,
	convertMcpResult,
	describeMcpTool,
	type McpDescriptor,
} from "./mcp-tools.js";

const oauthReasons = {
	client:
		"OAuth state is not for a supported pre-registered public client; check the Pi and pid-acp client configuration",
	store:
		"Pi OAuth store is invalid or inaccessible; check PID_ACP_MCP_AUTH_FILE, permissions and server identity",
	busy: "Pi OAuth refresh lock is busy; let the other refresher finish",
	refresh:
		"OAuth refresh failed; check the authorization server and public client configuration",
};

function oauthGuidance(name: string, failure: McpOAuthFailure) {
	return failure === "login"
		? `OAuth sign-in required; stop all refreshers and run \`pi mcp login ${name}\` as the service user, then restart pid-acp`
		: `${oauthReasons[failure]}, then restart pid-acp`;
}

function createUnavailableError(
	server: string,
	reason: string,
	failure?: McpOAuthFailure,
) {
	const guidance = failure
		? oauthGuidance(server, failure)
		: "Check its configuration and current tools, then restart pid-acp";
	return new Error(
		`MCP server ${server}: ${reason}. ${guidance}. An interrupted external effect may have occurred; inspect the external system before repeating a mutation.`,
	);
}

function createMcpTransport(
	server: McpServer,
	cwd: string,
	authProvider: McpAuthProvider | undefined,
): McpTransport {
	if (server.kind === "stdio")
		return new StdioTransport(resolveMcpStdioOptions(server, cwd));
	return new StreamableHttpTransport({
		url: server.config.url,
		headers: server.config.headers,
		authProvider,
		fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
	});
}

type ConnectionState = {
	client?: McpClient;
	oauthFailure?: McpOAuthFailure;
};

type ServerBinding = {
	server: McpServer;
	authProvider?: McpAuthProvider;
	connections: Map<ConversationId | symbol, ConnectionState>;
};

export type McpRegistration = {
	readonly tools: readonly ToolRegistration[];
	readonly namespaces: readonly {
		name: string;
		prefix: string;
		description: string;
	}[];
};

export class McpAdapter {
	private readonly servers: ServerBinding[];
	private readonly issues: McpConfiguration["issues"];
	private stopped = false;
	private closing?: Promise<void>;

	constructor({ servers, issues, oauthFile }: McpConfiguration) {
		this.issues = issues;
		this.servers = servers.map((server) => {
			const binding: ServerBinding = { server, connections: new Map() };
			if (server.kind === "http" && server.config.oauth) {
				if (!oauthFile)
					throw new McpConfigurationError(
						"Missing Pi MCP OAuth store configuration.",
					);
				binding.authProvider = piMcpAuthProvider(
					oauthFile,
					server.name,
					server.config.url,
					server.config.oauth,
					() => this.stopped,
				);
			}
			return binding;
		});
	}

	get enabled() {
		return this.servers.length > 0 || this.issues.length > 0;
	}

	async discover(cwd: string): Promise<McpRegistration> {
		const tools: ToolRegistration[] = [];
		const taken = new Map<string, string>();
		const discovery = Symbol();
		for (const binding of this.servers) {
			const { server, authProvider, connections } = binding;
			const state: ConnectionState = {};
			connections.set(discovery, state);
			try {
				const client = await this.connect(binding, state, cwd);
				const definitions = client.serverCapabilities?.tools
					? await client.listTools()
					: [];
				const descriptors = definitions
					.filter((tool) => getMcpToolExposure(server, tool.name) !== "hidden")
					.map(describeMcpTool);
				tools.push(...this.createTools(binding, descriptors, taken));
			} catch (error) {
				const failure = authProvider && oauthFailure(error);
				throw new McpConfigurationError(
					`MCP server ${server.name}: startup discovery failed. ${failure ? `${oauthGuidance(server.name, failure)}.` : "Check its connection and tool schemas. Discovery uses the canonical process launch directory, not a saved workspace; configure an absolute server cwd if needed, then restart pid-acp."}`,
				);
			} finally {
				try {
					await state.client?.close();
				} finally {
					connections.delete(discovery);
				}
			}
		}
		return {
			tools,
			namespaces: this.servers.map(({ server }) => ({
				name: mcpNamespace(server.name),
				prefix: `${mcpNamespace(server.name)}__`,
				description: server.config.description ?? `MCP server ${server.name}`,
			})),
		};
	}

	async prepare(id: ConversationId, cwd: string) {
		if (this.stopped) throw new Error("MCP is closing.");
		await Promise.all(
			this.servers.map(async (binding) => {
				const { authProvider, connections } = binding;
				if (connections.has(id)) return;
				const state: ConnectionState = {};
				connections.set(id, state);
				try {
					await this.connect(binding, state, cwd);
				} catch (error) {
					// Keep healthy servers usable; failed clients require a restart.
					if (authProvider) state.oauthFailure = oauthFailure(error);
				}
			}),
		);
	}

	private async connect(
		{ server, authProvider }: ServerBinding,
		state: ConnectionState,
		cwd: string,
	) {
		if (this.stopped) throw new Error("MCP is closing.");
		const transport = createMcpTransport(server, cwd, authProvider);
		const client = new McpClient({
			name: "pid-acp",
			version: "0.1.0",
			capabilities: { roots: { listChanged: false } },
			roots: [{ uri: pathToFileURL(cwd).href }],
		});
		state.client = client;
		try {
			await client.connect(transport);
			return client;
		} catch (error) {
			await client.close().catch(() => {});
			state.client = undefined;
			throw error;
		}
	}

	private createTools(
		binding: ServerBinding,
		descriptors: readonly McpDescriptor[],
		taken: Map<string, string>,
	) {
		const { server } = binding;
		return descriptors
			.toSorted((a, b) => a.original.localeCompare(b.original))
			.map((descriptor) => {
				const identity = `${server.name}\0${descriptor.original}`;
				const name = createMcpToolName(
					server.name,
					descriptor.original,
					(name) => taken.has(name) && taken.get(name) !== identity,
				);
				taken.set(name, identity);
				return defineTool({
					name,
					description: descriptor.description,
					parameters: descriptor.parameters,
					structuredOutputSchema: MCP_ENVELOPE_SCHEMA,
					callers: ["tools"],
					deferred: true,
					replay: "unsafe",
					execute: (args, api, context) =>
						this.execute(binding, descriptor.original, args, api, context),
				});
			});
	}

	getStatus(id: ConversationId) {
		return [
			...this.servers.map(({ server, connections }) => {
				const state = connections.get(id);
				return {
					name: mcpNamespace(server.name),
					description: server.config.description ?? server.name,
					status: state?.oauthFailure
						? oauthGuidance(server.name, state.oauthFailure)
						: (state?.client?.connectionState ??
							(state ? "unavailable; restart pid-acp" : "not connected")),
				};
			}),
			...this.issues.map((issue) => ({
				name: issue.server,
				description: "",
				status: issue.message,
			})),
		];
	}

	private async execute(
		{ server, authProvider, connections }: ServerBinding,
		original: string,
		args: unknown,
		api: ToolExecutionApi,
		context: Context,
	) {
		const state = connections.get(api.conversationId);
		const client = state?.client;
		if (this.stopped || !client)
			throw createUnavailableError(
				server.name,
				"unavailable",
				state?.oauthFailure,
			);
		try {
			const result = await client.callTool(
				original,
				args as Record<string, unknown>,
				{
					signal: context.abortSignal,
					timeoutMs: (server.config.timeout ?? 60) * 1000,
					onProgress: ({ progress, total }) => {
						if (!context.abortSignal?.aborted)
							api.output(
								`MCP ${server.name}: ${progress}${typeof total === "number" ? `/${total}` : ""}\n`,
							);
					},
				},
			);
			state.oauthFailure = undefined;
			return await convertMcpResult(result);
		} catch (error) {
			if (authProvider) state.oauthFailure = oauthFailure(error);
			throw createUnavailableError(
				server.name,
				"call failed",
				state.oauthFailure,
			);
		}
	}

	stopAdmission() {
		this.stopped = true;
	}

	close(): Promise<void> {
		this.stopAdmission();
		this.closing ??= this.release();
		return this.closing;
	}

	private async release() {
		const results = await Promise.allSettled(
			this.servers.flatMap(({ connections }) =>
				[...connections.values()].map(({ client }) => client?.close()),
			),
		);
		await Promise.all(
			this.servers.map(({ authProvider }) => authProvider?.settled()),
		);
		for (const { connections } of this.servers) connections.clear();
		if (results.some((result) => result.status === "rejected"))
			throw new Error("Could not close all MCP connections.");
	}
}
