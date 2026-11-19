import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type {
	JsonRpcMessage,
	JsonRpcRequest,
	Tool,
	ServerCapabilities,
} from "@earendil-works/pi-mcp";
import { fixtureTool } from "./mcp-fixture.ts";

export async function startMcpHttpFixture(
	token = "http-fixture",
	options: {
		capabilities?: ServerCapabilities;
		pages?: { tools: Tool[]; nextCursor?: string }[];
	} = {},
) {
	let initializeFailure = false;
	const requests: {
		session: string;
		message: JsonRpcRequest;
		authorization?: string;
	}[] = [];
	const cancellations: string[] = [];
	const deleted: string[] = [];
	const streams = new Map<string, ServerResponse>();
	const held = new Map<
		string,
		{ response: ServerResponse; request: JsonRpcRequest }
	>();
	const resumptions: string[] = [];
	const resumed = new Map<string, JsonRpcMessage>();
	let tools: Tool[] = [
		"value",
		"hold",
		"null",
		"array",
		"error",
		"protocol",
		"resume",
	].map(fixtureTool);
	function event(
		response: ServerResponse,
		message: JsonRpcMessage,
		id?: string,
	) {
		response.write(
			`${id ? `id: ${id}\n` : ""}event: message\ndata: ${JSON.stringify(message)}\n\n`,
		);
	}
	function result(
		response: ServerResponse,
		request: JsonRpcRequest,
		value: unknown,
		session: string,
	) {
		response.writeHead(200, {
			"content-type": "application/json",
			"mcp-session-id": session,
		});
		response.end(
			JSON.stringify({ jsonrpc: "2.0", id: request.id, result: value }),
		);
	}
	const server = createServer(async (request, response) => {
		const session = String(request.headers["mcp-session-id"] ?? randomUUID());
		if (request.method === "DELETE") {
			deleted.push(session);
			streams.get(session)?.end();
			streams.delete(session);
			response.writeHead(200).end();
			return;
		}
		if (request.method === "GET") {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.flushHeaders();
			const last = request.headers["last-event-id"];
			if (typeof last === "string") {
				resumptions.push(last);
				const message = resumed.get(last);
				if (message) event(response, message);
				response.end();
			} else {
				streams.set(session, response);
				response.on("close", () => {
					if (streams.get(session) === response) streams.delete(session);
				});
			}
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const message = JSON.parse(body) as JsonRpcMessage;
		if (!("method" in message) || !("id" in message)) {
			if ("method" in message && message.method === "notifications/cancelled")
				cancellations.push(session);
			response.writeHead(202).end();
			return;
		}
		requests.push({
			session,
			message,
			authorization: request.headers.authorization,
		});
		if (message.method === "initialize") {
			if (initializeFailure) {
				response.writeHead(503).end("PRIVATE_INITIALIZE_BODY");
				return;
			}
			result(
				response,
				message,
				{
					protocolVersion: "2025-11-25",
					capabilities: options.capabilities ?? {
						tools: { listChanged: true },
					},
					serverInfo: { name: "http-fixture", version: "1" },
				},
				session,
			);
			return;
		}
		if (message.method === "tools/list") {
			const cursor = (message.params as { cursor?: string } | undefined)
				?.cursor;
			const index = cursor === undefined ? 0 : Number(cursor);
			result(
				response,
				message,
				options.pages?.[index] ?? {
					tools: tools.slice(index, index + 2),
					...(index + 2 < tools.length
						? { nextCursor: String(index + 2) }
						: {}),
				},
				session,
			);
			return;
		}
		const params = message.params as {
			name: string;
			_meta?: { progressToken?: string | number };
		};
		if (params.name === "hold") {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.flushHeaders();
			held.set(session, { response, request: message });
			event(response, {
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: {
					progressToken: params._meta?.progressToken,
					progress: 1,
					total: 2,
					message: "PRIVATE_PROGRESS_BODY",
				},
			});
			return;
		}
		if (params.name === "resume") {
			const id = randomUUID();
			resumed.set(id, {
				jsonrpc: "2.0",
				id: message.id,
				result: { content: [], structuredContent: "resumed-without-repost" },
			});
			response.writeHead(200, { "content-type": "text/event-stream" });
			event(
				response,
				{
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken: params._meta?.progressToken, progress: 1 },
				},
				id,
			);
			response.end();
			return;
		}
		if (params.name === "protocol") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32000, message: "PRIVATE_PROTOCOL_BODY" },
				}),
			);
			return;
		}
		result(
			response,
			message,
			{
				content: [],
				structuredContent:
					params.name === "null"
						? null
						: params.name === "array"
							? [1, null, { _meta: "application" }]
							: { token, session },
				...(params.name === "error" ? { isError: true } : {}),
				_meta: { secret: "PRIVATE_PROTOCOL_META" },
			},
			session,
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture address");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		requests,
		cancellations,
		deleted,
		resumptions,
		progress(session: string, progress: number) {
			const pending = held.get(session);
			if (!pending) throw new Error("No held fixture call");
			const params = pending.request.params as {
				_meta?: { progressToken?: string | number };
			};
			event(pending.response, {
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: {
					progressToken: params._meta?.progressToken,
					progress,
					message: "PRIVATE_PROGRESS_BODY",
				},
			});
		},
		setInitializeFailure(failed: boolean) {
			initializeFailure = failed;
		},
		changed() {
			for (const stream of streams.values())
				event(stream, {
					jsonrpc: "2.0",
					method: "notifications/tools/list_changed",
				});
		},
		setTools(next: Tool[]) {
			tools = next;
		},
		release(session: string) {
			const pending = held.get(session);
			if (!pending) throw new Error("No held fixture call");
			event(pending.response, {
				jsonrpc: "2.0",
				id: pending.request.id,
				result: { content: [], structuredContent: "held-complete" },
			});
			pending.response.end();
			held.delete(session);
		},
		async close() {
			for (const stream of streams.values()) stream.end();
			for (const pending of held.values()) pending.response.end();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
