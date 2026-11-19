import { randomUUID } from "node:crypto";
import type {
	SessionUpdate,
	ToolCallContent,
	ToolKind,
} from "@agentclientprotocol/sdk";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ContextView,
	type Conversation,
	type ConversationView,
	type EntryRecord,
	type LiveState,
	ResetEntry,
	ToolResultEntry,
	UserEntry,
} from "@earendil-works/pi-durable";

type SentBlock = {
	readonly text: string;
	readonly messageId: string;
};

function createToolContent(text: string): ToolCallContent[] {
	return [{ type: "content", content: { type: "text", text } }];
}

type ToolPresentation = {
	readonly name: string;
	output: string;
	done: boolean;
};

function getToolKind(name: string): ToolKind {
	switch (name) {
		case "bash":
			return "execute";
		case "read":
			return "read";
		case "edit":
		case "write":
			return "edit";
		default:
			return "other";
	}
}

function createResultContent(
	output: ToolResultMessage["content"],
): ToolCallContent[] {
	return output.map((block) => ({
		type: "content",
		content:
			block.type === "text"
				? { type: "text", text: block.text }
				: { type: "image", data: block.data, mimeType: block.mimeType },
	}));
}

function createToolCall(
	id: string,
	name: string,
	args?: unknown,
): SessionUpdate {
	return {
		sessionUpdate: "tool_call",
		toolCallId: id,
		title: name,
		kind: getToolKind(name),
		status: "in_progress",
		...(args === undefined ? {} : { rawInput: args }),
	};
}

export function createHistoryUpdates(
	{ entries, contributions, messages }: ContextView,
	pendingTools: ReadonlySet<string> = new Set(),
): SessionUpdate[] {
	const visibleKinds = new Set([
		UserEntry.kind,
		AssistantEntry.kind,
		ToolResultEntry.kind,
		ResetEntry.kind,
	]);
	const history = entries.flatMap((entry, index) =>
		visibleKinds.has(entry.kind) ? (contributions[index] ?? []) : [],
	);
	const contributed = new Set(contributions.flat());
	const missingResults = new Map<AssistantMessage, ToolResultMessage[]>();
	let assistant: AssistantMessage | undefined;
	// SDK context retains contribution objects; only synthesized results are new.
	for (const message of messages) {
		if (message.role === "assistant") assistant = message;
		if (message.role !== "toolResult" || !assistant || contributed.has(message))
			continue;
		const results = missingResults.get(assistant) ?? [];
		results.push(message);
		missingResults.set(assistant, results);
	}
	const tail = history.findLast((message) => message.role !== "toolResult");
	const updates: SessionUpdate[] = [];
	for (const message of history) {
		updates.push(...createMessageUpdates(message));
		if (message.role !== "assistant") continue;
		for (const result of missingResults.get(message) ?? []) {
			if (message === tail && pendingTools.has(result.toolCallId)) continue;
			updates.push(...createMessageUpdates(result));
		}
	}
	return updates;
}

export function createMessageUpdates(message: Message): SessionUpdate[] {
	if (message.role === "system") return [];
	if (message.role === "toolResult") {
		return [
			{
				sessionUpdate: "tool_call_update",
				toolCallId: message.toolCallId,
				status: message.isError ? "failed" : "completed",
				content: createResultContent(message.content),
				rawOutput: message.content,
			},
		];
	}
	const blocks =
		typeof message.content === "string"
			? [{ type: "text" as const, text: message.content }]
			: message.content;
	const updates: SessionUpdate[] = [];
	for (const block of blocks) {
		if (block.type === "toolCall") {
			updates.push(createToolCall(block.id, block.name, block.arguments));
			continue;
		}
		const text =
			block.type === "text"
				? block.text
				: block.type === "thinking"
					? block.thinking
					: "";
		if (!text) continue;
		updates.push({
			sessionUpdate:
				message.role === "user"
					? "user_message_chunk"
					: block.type === "thinking"
						? "agent_thought_chunk"
						: "agent_message_chunk",
			messageId: randomUUID(),
			content: { type: "text", text },
		});
	}
	return updates;
}

