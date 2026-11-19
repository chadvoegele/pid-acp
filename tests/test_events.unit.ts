import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
	ROOT_CONVERSATION_ID,
	type ConversationView,
	type LiveState,
	type TaskId,
	type EntryId,
	type EntryRecord,
} from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
	readText,
	readStatus,
	readToolId,
	requireToolUpdate,
	readToolText,
} from "./helpers/updates.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageUpdates } from "../dist/events.js";

test("message conversion returns ordered thought, text and tool updates without changing input", async () => {
	const { fauxText, fauxThinking, fauxToolCall } = await import(
		"@earendil-works/pi-ai/providers/faux"
	);
	const message = fauxAssistantMessage([
		fauxThinking("thought"),
		fauxText("before"),
		fauxToolCall("bash", { command: "pwd" }, { id: "original" }),
		fauxText("after"),
	]);
	const original = structuredClone(message);
	const updates = createMessageUpdates(message);
	assert.deepEqual(message, original);
	assert.deepEqual(
		updates.map((update) => update.sessionUpdate),
		[
			"agent_thought_chunk",
			"agent_message_chunk",
			"tool_call",
			"agent_message_chunk",
		],
	);
	assert.partialDeepStrictEqual(updates, [
		{ content: { type: "text", text: "thought" } },
		{ content: { type: "text", text: "before" } },
		{ toolCallId: "original" },
		{ content: { type: "text", text: "after" } },
	]);
	assert.deepEqual(updates[2], {
		sessionUpdate: "tool_call",
		toolCallId: "original",
		title: "bash",
		kind: "execute",
		status: "in_progress",
		rawInput: { command: "pwd" },
	});
	const ids = updates.flatMap((update) =>
		"messageId" in update ? [update.messageId] : [],
	);
	assert.equal(new Set(ids).size, 3);
	for (const id of ids) {
		assert.ok(typeof id === "string");
		assert.match(id, /^[0-9a-f-]{36}$/);
	}
});

test("message conversion handles user strings and blocks and omits images, empty text and system data", () => {
	const stringUpdates = createMessageUpdates({
		role: "user",
		content: "input",
		timestamp: 0,
	});
	assert.partialDeepStrictEqual(stringUpdates, [
		{
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "input" },
		},
	]);
	const blockUpdates = createMessageUpdates({
		role: "user",
		content: [
			{ type: "image", mimeType: "image/png", data: "AQ==" },
			{ type: "text", text: "" },
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		],
		timestamp: 0,
	});
	assert.partialDeepStrictEqual(
		blockUpdates,
		["first", "second"].map((text) => ({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text },
		})),
	);
	assert.deepEqual(
		createMessageUpdates({ role: "system", content: "PRIVATE", timestamp: 0 }),
		[],
	);
	assert.deepEqual(
		createMessageUpdates({ role: "user", content: "", timestamp: 0 }),
		[],
	);
	assert.deepEqual(createMessageUpdates(fauxAssistantMessage([])), []);
});

for (const isError of [false, true]) {
	test(`message conversion preserves tool result content and ${isError ? "failed" : "completed"} status`, () => {
		const message = {
			role: "toolResult" as const,
			toolCallId: "original",
			toolName: "read",
			isError,
			timestamp: 0,
			content: [
				{ type: "text" as const, text: "output" },
				{ type: "image" as const, mimeType: "image/png", data: "AQ==" },
			],
		};
		const original = structuredClone(message);
		assert.deepEqual(createMessageUpdates(message), [
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "original",
				status: isError ? "failed" : "completed",
				content: message.content.map((content) => ({
					type: "content",
					content,
				})),
				rawOutput: message.content,
			},
		]);
		assert.deepEqual(message, original);
	});
}

function assistantEntry(id: number, text: string): EntryRecord {
	return {
		id: id as EntryId,
		conversationId: ROOT_CONVERSATION_ID,
		kind: "pi.assistant",
		model: [
			fauxAssistantMessage([
				{ type: "thinking", thinking: "" },
				{ type: "text", text },
			]),
		],
	};
}

