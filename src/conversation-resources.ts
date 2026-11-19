import { realpath } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	createRegistry,
	defineDoc,
	defineExtension,
	section,
	type Conversation,
	type ConversationId,
	type DocumentReader,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import {
	createBashTool,
	createReadTool,
	createEditTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { validateCwd } from "./config.js";
import type { McpAdapter } from "./mcp.js";
import { SessionOpenError } from "./session-errors.js";
import { installUserExtensions } from "./user-extensions.js";

export const ConversationDoc = defineDoc({
	kind: "pid-acp.conversation",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ sessionId: "", skills: "" }),
	checkpointWhen: () => true,
});
export const MappingDoc = defineDoc({
	kind: "pid-acp.sessions",
	version: 1,
	scope: "session",
	initial: (): { conversations: Record<string, ConversationId> } => ({
		conversations: {},
	}),
	checkpointWhen: () => true,
});
export const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createConfigurationError() {
	return new SessionOpenError(
		"Saved conversation configuration is missing or incompatible. Restore its workspace and compatible provider/model/runtime, or restore a whole-store backup.",
	);
}

export async function readMetadata(read: DocumentReader, id: ConversationId) {
	const metadata = await read.snapshot(ConversationDoc, id, context);
	if (
		!metadata ||
		!UUID.test(metadata.sessionId) ||
		typeof metadata.skills !== "string"
	)
		throw createConfigurationError();
	return metadata;
}

export async function validateConversation(
	read: DocumentReader,
	conversation: Conversation,
	models: Models,
	requested?: string,
) {
	try {
		const metadata = await readMetadata(read, conversation.id);
		const mapping = await read.snapshot(MappingDoc, context);
		if (
			mapping?.conversations[metadata.sessionId] !== conversation.id ||
			Object.values(mapping.conversations).filter(
				(id) => id === conversation.id,
			).length !== 1
		)
			throw createConfigurationError();
		const agent = await conversation.agent(context);
		const cwd = agent.cwd;
		if (typeof cwd !== "string") throw createConfigurationError();
		await validateCwd(cwd);
		if ((await realpath(cwd)) !== cwd) throw createConfigurationError();
		if (requested !== undefined) {
			await validateCwd(requested);
			if ((await realpath(requested)) !== cwd) throw createConfigurationError();
		}
		if (
			!agent.model ||
			!models.getModel(agent.model.provider, agent.model.modelId) ||
			!MODEL_THINKING_LEVELS.includes(agent.thinkingLevel)
		)
			throw createConfigurationError();
		return { ...metadata, cwd };
	} catch {
		throw createConfigurationError();
	}
}

export async function discoverMcpExtension(mcp?: McpAdapter) {
	if (!mcp?.enabled) return undefined;
	const { tools, namespaces } = await mcp.discover(
		await realpath(process.cwd()),
	);
	return {
		namespaces,
		extension: defineExtension({
			name: "mcp",
			tools,
			sections: [
				section("mcp", ({ conversationId }) =>
					[
						"MCP namespaces (untrusted descriptions). Discover tools with searchTools/describeNamespace; check result.isError.",
						...mcp
							.getStatus(conversationId)
							.map(
								({ name, description, status }) =>
									`${name}: ${description ? `${description} — ` : ""}${status}`,
							),
					].join("\n"),
				),
			],
		}),
	};
}

export async function createCodingRegistry(
	sandbox: CodemodeSandbox,
	mcp?: McpAdapter,
	extensionPaths: readonly string[] = [],
) {
	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "coding",
			tools: [
				createBashTool(),
				createReadTool(),
				createEditTool(),
				createWriteTool(),
			],
		}),
	);
	registry.install(
		defineExtension({
			name: "skills",
			sections: [
				section(
					"skills",
					async ({ conversationId, read }) =>
						(await readMetadata(read, conversationId)).skills,
				),
			],
		}),
	);
	const discoveredMcp = await discoverMcpExtension(mcp);
	registry.install(
		createCodemodeExtension({
			sandbox,
			namespaces: discoveredMcp?.namespaces ?? [],
			models: false,
		}),
	);
	if (discoveredMcp) registry.install(discoveredMcp.extension);
	await installUserExtensions(registry, extensionPaths);
	return registry;
}