export class EventBridge {
	private readonly blocks = new Map<number, SentBlock>();
	private latestEntry: EntryRecord["id"] | undefined;
	private readonly tools = new Map<string, ToolPresentation>();
	constructor(
		baseline: readonly EntryRecord[],
		private readonly send: (update: SessionUpdate) => Promise<void>,
		replayed = false,
	) {
		this.latestEntry = baseline.at(-1)?.id;
		if (!replayed) return;
		for (const entry of baseline)
			for (const message of entry.model ?? []) {
				if (message.role === "assistant")
					for (const block of message.content) {
						if (block.type === "toolCall")
							this.tools.set(block.id, {
								name: block.name,
								output: "",
								done: false,
							});
					}
				if (message.role === "toolResult")
					this.tools.set(message.toolCallId, {
						name: message.toolName,
						output: "",
						done: true,
					});
			}
	}
	private async sendDelta(
		index: number,
		delta: string,
		sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
	) {
		if (!delta) return;
		const previous = this.blocks.get(index);
		const messageId = previous?.messageId ?? randomUUID();
		this.blocks.set(index, {
			text: (previous?.text ?? "") + delta,
			messageId,
		});
		await this.send({
			sessionUpdate,
			messageId,
			content: { type: "text", text: delta },
		});
	}
	private async sendBlock(
		index: number,
		block: AssistantMessage["content"][number],
	) {
		const text =
			block.type === "text"
				? block.text
				: block.type === "thinking"
					? block.thinking
					: "";
		const previous = this.blocks.get(index)?.text ?? "";
		if (!text.startsWith(previous)) this.blocks.delete(index);
		const sent = this.blocks.get(index)?.text.length ?? 0;
		if (block.type === "text")
			await this.sendDelta(
				index,
				block.text.slice(sent),
				"agent_message_chunk",
			);
		if (block.type === "thinking")
			await this.sendDelta(
				index,
				block.thinking.slice(sent),
				"agent_thought_chunk",
			);
	}
	private async sendMessage(message: Message) {
		if (message.role !== "assistant") return;
		for (const [index, block] of message.content.entries())
			await this.sendBlock(index, block);
	}
	private async acceptEntry(entry: EntryRecord) {
		if (this.latestEntry !== undefined && entry.id <= this.latestEntry) return;
		this.latestEntry = entry.id;
		if (
			![
				UserEntry.kind,
				AssistantEntry.kind,
				ToolResultEntry.kind,
				ResetEntry.kind,
			].includes(entry.kind)
		)
			return;
		if (entry.kind === UserEntry.kind || entry.kind === ResetEntry.kind) {
			this.blocks.clear();
			this.tools.clear();
			this.generationKey = undefined;
		}
		for (const message of entry.model ?? []) {
			if (entry.kind === UserEntry.kind && message.role === "user")
				for (const update of createMessageUpdates(message))
					await this.send(update);
			if (message.role === "assistant") {
				await this.sendMessage(message);
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					if (this.tools.get(block.id)?.done) this.tools.delete(block.id);
					await this.startTool(block.id, block.name, block.arguments);
				}
				this.blocks.clear();
			}
			if (message.role === "toolResult") {
				await this.endTool(
					message.toolCallId,
					message.toolName,
					message.isError,
					message.content,
				);
			}
		}
	}
	private async startTool(id: string, name: string, args?: unknown) {
		if (this.tools.has(id)) return;
		this.tools.set(id, { name, output: "", done: false });
		await this.send(createToolCall(id, name, args));
	}

	private async endTool(
		id: string,
		name: string,
		failed: boolean,
		output?: ToolResultMessage["content"],
	) {
		await this.startTool(id, name);
		const tool = this.tools.get(id);
		if (!tool || tool.done) return;
		tool.done = true;
		await this.send({
			sessionUpdate: "tool_call_update",
			toolCallId: id,
			status: failed ? "failed" : "completed",
			content: output
				? createResultContent(output)
				: createToolContent(tool.output),
			rawOutput: output,
		});
	}

	private generationKey?: string;

	async accept(
		view: ConversationView,
		conversation?: Conversation,
	): Promise<void> {
		if (
			conversation &&
			view.before !== undefined &&
			(this.latestEntry === undefined || view.before > this.latestEntry)
		) {
			const historyPageSize = 100;
			let cursor: Parameters<Conversation["entries"]>[2];
			do {
				const page = await conversation.entries(
					{
						order: "ascending",
						minEntryId: this.latestEntry,
						maxEntryId: view.before,
					},
					historyPageSize,
					cursor,
					context,
				);
				for (const entry of page.items) await this.acceptEntry(entry);
				cursor = page.next;
			} while (cursor !== undefined);
		}
		for (const entry of view.entries) await this.acceptEntry(entry);
		const live = view.docs["pi.live"] as LiveState | undefined;
		const key = live?.generation
			? `${live.run?.taskId}/${live.generation.attempt}`
			: undefined;
		if (key !== this.generationKey) this.blocks.clear();
		this.generationKey = key;
		if (live?.generation?.message)
			await this.sendMessage(live.generation.message);
		for (const slot of live?.tools ?? []) {
			if (slot.status === "pending") continue;
			await this.startTool(slot.callId, slot.name);
			const tool = this.tools.get(slot.callId);
			if (!tool || tool.done) continue;
			if (slot.output !== undefined && slot.output !== tool.output) {
				tool.output = slot.output;
				await this.send({
					sessionUpdate: "tool_call_update",
					toolCallId: slot.callId,
					status: "in_progress",
					content: createToolContent(tool.output),
				});
			}
			if (slot.status === "done" && slot.entry === undefined)
				await this.endTool(slot.callId, slot.name, true);
		}
		// A coalesced watch may skip a fault's done slot before the round clears it.
		// Entries above settle real results first; pending slots still belong to the round.
		const current = new Set(live?.tools?.map((slot) => slot.callId));
		for (const [id, tool] of this.tools)
			if (!tool.done && !current.has(id))
				await this.endTool(id, tool.name, true);
	}
}
