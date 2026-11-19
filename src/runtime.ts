import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	Harness,
	type Conversation,
	type ConversationId,
	type DocumentReader,
	type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { validateCwd } from "./config.js";
import {
	ConversationDoc,
	MappingDoc,
	UUID,
	createConfigurationError,
	createCodingRegistry,
	validateConversation,
} from "./conversation-resources.js";
import { McpAdapter } from "./mcp.js";
import { McpConfigurationError, type McpConfiguration } from "./mcp-config.js";
import { loadResources, type ResourcePaths } from "./resources.js";
import { Session } from "./session.js";
import { SessionOpenError } from "./session-errors.js";
import { openSessionStore, type SessionStore } from "./session-store.js";
import { UserExtensionError } from "./user-extensions.js";

type LaunchConfiguration = {
	readonly model: Readonly<{ provider: string; modelId: string }>;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly resourcePaths: Readonly<ResourcePaths>;
};

export class Runtime {
	private readonly storageFailure = Promise.withResolvers<void>();
	private storageFailed = false;
	private harness!: Harness;
	private sandbox?: CodemodeSandbox;
	private mcp?: McpAdapter;
	private readonly environments = new Map<
		ConversationId,
		Promise<NodeExecutionEnv>
	>();
	private closing?: Promise<void>;
	private stopped = false;
	private constructor(
		private readonly models: Models,
		private readonly configuration: LaunchConfiguration,
		private readonly store: SessionStore,
		private readonly mcpConfiguration: McpConfiguration,
	) {}

	static async open(
		models: Models,
		model: { provider: string; modelId: string },
		thinkingLevel: ModelThinkingLevel = "off",
		resourcePaths: ResourcePaths = {},
		sessionsDir?: string,
		mcpConfiguration: McpConfiguration = { servers: [], issues: [] },
		extensionPaths: readonly string[] = [],
	) {
		const runtime = new Runtime(
			models,
			Object.freeze({
				model: Object.freeze({ ...model }),
				thinkingLevel,
				resourcePaths: Object.freeze({ ...resourcePaths }),
			}),
			await openSessionStore(sessionsDir),
			mcpConfiguration,
		);
		await runtime.initialize(extensionPaths);
		return runtime;
	}
	get persistent() {
		return this.store.persistent;
	}
	get failure() {
		return this.storageFailure.promise;
	}
	get failed() {
		return this.storageFailed;
	}

	private async initialize(extensionPaths: readonly string[]) {
		const progressIntervalMs = 20;
		let storage: Storage | undefined;
		try {
			this.sandbox = new CodemodeSandbox({
				memoryLimitBytes: 64 * 1024 * 1024,
			});
			this.mcp = new McpAdapter(this.mcpConfiguration);
			const registry = await createCodingRegistry(
				this.sandbox,
				this.mcp,
				extensionPaths,
			);
			storage = await this.store.openStorage();
			this.harness = await Harness.open(
				storage,
				{
					models: this.models,
					registry,
					settings: {
						retry: { enabled: false },
						stream: { maxRetries: 0 },
						progress: {
							partialIntervalMs: progressIntervalMs,
							outputIntervalMs: progressIntervalMs,
						},
					},
					onReport: (report) => {
						if (report.kind === "storage_failed") this.failStorage();
					},
					env: ({ conversationId, read }) =>
						this.getEnvironment(conversationId, read),
				},
				context,
			);
			this.harness.resume();
		} catch (error) {
			try {
				await this.release(storage);
			} catch {
				/* Opening still fails; no partially owned Runtime is returned. */
			}
			if (
				error instanceof McpConfigurationError ||
				error instanceof UserExtensionError
			)
				throw error;
			throw new SessionOpenError(
				"Could not open shared session storage. Check private files, compatible runtime and whole-store backups before restarting.",
				true,
			);
		}
	}

	private async getEnvironment(id: ConversationId, read: DocumentReader) {
		let pending = this.environments.get(id);
		if (!pending) {
			pending = this.createEnvironment(id, read);
			this.environments.set(id, pending);
			void pending.catch(() => {
				if (this.environments.get(id) === pending) this.environments.delete(id);
			});
		}
		return pending;
	}