function view(
	entries: EntryRecord[] = [],
	live: LiveState = {},
): ConversationView {
	return {
		conversation: { id: ROOT_CONVERSATION_ID },
		entries,
		docs: { "pi.live": live },
	};
}

function streaming(
	text: string,
	thinking = "",
	task = 1,
	attempt = 0,
): LiveState {
	return {
		run: { taskId: task as TaskId, inputs: [], turns: 0 },
		generation: {
			attempt,
			message: fauxAssistantMessage([
				{ type: "thinking", thinking },
				{ type: "text", text },
			]) as NonNullable<LiveState["generation"]>["message"],
		},
	};
}

test("view translation catches up text and thought without duplicating settlement or baseline", async () => {
	const { EventBridge } = await import("../dist/events.js");
	const updates: SessionUpdate[] = [];
	const old = assistantEntry(1, "old");
	const bridge = new EventBridge([old], async (update) => {
		updates.push(update);
	});
	await bridge.accept(view([old], streaming("he", "think")));
	await bridge.accept(view([old], streaming("hello", "thinking")));
	const message = streaming("hello!", "thinking").generation?.message;
	assert.ok(message);
	const entry = { ...assistantEntry(2, ""), model: [message] };
	await bridge.accept(view([old, entry]));
	await bridge.accept(view([old, entry]));
	assert.equal(
		updates
			.filter((u) => u.sessionUpdate === "agent_message_chunk")
			.map(readText)
			.join(""),
		"hello!",
	);
	assert.equal(
		updates
			.filter((u) => u.sessionUpdate === "agent_thought_chunk")
			.map((u) =>
				"content" in u && u.content?.type === "text" ? u.content.text : "",
			)
			.join(""),
		"thinking",
	);
	for (const kind of ["agent_message_chunk", "agent_thought_chunk"]) {
		const ids = updates
			.filter((u) => u.sessionUpdate === kind)
			.map((u) => ("messageId" in u ? u.messageId : undefined));
		assert.equal(new Set(ids).size, 1);
		assert.match(String(ids[0]), /^[0-9a-f-]{36}$/);
	}
	assert.notEqual(
		"messageId" in updates[0] && updates[0].messageId,
		"messageId" in updates[1] && updates[1].messageId,
	);
});

test("view translation rotates block IDs at generation, attempt and committed-message boundaries", async () => {
	const { EventBridge } = await import("../dist/events.js");
	const updates: SessionUpdate[] = [];
	const bridge = new EventBridge([], async (update) => {
		updates.push(update);
	});
	await bridge.accept(view([], streaming("same")));
	await bridge.accept(view([], streaming("same", "", 1, 1)));
	await bridge.accept(view([assistantEntry(1, "same")]));
	await bridge.accept(
		view([assistantEntry(1, "same")], streaming("same", "", 2)),
	);
	await bridge.accept(
		view([assistantEntry(1, "same"), assistantEntry(2, "same")]),
	);
	await bridge.accept(
		view([
			assistantEntry(1, "same"),
			assistantEntry(2, "same"),
			assistantEntry(3, "same"),
		]),
	);
	const chunks = updates.filter(
		(u) => u.sessionUpdate === "agent_message_chunk",
	);
	assert.equal(chunks.map(readText).join(""), "samesamesamesame");
	assert.equal(new Set(chunks.map((u) => u.messageId)).size, 4);
});

test("view translation ignores empty content and non-assistant entries", async () => {
	const { EventBridge } = await import("../dist/events.js");
	const updates: SessionUpdate[] = [];
	const bridge = new EventBridge([], async (update) => {
		updates.push(update);
	});
	await bridge.accept(view([], streaming("")));
	await bridge.accept(
		view([
			{
				...assistantEntry(1, ""),
				model: [{ role: "user", content: "private", timestamp: 0 }],
			},
		]),
	);
	assert.deepEqual(updates, []);
});

