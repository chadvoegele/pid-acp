import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type RequestListener,
	type ServerResponse,
} from "node:http";
import type { TestContext } from "node:test";
import { fixtureTool } from "./mcp-fixture.ts";

export const clientId = "fixture-public-client";
export const privateOAuthMarker = /PRIVATE_OAUTH_/;
const authorizationCode = "PRIVATE_OAUTH_CODE";
export const registeredClient = {
	client_id: "fixture-registered-client",
	client_secret: "PRIVATE_OAUTH_REGISTERED_SECRET",
	token_endpoint_auth_method: "client_secret_post",
	fixture_extension: { metadata: "keep" },
};

export async function listenOAuthFixture(
	t: TestContext,
	listener: RequestListener,
) {
	const server = createServer(listener).listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No fixture address");
	return `http://127.0.0.1:${address.port}`;
}

function sendJson(response: ServerResponse, value: unknown, status = 200) {
	return response
		.writeHead(status, { "content-type": "application/json" })
		.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage) {
	request.setEncoding("utf8");
	let body = "";
	for await (const chunk of request) body += chunk;
	return body;
}

export async function startMcpOAuthFixture(
	t: TestContext,
	mode: "explicit" | "dynamic" = "explicit",
) {
	const dynamic = mode === "dynamic";
	const expectedClient = dynamic ? registeredClient.client_id : clientId;
	let registrations = 0;
	let registeredRedirect: string | undefined;
	let generation = 0;
	let accessValid = false;
	let pkce: string | null = null;
	let codeUsed = false;
	const tokens = () => ({
		access_token: `PRIVATE_OAUTH_ACCESS_${generation}`,
		refresh_token: `PRIVATE_OAUTH_REFRESH_${generation}`,
		token_type: "Bearer",
		expires_in: 3600,
	});
	function issue() {
		generation++;
		accessValid = true;
		return tokens();
	}
	const requests: {
		method: string;
		accepted: boolean;
		session: string;
		peer?: string;
	}[] = [];
	const deleted: string[] = [];
	let refreshes = 0;
	let exchanges = 0;
	let effects = 0;
	const behavior: {
		refresh?: "invalid_grant" | "invalid_client" | "unauthorized_client";
		resourceMetadataUrl?: string;
		tokenRedirect?: { target: string; status: number };
		pause?: Promise<void>;
		pauseToolChallenge?: Promise<void>;
		failCall?: boolean;
	} = {};
	async function register(request: IncomingMessage, response: ServerResponse) {
		const { redirect_uris } = JSON.parse(await readBody(request));
		const redirect = URL.parse(redirect_uris?.[0] ?? "");
		if (
			!redirect ||
			redirect.protocol !== "http:" ||
			redirect.hostname !== "127.0.0.1" ||
			request.method !== "POST"
		)
			return response.writeHead(400).end();
		registeredRedirect = redirect.href;
		return sendJson(response, { ...registeredClient, redirect_uris }, 201);
	}
	function authorize(endpoint: URL, response: ServerResponse) {
		const redirect = URL.parse(endpoint.searchParams.get("redirect_uri") ?? "");
		if (
			!redirect ||
			redirect.hostname !== "127.0.0.1" ||
			(dynamic && redirect.href !== registeredRedirect) ||
			endpoint.searchParams.get("client_id") !== expectedClient ||
			endpoint.searchParams.get("scope") !== "offline_access" ||
			endpoint.searchParams.get("code_challenge_method") !== "S256"
		)
			return response.writeHead(400).end();
		pkce = endpoint.searchParams.get("code_challenge");
		codeUsed = false;
		redirect.searchParams.set("code", authorizationCode);
		redirect.searchParams.set(
			"state",
			endpoint.searchParams.get("state") ?? "",
		);
		return response.writeHead(302, { location: redirect.href }).end();
	}

	async function exchangeToken(
		request: IncomingMessage,
		response: ServerResponse,
	) {
		const form = new URLSearchParams(await readBody(request));
		if (
			form.get("client_id") !== expectedClient ||
			form.get("client_secret") !==
				(dynamic ? registeredClient.client_secret : null) ||
			request.headers.authorization
		)
			return sendJson(response, { error: "invalid_client" }, 400);
		if (form.get("grant_type") === "authorization_code") {
			const verifier = createHash("sha256")
				.update(form.get("code_verifier") ?? "")
				.digest("base64url");
			if (
				codeUsed ||
				verifier !== pkce ||
				form.get("code") !== authorizationCode
			)
				return sendJson(response, { error: "invalid_grant" }, 400);
			codeUsed = true;
			exchanges++;
			return sendJson(response, issue());
		}
		refreshes++;
		await behavior.pause;
		if (behavior.tokenRedirect)
			return response
				.writeHead(behavior.tokenRedirect.status, {
					location: behavior.tokenRedirect.target,
				})
				.end();
		if (
			behavior.refresh ||
			form.get("refresh_token") !== tokens().refresh_token
		)
			return sendJson(
				response,
				{
					error: behavior.refresh ?? "invalid_grant",
					error_description:
						"PRIVATE_OAUTH_REJECTED_BODY " + registeredClient.client_secret,
				},
				400,
			);
		return sendJson(response, issue());
	}

	async function handleMcp(request: IncomingMessage, response: ServerResponse) {
		const session = String(request.headers["mcp-session-id"] ?? randomUUID());
		if (request.method === "DELETE") {
			deleted.push(session);
			return response.writeHead(200).end();
		}
		if (request.method === "GET") return response.writeHead(405).end();
		const message = JSON.parse(await readBody(request));
		const accepted =
			accessValid &&
			request.headers.authorization === `Bearer ${tokens().access_token}`;
		requests.push({
			method: message.method,
			accepted,
			session,
			peer: request.headers["x-fixture-peer"]?.toString(),
		});
		if (!accepted) {
			if (message.method === "tools/call") await behavior.pauseToolChallenge;
			return response
				.writeHead(401, {
					"www-authenticate": `Bearer error="invalid_token", error_description="PRIVATE_OAUTH_CHALLENGE", resource_metadata="${behavior.resourceMetadataUrl ?? resourceMetadataUrl}"`,
				})
				.end("PRIVATE_OAUTH_CHALLENGE_BODY");
		}
		if (!("id" in message)) return response.writeHead(202).end();
		response.setHeader("mcp-session-id", session);
		const result = (result: unknown) =>
			sendJson(response, { jsonrpc: "2.0", id: message.id, result });
		if (message.method === "initialize")
			return result({
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "oauth-fixture", version: "1" },
			});
		if (message.method === "tools/list")
			return result({ tools: [fixtureTool("mutate")] });
		if (message.method !== "tools/call") return response.writeHead(400).end();
		effects++;
		if (behavior.failCall)
			return response.writeHead(503).end("PRIVATE_OAUTH_AMBIGUOUS_BODY");
		return result({ content: [], structuredContent: { session } });
	}

	const origin = await listenOAuthFixture(t, (request, response) => {
		const endpoint = new URL(request.url ?? "/", origin);
		const { pathname } = endpoint;
		if (pathname === "/.well-known/oauth-protected-resource/mcp")
			return sendJson(response, {
				resource: url,
				authorization_servers: [origin],
				scopes_supported: ["offline_access"],
			});
		if (pathname === "/.well-known/oauth-authorization-server")
			return sendJson(response, authorizationServerMetadata);
		if (pathname === "/register") {
			registrations++;
			if (dynamic) return register(request, response);
		}
		if (pathname === "/authorize") return authorize(endpoint, response);
		if (pathname === "/token") return exchangeToken(request, response);
		if (pathname === "/mcp") return handleMcp(request, response);
		return response.writeHead(404).end();
	});
	const url = `${origin}/mcp`;
	const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
	const authorizationServerMetadata = {
		issuer: origin,
		authorization_endpoint: `${origin}/authorize`,
		token_endpoint: `${origin}/token`,
		...(dynamic ? { registration_endpoint: `${origin}/register` } : {}),
		response_types_supported: ["code"],
		token_endpoint_auth_methods_supported: dynamic
			? ["client_secret_basic", "client_secret_post", "none"]
			: ["none"],
		code_challenge_methods_supported: ["S256"],
	};
	return {
		url,
		discovery: {
			authorizationServerUrl: origin,
			authorizationServerMetadata,
			resourceMetadataUrl,
		},
		tokens,
		issue,
		behavior,
		requests,
		deleted,
		expire: () => {
			accessValid = false;
		},
		get registrations() {
			return registrations;
		},
		get counts() {
			return { refreshes, exchanges, effects };
		},
	};
}
