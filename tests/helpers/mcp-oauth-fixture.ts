import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import type { TestContext } from "node:test";
import { fixtureTool } from "./mcp-fixture.ts";

export const clientId = "fixture-public-client";
export const privateFixture = /PRIVATE_OAUTH_/;
const authorizationCode = "PRIVATE_OAUTH_CODE";

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

export async function startMcpOAuthFixture(t: TestContext) {
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
		refresh?: "revoked";
		redirect?: {
			endpoint: "resource" | "issuer" | "token";
			target: string;
			status: number;
		};
		pause?: Promise<void>;
		pauseToolChallenge?: Promise<void>;
		failCall?: boolean;
	} = {};
	const origin = await listenOAuthFixture(t, async (request, response) => {
		const endpoint = new URL(request.url ?? "/", origin);
		const { pathname } = endpoint;
		const json = (value: unknown, status = 200) =>
			response
				.writeHead(status, { "content-type": "application/json" })
				.end(JSON.stringify(value));
		if (
			(behavior.redirect?.endpoint === "resource" &&
				pathname.startsWith("/.well-known/oauth-protected-resource")) ||
			(behavior.redirect?.endpoint === "issuer" &&
				pathname === "/.well-known/oauth-authorization-server")
		)
			return response
				.writeHead(behavior.redirect.status, {
					location: behavior.redirect.target,
				})
				.end();
		if (pathname === "/.well-known/oauth-protected-resource/mcp")
			return json({
				resource: url,
				authorization_servers: [origin],
				scopes_supported: ["offline_access"],
			});
		if (pathname === "/.well-known/oauth-authorization-server")
			return json({
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				response_types_supported: ["code"],
				token_endpoint_auth_methods_supported: ["none"],
				code_challenge_methods_supported: ["S256"],
			});
		if (pathname === "/authorize") {
			const redirect = URL.parse(
				endpoint.searchParams.get("redirect_uri") ?? "",
			);
			if (
				!redirect ||
				redirect.hostname !== "127.0.0.1" ||
				endpoint.searchParams.get("client_id") !== clientId ||
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
		let raw = "";
		for await (const chunk of request) raw += chunk;
		if (pathname === "/token") {
			const form = new URLSearchParams(raw);
			if (
				form.get("client_id") !== clientId ||
				form.has("client_secret") ||
				request.headers.authorization
			)
				return json({ error: "invalid_client" }, 400);
			if (form.get("grant_type") === "authorization_code") {
				const verifier = createHash("sha256")
					.update(form.get("code_verifier") ?? "")
					.digest("base64url");
				if (
					codeUsed ||
					verifier !== pkce ||
					form.get("code") !== authorizationCode
				)
					return json({ error: "invalid_grant" }, 400);
				codeUsed = true;
				exchanges++;
				return json(issue());
			}
			refreshes++;
			await behavior.pause;
			if (behavior.redirect?.endpoint === "token")
				return response
					.writeHead(behavior.redirect.status, {
						location: behavior.redirect.target,
					})
					.end();
			if (
				behavior.refresh === "revoked" ||
				form.get("refresh_token") !== tokens().refresh_token
			)
				return json(
					{
						error: "invalid_grant",
						error_description: "PRIVATE_OAUTH_REVOKED_BODY",
					},
					400,
				);
			return json(issue());
		}
		if (pathname !== "/mcp") return response.writeHead(404).end();
		const session = String(request.headers["mcp-session-id"] ?? randomUUID());
		if (request.method === "DELETE") {
			deleted.push(session);
			return response.writeHead(200).end();
		}
		if (request.method === "GET") return response.writeHead(405).end();
		const message = JSON.parse(raw);
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
					"www-authenticate": `Bearer error="invalid_token", error_description="PRIVATE_OAUTH_CHALLENGE", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				})
				.end("PRIVATE_OAUTH_CHALLENGE_BODY");
		}
		if (!("id" in message)) return response.writeHead(202).end();
		response.setHeader("mcp-session-id", session);
		const result = (result: unknown) =>
			json({ jsonrpc: "2.0", id: message.id, result });
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
	});
	const url = `${origin}/mcp`;
	return {
		url,
		tokens,
		issue,
		behavior,
		requests,
		deleted,
		expire: () => {
			accessValid = false;
		},
		get counts() {
			return { refreshes, exchanges, effects };
		},
	};
}