for (const [name, kind] of [
	["bash", "execute"],
	["read", "read"],
	["write", "edit"],
	["edit", "edit"],
	["unknown", "other"],
	["codemode", "other"],
] as const) {
	for (const isError of [false, true]) {
		test(`view preserves ${name} inputs, output, images and ${isError ? "failed" : "completed"} settlement`, async () => {
			const { EventBridge } = await import("../dist/events.js");
			const { fauxToolCall } = await import(
				"@earendil-works/pi-ai/providers/faux"
			);
			const updates: SessionUpdate[] = [];
			const bridge = new EventBridge([], async (update) => {
				updates.push(update);
			});
			const call = {
				...assistantEntry(1, ""),
				model: [
					fauxAssistantMessage([
						fauxToolCall(name, { path: "file" }, { id: "stable" }),
					]),
				],
			};
			const slot = {
				callId: "stable",
				name: name,
				status: "running" as const,
				output: "abc",
			};
			await bridge.accept(view([call], { tools: [slot] }));
			await bridge.accept(
				view([call], { tools: [{ ...slot, output: "bcd" }] }),
			);
			const content = [
				{ type: "text" as const, text: "final" },
				{ type: "image" as const, mimeType: "image/png", data: "AQ==" },
			];
			const result = {
				...assistantEntry(2, ""),
				model: [
					{
						role: "toolResult" as const,
						toolCallId: "stable",
						toolName: name,
						isError,
						timestamp: 0,
						content,
					},
				],
			};
			await bridge.accept(
				view([call, result], {
					tools: [{ ...slot, status: "done", entry: result.id }],
				}),
			);
			await bridge.accept(view([call, result]));
			assert.deepEqual(updates.map(readStatus), [
				"in_progress",
				"in_progress",
				"in_progress",
				isError ? "failed" : "completed",
			]);
			assert.deepEqual(updates.map(readToolId), [
				"stable",
				"stable",
				"stable",
				"stable",
			]);
			assert.equal(requireToolUpdate(updates[0]).kind, kind);
			assert.deepEqual(requireToolUpdate(updates[0]).rawInput, {
				path: "file",
			});
			assert.equal(readToolText(updates[2]), "bcd");
			assert.deepEqual(requireToolUpdate(updates[3]).rawOutput, content);
		});
	}
}

