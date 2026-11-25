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
	oauthGuidance,
	piMcpAuthProvider,
	type McpOAuthFailure,
} from "./mcp-oauth.js";
import {
	MCP_ENVELOPE_SCHEMA,
	convertMcpResult,
	describeMcpTool,
	type McpDescriptor,
} from "./mcp-tools.js";

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
		// Only opt in servers that challenge before effects: pi-mcp may resend a POST once.
		authProvider,
		// Never forward credentials, session headers or a mutation across a redirect.
		fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
	});
}

type Connection = {
	client: McpClient;
	close: () => Promise<void>;
};
type ServerState = {
	connection?: Connection;
	oauthFailure?: McpOAuthFailure;
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
	private readonly conversations = new Map<
		ConversationId,
		Map<string, ServerState>
	>();
	private readonly owned = new Set<Connection>();
	private readonly authProviders = new Map<string, McpAuthProvider>();
	private stopped = false;
	private closing?: Promise<void>;

	constructor(private readonly configuration: McpConfiguration) {
		for (const server of configuration.servers) {
			if (server.kind !== "http" || !server.config.oauth) continue;
			const { oauthFile } = configuration;
			if (!oauthFile)
				throw new McpConfigurationError(
					"Missing Pi MCP OAuth store configuration.",
				);
			this.authProviders.set(
				server.name,
				piMcpAuthProvider(
					oauthFile,
					server.name,
					server.config.url,
					server.config.oauth,
					() => this.stopped,
				),
			);
		}
	}

	get enabled() {
		return (
			this.configuration.servers.length > 0 ||
			this.configuration.issues.length > 0
		);
	}

	async discover(cwd: string): Promise<McpRegistration> {
		const tools: ToolRegistration[] = [];
		const taken = new Map<string, string>();
		for (const server of this.configuration.servers) {
			let connection: Connection | undefined;
			try {
				connection = await this.connect(server, cwd);
				const definitions = connection.client.serverCapabilities?.tools
					? await connection.client.listTools()
					: [];
				const descriptors = definitions
					.filter((tool) => getMcpToolExposure(server, tool.name) !== "hidden")
					.map(describeMcpTool);
				tools.push(...this.createTools(server, descriptors, taken));
			} catch (error) {
				const failure =
					this.authProviders.has(server.name) && oauthFailure(error);
				throw new McpConfigurationError(
					`MCP server ${server.name}: startup discovery failed. ${failure ? `${oauthGuidance(server.name, failure)}.` : "Check its connection and tool schemas. Discovery uses the canonical process launch directory, not a saved workspace; configure an absolute server cwd if needed, then restart pid-acp."}`,
				);
			} finally {
				await connection?.close();
			}
		}
		return {
			tools,
			namespaces: this.configuration.servers.map((server) => ({
				name: mcpNamespace(server.name),
				prefix: `${mcpNamespace(server.name)}__`,
				description: server.config.description ?? `MCP server ${server.name}`,
			})),
		};
	}

	async prepare(id: ConversationId, cwd: string) {
		if (this.stopped) throw new Error("MCP is closing.");
		const states = new Map<string, ServerState>();
		this.conversations.set(id, states);
		await Promise.all(
			this.configuration.servers.map(async (server) => {
				const state: ServerState = {};
				states.set(server.name, state);
				try {
					state.connection = await this.connect(server, cwd);
				} catch (error) {
					// Keep healthy servers usable; failed clients require a restart.
					if (this.authProviders.has(server.name))
						state.oauthFailure = oauthFailure(error);
				}
			}),
		);
	}

	private async connect(server: McpServer, cwd: string) {
		if (this.stopped) throw new Error("MCP is closing.");
		const transport = createMcpTransport(
			server,
			cwd,
			this.authProviders.get(server.name),
		);
		const client = new McpClient({
			name: "pid-acp",
			version: "0.1.0",
			capabilities: { roots: { listChanged: false } },
			roots: [{ uri: pathToFileURL(cwd).href }],
		});
		const connection: Connection = {
			client,
			close: async () => {
				await client.close();
				this.owned.delete(connection);
			},
		};
		this.owned.add(connection);
		try {
			await client.connect(transport);
			return connection;
		} catch (error) {
			await connection.close().catch(() => {});
			throw error;
		}
	}

	private createTools(
		server: McpServer,
		descriptors: readonly McpDescriptor[],
		taken: Map<string, string>,
	) {
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
						this.execute(server, descriptor.original, args, api, context),
				});
			});
	}

	getStatus(id: ConversationId) {
		return [
			...this.configuration.servers.map((server) => {
				const state = this.conversations.get(id)?.get(server.name);
				return {
					name: mcpNamespace(server.name),
					description: server.config.description ?? server.name,
					status: state?.oauthFailure
						? oauthGuidance(server.name, state.oauthFailure)
						: (state?.connection?.client.connectionState ??
							(state ? "unavailable; restart pid-acp" : "not connected")),
				};
			}),
			...this.configuration.issues.map((issue) => ({
				name: issue.server,
				description: "",
				status: issue.message,
			})),
		];
	}

	private async execute(
		server: McpServer,
		original: string,
		args: unknown,
		api: ToolExecutionApi,
		context: Context,
	) {
		const state = this.conversations.get(api.conversationId)?.get(server.name);
		const connection = state?.connection;
		if (this.stopped || !connection)
			throw createUnavailableError(
				server.name,
				"unavailable",
				state?.oauthFailure,
			);
		try {
			const result = await connection.client.callTool(
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
			if (this.authProviders.has(server.name))
				state.oauthFailure = oauthFailure(error);
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
			[...this.owned].map((connection) => connection.close()),
		);
		await Promise.all(
			[...this.authProviders.values()].map((provider) => provider.settled()),
		);
		this.conversations.clear();
		this.owned.clear();
		if (results.some((result) => result.status === "rejected"))
			throw new Error("Could not close all MCP connections.");
	}
}
