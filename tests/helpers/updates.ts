import assert from "node:assert/strict";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

export function readText(update: SessionUpdate) {
	return update.sessionUpdate === "agent_message_chunk" &&
		update.content.type === "text"
		? update.content.text
		: "";
}
export function readStatus(update: SessionUpdate) {
	return "status" in update ? update.status : undefined;
}
export function readToolId(update: SessionUpdate) {
	return "toolCallId" in update ? update.toolCallId : undefined;
}
export function requireToolUpdate(update: SessionUpdate) {
	assert.ok(
		update.sessionUpdate === "tool_call" ||
			update.sessionUpdate === "tool_call_update",
	);
	return update;
}
export function readToolText(update: SessionUpdate) {
	const content = requireToolUpdate(update).content?.[0];
	assert.ok(content?.type === "content" && content.content.type === "text");
	return content.content.text;
}
export interface WireMessage {
	method?: string;
	params?: { update?: SessionUpdate };
	result?: { stopReason?: string };
}