test("view presents only codemode parent progress and ignores nested tool slots", async () => {
	const { EventBridge } = await import("../dist/events.js");
	const { fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const updates: SessionUpdate[] = [];
	const bridge = new EventBridge([], async (update) => {
		updates.push(update);
	});
	const args = { code: 'text(await tools.read({ path: "file" }));' };
	const call = {
		...assistantEntry(1, ""),
		model: [
			fauxAssistantMessage(fauxToolCall("codemode", args, { id: "parent" })),
		],
	};
	const tools: LiveState["tools"] = [
		{
			callId: "parent",
			name: "codemode",
			status: "running",
			output: "upstream parent progress",
			details: { calls: [{ name: "read", status: "running" }] },
		},
	];
	const child: NonNullable<LiveState["nestedTools"]>[number] = {
		callId: "parent/1",
		parentCallId: "parent",
		parentTaskId: 1 as TaskId,
		taskId: 2 as TaskId,
		name: "read",
		arguments: { path: "file" },
		status: "running",
		output: "nested output",
	};
	await bridge.accept(view([call], { tools, nestedTools: [child] }));
	await bridge.accept(
		view([call], {
			tools,
			nestedTools: [{ ...child, status: "done", summary: { isError: false } }],
		}),
	);
	await bridge.accept(view([call], { tools }));
	assert.deepEqual(updates, [
		{
			sessionUpdate: "tool_call",
			toolCallId: "parent",
			title: "codemode",
			kind: "other",
			status: "in_progress",
			rawInput: args,
		},
		{
			sessionUpdate: "tool_call_update",
			toolCallId: "parent",
			status: "in_progress",
			content: [
				{ type: "content", content: { type: "text", text: tools[0]?.output } },
			],
		},
	]);
});

test("coalesced view reconstructs completed calls/results but ignores historical baseline", async () => {
	const { EventBridge } = await import("../dist/events.js");
	const { fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const updates: SessionUpdate[] = [];
	const old = assistantEntry(1, "old");
	const bridge = new EventBridge([old], async (update) => {
		updates.push(update);
	});
	const call = {
		...assistantEntry(2, ""),
		model: [
			fauxAssistantMessage([
				fauxToolCall("read", { path: "x" }, { id: "fast" }),
			]),
		],
	};
	const result = {
		...assistantEntry(3, ""),
		model: [
			{
				role: "toolResult" as const,
				toolCallId: "fast",
				toolName: "read",
				isError: false,
				timestamp: 0,
				content: [],
			},
		],
	};
	await bridge.accept(view([old, call, result]));
	assert.deepEqual(updates.map(readStatus), ["in_progress", "completed"]);
});

test("faulted live slot fails once and retains running output without fabricating a result", async () => {
	const { EventBridge } = await import("../dist/events.js");
	const updates: SessionUpdate[] = [];
	const bridge = new EventBridge([], async (update) => {
		updates.push(update);
	});
	const slot = {
		callId: "fault",
		name: "bash",
		status: "running" as const,
		output: "partial",
	};
	await bridge.accept(view([], { tools: [slot] }));
	await bridge.accept(view([], { tools: [{ ...slot, status: "done" }] }));
	await bridge.accept(view([], { tools: [{ ...slot, status: "done" }] }));
	assert.deepEqual(updates.map(readStatus), [
		"in_progress",
		"in_progress",
		"failed",
	]);
	assert.equal(readToolText(updates[2]), "partial");
	assert.equal(requireToolUpdate(updates[2]).rawOutput, undefined);
});

test("Watch coalescing still settles a fault after backpressured delivery skips its done slot", {
	timeout: 5000,
}, async (t) => {
	const { Watch } = await import("@earendil-works/chord/watch");
	const { copyJson } = await import("@earendil-works/chord/json");
	const { BACKGROUND_CONTEXT: context } = await import(
		"@earendil-works/chord/context"
	);
	const { EventBridge } = await import("../dist/events.js");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	const updates: SessionUpdate[] = [];
	const bridge = new EventBridge([], async (update) => {
		updates.push(update);
		if (updates.length !== 1) return;
		entered.resolve();
		await release.promise;
	});
	const watch = new Watch(
		view(),
		() => {},
		(error) => delivered.reject(error),
	);
	t.after(async () => {
		release.resolve();
		await watch.stop();
	});
	const seen: ConversationView[] = [];
	watch.start(async (call) => {
		assert.equal(call.kind, "value");
		if (call.kind !== "value") return;
		seen.push(call.value);
		await bridge.accept(call.value);
		if (seen.length === 2) delivered.resolve();
	});
	const advance = (value: ConversationView) =>
		watch.advance(
			{ kind: "value", value, ops: [["r", copyJson(value)]], retired: false },
			context,
		);
	const slot = {
		callId: "fault",
		name: "bash",
		status: "running" as const,
		output: "partial",
	};
	const running = view([], { tools: [slot] });
	const idle = view();
	advance(running);
	await entered.promise;
	advance(
		view([], { tools: [{ callId: "fault", name: "bash", status: "done" }] }),
	);
	advance(idle);
	release.resolve();
	await delivered.promise;
	assert.deepEqual(seen, [running, idle]);
	assert.deepEqual(updates.map(readStatus), [
		"in_progress",
		"in_progress",
		"failed",
	]);
	assert.equal(readToolText(updates[2]), "partial");
	assert.equal(requireToolUpdate(updates[2]).rawOutput, undefined);
	await bridge.accept(idle);
	assert.equal(updates.length, 3);
});

test("missing slots settle faults at the next round without failing its pending or running calls", async () => {
	const { EventBridge } = await import("../dist/events.js");
	const { fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const updates: SessionUpdate[] = [];
	const bridge = new EventBridge([], async (update) => {
		updates.push(update);
	});
	const first = {
		callId: "first",
		name: "bash",
		status: "running" as const,
		output: "partial",
	};
	await bridge.accept(view([], { tools: [first] }));
	const call = {
		...assistantEntry(1, ""),
		model: [
			fauxAssistantMessage(
				fauxToolCall("bash", { command: "pwd" }, { id: "next" }),
			),
		],
	};
	const pending = { callId: "next", name: "bash", status: "pending" as const };
	await bridge.accept(view([call], { tools: [pending] }));
	assert.deepEqual(updates.map(readStatus), [
		"in_progress",
		"in_progress",
		"in_progress",
		"failed",
	]);
	assert.equal(readToolId(updates[3]), "first");
	await bridge.accept(
		view([call], { tools: [{ ...pending, status: "running" }] }),
	);
	await bridge.accept(view([call], { tools: [pending] }));
	assert.equal(updates.length, 4);
	await bridge.accept(view([call]));
	assert.equal(updates.length, 5);
	assert.equal(readToolId(updates[4]), "next");
	assert.equal(readStatus(updates[4]), "failed");
});

test("history projects SDK active entries in order with thoughts, native results and reset semantics", async () => {
	const { createHistoryUpdates } = await import("../dist/events.js");
	const { Runtime } = await import("../dist/runtime.js");
	const { createModels } = await import("@earendil-works/pi-ai/models");
	const { BACKGROUND_CONTEXT: context } = await import(
		"@earendil-works/chord/context"
	);
	const { tmpdir } = await import("node:os");
	const { fauxText, fauxThinking, fauxToolCall } = await import(
		"@earendil-works/pi-ai/providers/faux"
	);
	const { UserEntry, AssistantEntry, ToolResultEntry } = await import(
		"@earendil-works/pi-durable"
	);
	const runtime = await Runtime.open(createModels(), {
		provider: "unused",
		modelId: "unused",
	});
	const session = await runtime.createSession(tmpdir());
	try {
		const conversation = session.conversation;
		await conversation.commit(async (tx) => {
			await tx.appendEntry(UserEntry, conversation.id, {
				model: [{ role: "user", content: "old user", timestamp: 0 }],
			});
		}, context);
		await conversation.reset("handoff", context);
		await conversation.commit(async (tx) => {
			await tx.appendEntry(AssistantEntry, conversation.id, {
				model: [
					fauxAssistantMessage([
						fauxThinking("thought"),
						fauxText("before"),
						fauxToolCall("read", { path: "image.png" }, { id: "original" }),
						fauxText("after"),
					]),
				],
			});
			await tx.appendEntry(ToolResultEntry, conversation.id, {
				data: { diagnostics: [] },
				model: [
					{
						role: "toolResult",
						toolCallId: "original",
						toolName: "read",
						isError: true,
						timestamp: 0,
						content: [
							{ type: "text", text: "failed" },
							{ type: "image", mimeType: "image/png", data: "AQ==" },
						],
					},
				],
			});
			await tx.appendEntry(conversation.id, {
				kind: "internal.checkpoint",
				model: [{ role: "user", content: "INTERNAL", timestamp: 0 }],
			});
		}, context);
		const updates = createHistoryUpdates(await conversation.context(context));
		assert.deepEqual(
			updates.map((update) => update.sessionUpdate),
			[
				"user_message_chunk",
				"agent_thought_chunk",
				"agent_message_chunk",
				"tool_call",
				"agent_message_chunk",
				"tool_call_update",
			],
		);
		assert.deepEqual(
			updates
				.filter(
					(update) =>
						"content" in update && update.content && "text" in update.content,
				)
				.map((update) =>
					"content" in update && update.content && "text" in update.content
						? update.content.text
						: "",
				),
			["handoff", "thought", "before", "after"],
		);
		const call = requireToolUpdate(updates[3]);
		assert.equal(call.toolCallId, "original");
		assert.deepEqual(call.rawInput, { path: "image.png" });
		const result = requireToolUpdate(updates[5]);
		assert.equal(result.status, "failed");
		assert.ok(
			result.content?.some(
				(block) => block.type === "content" && block.content.type === "image",
			),
		);
		assert.ok(!JSON.stringify(updates).includes("old user"));
		assert.ok(!JSON.stringify(updates).includes("INTERNAL"));
	} finally {
		await session.close();
		await runtime.close();
	}
});

test("history uses SDK-derived missing tool results and omits provider diagnostic messages", async () => {
	const { createHistoryUpdates } = await import("../dist/events.js");
	const { Runtime } = await import("../dist/runtime.js");
	const { createModels } = await import("@earendil-works/pi-ai/models");
	const { BACKGROUND_CONTEXT: context } = await import(
		"@earendil-works/chord/context"
	);
	const { tmpdir } = await import("node:os");
	const { fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const { AssistantEntry } = await import("@earendil-works/pi-durable");
	const runtime = await Runtime.open(createModels(), {
		provider: "unused",
		modelId: "unused",
	});
	const session = await runtime.createSession(tmpdir());
	try {
		const conversation = session.conversation;
		await conversation.commit(async (tx) => {
			await tx.appendEntry(AssistantEntry, conversation.id, {
				model: [
					fauxAssistantMessage(
						fauxToolCall(
							"bash",
							{ command: "false" },
							{ id: "missing-result" },
						),
						{ stopReason: "toolUse" },
					),
				],
			});
			await tx.appendEntry(AssistantEntry, conversation.id, {
				model: [
					fauxAssistantMessage(
						fauxToolCall("bash", {}, { id: "hidden-result" }),
						{ stopReason: "toolUse" },
					),
				],
			});
			await tx.appendEntry(conversation.id, {
				kind: "internal.result",
				model: [
					{
						role: "toolResult",
						toolCallId: "hidden-result",
						toolName: "bash",
						isError: false,
						timestamp: 0,
						content: [{ type: "text", text: "PRIVATE_INTERNAL_RESULT" }],
					},
				],
			});
			await tx.appendEntry(AssistantEntry, conversation.id, {
				model: [
					fauxAssistantMessage("PRIVATE_PROVIDER_DIAGNOSTIC", {
						stopReason: "error",
					}),
				],
			});
		}, context);
		const updates = createHistoryUpdates(await conversation.context(context));
		assert.deepEqual(
			updates.map((update) => update.sessionUpdate),
			["tool_call", "tool_call_update", "tool_call"],
		);
		assert.equal(readStatus(updates[1]), "failed");
		assert.ok(JSON.stringify(updates).includes("Tool result unavailable"));
		assert.doesNotMatch(
			JSON.stringify(updates),
			/PRIVATE_PROVIDER_DIAGNOSTIC|PRIVATE_INTERNAL_RESULT/,
		);
	} finally {
		await session.close();
		await runtime.close();
	}
});

test("history honors SDK replacement and omission edits after persistent reload", async (t) => {
	const { persistenceFixture } = await import("./helpers/persistence.ts");
	const { createHistoryUpdates } = await import("../dist/events.js");
	const { BACKGROUND_CONTEXT: context } = await import(
		"@earendil-works/chord/context"
	);
	const { UserEntry, AssistantEntry, ToolResultEntry } = await import(
		"@earendil-works/pi-durable"
	);
	const { fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const f = await persistenceFixture(t);
	const first = await f.runtime();
	const session = await f.track(first.createSession(f.cwd));
	const conversation = session.conversation;
	await conversation.commit(async (tx) => {
		await tx.appendEntry(AssistantEntry, conversation.id, {
			model: [
				fauxAssistantMessage(
					fauxToolCall("bash", { command: "false" }, { id: "ABORTED_CALL" }),
					{ stopReason: "aborted" },
				),
			],
		});
		const user = await tx.appendEntry(UserEntry, conversation.id, {
			model: [{ role: "user", content: "OMITTED_USER", timestamp: 0 }],
		});
		const answer = await tx.appendEntry(AssistantEntry, conversation.id, {
			model: [fauxAssistantMessage("REPLACED_ANSWER")],
		});
		await tx.appendEntry(AssistantEntry, conversation.id, {
			model: [
				fauxAssistantMessage(
					fauxToolCall("bash", { command: "true" }, { id: "edited-result" }),
					{ stopReason: "toolUse" },
				),
			],
		});
		const result = await tx.appendEntry(ToolResultEntry, conversation.id, {
			data: { diagnostics: [] },
			model: [
				{
					role: "toolResult",
					toolCallId: "edited-result",
					toolName: "bash",
					isError: false,
					timestamp: 0,
					content: [{ type: "text", text: "OMITTED_RESULT" }],
				},
			],
		});
		await tx.appendEntry(conversation.id, {
			kind: "internal.edit",
			edits: [
				{ target: user.id, action: "omit" },
				{
					target: answer.id,
					action: "replace",
					messages: [fauxAssistantMessage("superseded answer")],
				},
				{ target: result.id, action: "omit" },
			],
		});
		await tx.appendEntry(conversation.id, {
			kind: "internal.edit",
			edits: [
				{
					target: answer.id,
					action: "replace",
					messages: [fauxAssistantMessage("visible answer")],
				},
			],
		});
	}, context);
	const id = session.id;
	assert.ok(id);
	await session.close();
	await first.close();
	const next = await f.runtime();
	const loadedSession = await f.track(next.loadSession(id, f.cwd));
	const loaded = loadedSession.conversation;
	const updates = createHistoryUpdates(await loaded.context(context));
	assert.deepEqual(
		updates.map((update) => update.sessionUpdate),
		["agent_message_chunk", "tool_call", "tool_call_update"],
	);
	assert.equal(readText(updates[0]), "visible answer");
	assert.equal(readStatus(updates[2]), "failed");
	assert.match(readToolText(updates[2]), /Tool result unavailable/);
	assert.doesNotMatch(
		JSON.stringify(updates),
		/OMITTED|REPLACED|superseded|ABORTED/,
	);
});

test("history keeps SDK missing results scoped to each assistant when tool call IDs repeat", async (t) => {
	const { persistenceFixture } = await import("./helpers/persistence.ts");
	const { createHistoryUpdates } = await import("../dist/events.js");
	const { BACKGROUND_CONTEXT: context } = await import(
		"@earendil-works/chord/context"
	);
	const { AssistantEntry, ToolResultEntry } = await import(
		"@earendil-works/pi-durable"
	);
	const { fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const f = await persistenceFixture(t);
	const first = await f.runtime();
	const session = await f.track(first.createSession(f.cwd));
	const conversation = session.conversation;
	await conversation.commit(async (tx) => {
		for (const index of [0, 1, 2]) {
			await tx.appendEntry(AssistantEntry, conversation.id, {
				model: [
					fauxAssistantMessage(
						fauxToolCall("bash", { command: "true" }, { id: "reused" }),
						{ stopReason: "toolUse" },
					),
				],
			});
			if (index !== 1) continue;
			await tx.appendEntry(ToolResultEntry, conversation.id, {
				data: { diagnostics: [] },
				model: [
					{
						role: "toolResult",
						toolCallId: "reused",
						toolName: "bash",
						isError: false,
						timestamp: 0,
						content: [{ type: "text", text: "committed result" }],
					},
				],
			});
		}
	}, context);
	const id = session.id;
	assert.ok(id);
	await session.close();
	await first.close();
	const next = await f.runtime();
	const loadedSession = await f.track(next.loadSession(id, f.cwd));
	const loaded = loadedSession.conversation;
	const view = await loaded.context(context);
	assert.deepEqual(
		view.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => message.isError),
		[true, false, true],
	);
	const updates = createHistoryUpdates(await loaded.context(context));
	assert.deepEqual(updates.map(readStatus), [
		"in_progress",
		"failed",
		"in_progress",
		"completed",
		"in_progress",
		"failed",
	]);
	assert.match(readToolText(updates[1]), /Tool result unavailable/);
	assert.equal(readToolText(updates[3]), "committed result");
	assert.match(readToolText(updates[5]), /Tool result unavailable/);
	assert.deepEqual(
		createHistoryUpdates(view, new Set(["reused"])).map(readStatus),
		["in_progress", "failed", "in_progress", "completed", "in_progress"],
		"pending live IDs defer only the last assistant's derived result, not earlier reused IDs or committed results",
	);
});
