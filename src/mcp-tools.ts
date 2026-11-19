import type { JsonValue } from "@earendil-works/chord/json";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import {
	limitMcpContent,
	normalizeMcpInputSchema,
	toLlmContent,
	type CallToolResult,
	type ContentBlock,
	type Tool,
} from "@earendil-works/pi-mcp";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";

export const MCP_ENVELOPE_SCHEMA = {
	type: "object",
	properties: {
		content: { type: "array", items: { type: "object" } },
		structuredContent: {},
		isError: { type: "boolean" },
	},
	required: ["content"],
	additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectInvalidMcpValue(): never {
	throw new Error(
		"MCP schema or result is invalid. Check the server's current tools.",
	);
}

export type McpDescriptor = Readonly<{
	original: string;
	description: string;
	parameters: object;
}>;

export function describeMcpTool(tool: Tool): McpDescriptor {
	if (
		!tool.name ||
		(tool.description !== undefined && typeof tool.description !== "string")
	)
		rejectInvalidMcpValue();
	const parameters = normalizeMcpInputSchema(tool.inputSchema);
	if (parameters.type !== "object") rejectInvalidMcpValue();
	compile(parameters, { formats });
	return {
		original: tool.name,
		description: `${tool.description ?? tool.name}\nReturns { content, structuredContent?, isError? }; check isError even when the call resolves.${tool.outputSchema === undefined ? "" : `\nServer structuredContent schema (documentation only): ${JSON.stringify(tool.outputSchema)}`}`,
		parameters,
	};
}

function stripMetadata(block: ContentBlock): ContentBlock {
	if (!isRecord(block)) rejectInvalidMcpValue();
	const { _meta: _ignored, ...clean } = block;
	if (clean.type === "resource") {
		if (
			!isRecord(clean.resource) ||
			typeof clean.resource.uri !== "string" ||
			(typeof clean.resource.text !== "string" &&
				typeof clean.resource.blob !== "string")
		)
			rejectInvalidMcpValue();
		const { _meta: _resourceMeta, ...resource } = clean.resource;
		return { ...clean, resource } as ContentBlock;
	}
	if (clean.type === "text" && typeof clean.text === "string")
		return clean as ContentBlock;
	if (
		(clean.type === "image" || clean.type === "audio") &&
		typeof clean.data === "string" &&
		typeof clean.mimeType === "string"
	)
		return clean as ContentBlock;
	if (
		clean.type === "resource_link" &&
		typeof clean.uri === "string" &&
		typeof clean.name === "string"
	)
		return clean as ContentBlock;
	return rejectInvalidMcpValue();
}

export async function convertMcpResult(
	result: CallToolResult,
): Promise<ToolExecutionResult> {
	if (result.isError !== undefined && typeof result.isError !== "boolean")
		rejectInvalidMcpValue();
	const envelope = {
		content: result.content.map(stripMetadata),
		...(Object.hasOwn(result, "structuredContent")
			? { structuredContent: result.structuredContent }
			: {}),
		...(result.isError === undefined ? {} : { isError: result.isError }),
	};
	const { content: output } = await limitMcpContent(toLlmContent(envelope));
	return {
		output,
		structuredOutput: envelope as unknown as JsonValue,
		...(result.isError === undefined ? {} : { isError: result.isError }),
	};
}
