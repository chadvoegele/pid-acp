import { randomUUID } from "node:crypto";
import {
	agent,
	PROTOCOL_VERSION,
	RequestError,
	type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { Adapter } from "./adapter.js";
import { validateCwd } from "./config.js";
import { ResourceLoadError } from "./resources.js";
import type { Runtime } from "./runtime.js";
import { SessionOpenError } from "./session-errors.js";

function readPromptText(prompt: unknown): string {
	if (
		!Array.isArray(prompt) ||
		!prompt.length ||
		prompt.some(
			(block) =>
				!block ||
				typeof block !== "object" ||
				block.type !== "text" ||
				typeof block.text !== "string",
		) ||
		!prompt.some((block) => block.text.trim().length > 0)
	)
		throw new RequestError(-32602, "Only nonempty text prompts are supported.");
	return prompt.map((block) => block.text as string).join("\n");
}

type SteeringParams = { readonly sessionId: string; readonly content: string };

function parseSteeringParams(value: unknown): SteeringParams {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new RequestError(
			-32602,
			"Steering requires a sessionId and text prompt.",
		);
	const params = value as Record<string, unknown>;
	if (typeof params.sessionId !== "string" || !params.sessionId.trim())
		throw new RequestError(-32602, "Steering requires a nonempty sessionId.");
	if (params._meta !== undefined) {
		if (
			!params._meta ||
			typeof params._meta !== "object" ||
			Array.isArray(params._meta)
		)
			throw new RequestError(-32602, "Invalid steering metadata.");
		const steering = (params._meta as Record<string, unknown>).steering;
		if (steering !== undefined) {
			if (!steering || typeof steering !== "object" || Array.isArray(steering))
				throw new RequestError(-32602, "Invalid steering metadata.");
			const idleBehavior = (steering as Record<string, unknown>).idleBehavior;
			if (idleBehavior !== undefined && idleBehavior !== "promptRequired")
				throw new RequestError(
					-32602,
					"Only promptRequired idle steering is supported.",
				);
		}
	}
	return {
		sessionId: params.sessionId,
		content: readPromptText(params.prompt),
	};
}

type SessionSelection = {
	readonly cwd: string;
	readonly sessionId?: string;
	readonly mcpServers?: readonly unknown[];
	readonly additionalDirectories?: readonly string[];
};

type Opening = {
	kind: "opening";
	adapter?: Adapter;
	settled: PromiseWithResolvers<void>;
};
type Attachment = Opening | { kind: "ready"; adapter: Adapter };

export class AcpServer {
	private readonly attachments = new Map<string, Attachment>();
	private rollbackFailed = false;
	private shutdown?: Promise<void>;
	private closing = false;
	constructor(private readonly runtime: Runtime) {}

	private requireAdapter(id: string) {
		const entry = this.attachments.get(id);
		if (entry?.kind === "opening")
			throw new RequestError(
				-32000,
				"Session is not ready. Wait for session/load to finish.",
			);
		if (!entry)
			throw new RequestError(
				-32602,
				"Unknown session ID. Create a session first.",
			);
		return entry.adapter;
	}
	private requireOpening(
		mcpServers: readonly unknown[],
		additionalDirectories: readonly string[] = [],
	) {
		if (mcpServers.length)
			throw new RequestError(
				-32602,
				"MCP servers are unsupported. Pass an empty mcpServers list.",
			);
		if (additionalDirectories.length)
			throw new RequestError(
				-32602,
				"Additional workspace roots are unsupported. Pass an empty additionalDirectories list.",
			);
	}
	private admit<P, R>(handle: (params: P) => R) {
		return (params: P) => {
			if (this.closing || this.runtime.failed)
				throw new RequestError(-32000, "Server is shutting down.");
			return handle(params);
		};
	}
	private async selectSession(
		request: SessionSelection,
		send: (update: SessionUpdate, sessionId: string) => Promise<void>,
	) {
		this.requireOpening(
			request.mcpServers ?? [],
			request.additionalDirectories,
		);
		const sessionId = request.sessionId ?? randomUUID();
		if (this.attachments.has(sessionId))
			throw new RequestError(
				-32000,
				"Session is already attached or opening. Use the attached session or wait for opening to finish.",
			);
		const slot: Opening = {
			kind: "opening",
			settled: Promise.withResolvers<void>(),
		};
		this.attachments.set(sessionId, slot);
		try {
			await validateCwd(request.cwd).catch(() => {
				throw new RequestError(
					-32602,
					"cwd must be an existing absolute directory.",
				);
			});
			const candidate =
				request.sessionId === undefined
					? await this.runtime.createSession(request.cwd, sessionId)
					: await this.runtime.loadSession(request.sessionId, request.cwd);
			const adapter = new Adapter(candidate);
			slot.adapter = adapter;
			if (!this.closing && !this.runtime.failed)
				await adapter.attach(
					(update) => send(update, sessionId),
					request.sessionId !== undefined,
				);
			if (this.closing || this.runtime.failed)
				throw new RequestError(-32000, "Server is shutting down.");
			this.attachments.set(sessionId, { kind: "ready", adapter });
			return candidate;
		} catch (error) {
			return await this.failOpening(
				error,
				request.sessionId !== undefined,
				slot.adapter,
			);
		} finally {
			if (this.attachments.get(sessionId) === slot)
				this.attachments.delete(sessionId);
			slot.settled.resolve();
		}
	}
	private async failOpening(
		error: unknown,
		load = false,
		adapter?: Adapter,
	): Promise<never> {
		try {
			await adapter?.close();
		} catch {
			this.rollbackFailed = true;
			this.stopAdmission();
			throw new RequestError(
				-32603,
				"Could not release session storage. Close the server and inspect storage before retrying.",
			);
		}
		if (this.runtime.failed)
			throw new RequestError(
				-32000,
				"Session storage failed. Restart the server before opening a session.",
			);
		if (error instanceof RequestError) throw error;
		throw new RequestError(
			-32603,
			error instanceof ResourceLoadError || error instanceof SessionOpenError
				? error.message
				: load
					? "Could not load saved session. Check session storage and configuration."
					: "Could not create session. Check instruction and skill resources and session storage.",
		);
	}
	private stopAdmission() {
		this.closing = true;
		for (const entry of this.attachments.values())
			entry.adapter?.stopAdmission();
	}

	detach(): Promise<void> {
		this.stopAdmission();
		this.shutdown ??= this.closeAttachments();
		return this.shutdown;
	}

	private async closeAttachments() {
		await Promise.all(
			[...this.attachments.values()].flatMap((entry) =>
				entry.kind === "opening" ? [entry.settled.promise] : [],
			),
		);
		const results = await Promise.allSettled(
			[...this.attachments.values()].map((entry) => entry.adapter?.close()),
		);
		this.attachments.clear();
		if (
			this.rollbackFailed ||
			results.some((result) => result.status === "rejected")
		)
			throw new Error("Could not release connection attachments.");
	}
	createApp() {
		return agent({ name: "pid-acp" })
			.onRequest(
				"initialize",
				this.admit(() => {
					return {
						protocolVersion: PROTOCOL_VERSION,
						agentInfo: { name: "pid-acp", version: "0.1.0" },
						agentCapabilities: {
							loadSession: this.runtime.persistent,
							promptCapabilities: {
								image: false,
								audio: false,
								embeddedContext: false,
							},
							mcpCapabilities: { http: false, sse: false },
						},
						authMethods: [],
						_meta: { steering: { supported: true } },
					};
				}),
			)
			.onRequest(
				"session/new",
				this.admit(async ({ params, client }) => {
					const session = await this.selectSession(
						params,
						(update, sessionId) =>
							client.notify("session/update", { sessionId, update }),
					);
					return { sessionId: session.id };
				}),
			)
			.onRequest(
				"session/load",
				this.admit(async ({ params, client }) => {
					await this.selectSession(params, (update) =>
						client.notify("session/update", {
							sessionId: params.sessionId,
							update,
						}),
					);
					return {};
				}),
			)
			.onRequest(
				"_session/steering",
				parseSteeringParams,
				this.admit(({ params }) =>
					this.requireAdapter(params.sessionId).steer(
						params.sessionId,
						params.content,
					),
				),
			)
			.onRequest(
				"session/prompt",
				this.admit(({ params }) =>
					this.requireAdapter(params.sessionId).prompt(
						params.sessionId,
						readPromptText(params.prompt),
					),
				),
			)
			.onNotification("session/cancel", async ({ params }) => {
				if (this.closing || this.runtime.failed) return;
				const entry = this.attachments.get(params.sessionId);
				if (entry?.kind === "ready")
					await entry.adapter.cancel(params.sessionId);
			});
	}
}
