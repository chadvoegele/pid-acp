import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { JsonRpcMessage, JsonRpcRequest } from "@earendil-works/pi-mcp";

const log = process.env.MCP_FIXTURE_LOG;
function record(event: string) {
	if (log)
		appendFileSync(
			log,
			`${JSON.stringify({ event, pid: process.pid, cwd: process.cwd() })}\n`,
		);
}
function send(message: JsonRpcMessage) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}
function result(request: JsonRpcRequest, value: unknown) {
	send({ jsonrpc: "2.0", id: request.id, result: value });
}
record("start");
if (process.env.MCP_FIXTURE_STDERR === "1")
	process.stderr.write("PRIVATE_STDIO_STDERR\n");
if (process.env.MCP_FIXTURE_HUNG === "1") {
	process.on("SIGTERM", () => record("ignored-sigterm"));
	setInterval(() => {}, 1000);
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const message = JSON.parse(line) as JsonRpcMessage;
	if (!("method" in message)) return;
	if (message.method === "notifications/cancelled") {
		record("cancelled");
		return;
	}
	if (!("id" in message)) return;
	if (message.method === "initialize") {
		result(message, {
			protocolVersion: "2025-11-25",
			capabilities: { tools: {} },
			serverInfo: { name: "stdio-fixture", version: "1" },
		});
	} else if (message.method === "tools/list") {
		record("list");
		const names = (process.env.MCP_FIXTURE_TOOLS ?? "value,hold")
			.split(",")
			.filter(Boolean);
		const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
		const index = cursor === undefined ? 0 : Number(cursor);
		const size = Number(process.env.MCP_FIXTURE_PAGE_SIZE ?? names.length);
		result(message, {
			tools: names.slice(index, index + size).map((name) => ({
				name,
				inputSchema:
					name === "value" && process.env.MCP_FIXTURE_REQUIRED === "1"
						? {
								type: "object",
								properties: { current: { type: "integer", minimum: 1 } },
								required: ["current"],
								additionalProperties: false,
							}
						: { type: "object", properties: {} },
			})),
			...(index + size < names.length
				? { nextCursor: String(index + size) }
				: {}),
		});
	} else if (message.method === "tools/call") {
		const { name } = message.params as { name: string };
		record(`call:${name}`);
		if (name === "hold" || name === "mutate_hold") return;
		result(message, {
			content: [],
			structuredContent: {
				pid: process.pid,
				cwd: process.cwd(),
				token: process.env.MCP_FIXTURE_TOKEN ?? "stdio-fixture",
			},
		});
	}
});
input.on("close", () => {
	record("close");
});