	private async createEnvironment(id: ConversationId, read: DocumentReader) {
		const conversation = await this.harness.conversation(id, context);
		if (!conversation) throw createConfigurationError();
		const { cwd } = await validateConversation(read, conversation, this.models);
		if (!this.stopped) await this.mcp?.prepare(id, cwd);
		return new NodeExecutionEnv({ cwd });
	}

	async createSession(
		cwd: string,
		requestedSessionId?: string,
	): Promise<Session> {
		this.requireAvailable();
		await validateCwd(cwd);
		const canonical = await realpath(cwd);
		const { instructions, skills = "" } = await loadResources(
			canonical,
			this.configuration.resourcePaths,
		);
		const sessionId = requestedSessionId ?? randomUUID();
		if (!UUID.test(sessionId)) throw createConfigurationError();
		this.requireAvailable();
		const conversation = await this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: this.configuration.model,
					thinkingLevel: this.configuration.thinkingLevel,
					cwd: canonical,
					instructions,
				},
				init: async (tx, conversationId) => {
					const mapping = await tx.doc(MappingDoc);
					if (
						mapping.conversations[sessionId] !== undefined ||
						Object.values(mapping.conversations).includes(conversationId)
					)
						throw createConfigurationError();
					Object.assign(await tx.doc(ConversationDoc, conversationId), {
						sessionId,
						skills,
					});
					mapping.conversations[sessionId] = conversationId;
				},
			},
			context,
		);
		return this.createAttachment(sessionId, conversation);
	}

	async loadSession(sessionId: string, cwd: string): Promise<Session> {
		this.requireAvailable();
		if (!this.persistent)
			throw new SessionOpenError("Session load requires PID_ACP_SESSIONS_DIR.");
		if (!UUID.test(sessionId))
			throw new SessionOpenError(
				"Invalid session ID. Use the UUID returned by session/new.",
			);
		const mapping = await this.harness.snapshot(MappingDoc, context);
		const conversationId = mapping?.conversations[sessionId];
		if (conversationId === undefined)
			throw new SessionOpenError(
				"Unknown saved session. Check the storage root and UUID, restore a whole-store backup, or create a new session.",
			);
		const conversation = await this.harness.conversation(
			conversationId,
			context,
		);
		if (!conversation) throw createConfigurationError();
		const metadata = await validateConversation(
			this.harness,
			conversation,
			this.models,
			cwd,
		);
		if (metadata.sessionId !== sessionId) throw createConfigurationError();
		this.requireAvailable();
		return this.createAttachment(sessionId, conversation);
	}

	private createAttachment(sessionId: string, conversation: Conversation) {
		return new Session(
			sessionId,
			conversation,
			this.harness,
			() => this.failed,
		);
	}
	private requireAvailable() {
		if (this.failed)
			throw new SessionOpenError(
				"Session storage failed and is unavailable. Restart the server before opening a session.",
			);
		if (this.stopped)
			throw new SessionOpenError(
				"Shared session storage is unavailable. Restart the server before opening a session.",
			);
	}

	private failStorage() {
		this.storageFailed = true;
		this.storageFailure.resolve();
	}
	close(): Promise<void> {
		this.stopped = true;
		this.mcp?.stopAdmission();
		this.closing ??= this.release();
		return this.closing;
	}
	private async release(untransferredStorage?: Storage) {
		this.stopped = true;
		this.mcp?.stopAdmission();
		const failures: unknown[] = [];
		try {
			if (this.harness) await this.harness.close(context);
			else await untransferredStorage?.close(context);
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.mcp?.close();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.sandbox?.close();
		} catch (error) {
			failures.push(error);
		}
		// Native close joins all invocations, including ones that allocated environments during close.
		const results = await Promise.allSettled(
			[...this.environments.values()].map(async (pending) => {
				let env: NodeExecutionEnv;
				try {
					env = await pending;
				} catch {
					return;
				}
				await env.cleanup(context);
			}),
		);
		this.environments.clear();
		for (const result of results)
			if (result.status === "rejected") failures.push(result.reason);
		try {
			await this.store.close();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length)
			throw new AggregateError(
				failures,
				"Could not release shared session resources. Inspect storage before restarting.",
			);
	}
}
