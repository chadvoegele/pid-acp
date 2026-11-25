import { McpAuthRequiredError } from "@earendil-works/pi-mcp";
import {
	createMcpAuthProvider,
	McpOAuthAuthorizationRequiredError,
	McpRefreshLockBusyError,
	OAuthError,
	parseWwwAuthenticate,
	type McpAuthProvider,
	type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import { isSecureMcpOAuthUrl, type McpOAuthOptions } from "./mcp-config.js";
import { McpOAuthStoreError, piMcpStore } from "./mcp-oauth-store.js";

export type McpOAuthFailure = "client" | "store" | "busy" | "refresh" | "login";

// pi-mcp's refresh flow otherwise treats a failed token save as a sign-in fallback.
class RefreshSaveError extends OAuthError {
	constructor() {
		super("pid_acp_store_error", "Could not save Pi OAuth state");
	}
}
// pi-mcp propagates TypeError from resource discovery instead of falling back.
class MissingRefreshEndpointError extends TypeError {}
class UnsupportedClientError extends Error {}
class RefreshFailedError extends Error {}

export function oauthFailure(error: unknown): McpOAuthFailure | undefined {
	if (error instanceof UnsupportedClientError) return "client";
	if (error instanceof McpRefreshLockBusyError) return "busy";
	if (error instanceof McpOAuthStoreError)
		return error.code === "missing" ? "login" : "store";
	if (error instanceof RefreshSaveError) return "store";
	if (error instanceof RefreshFailedError) return "refresh";
	if (
		error instanceof MissingRefreshEndpointError ||
		error instanceof McpOAuthAuthorizationRequiredError ||
		error instanceof McpAuthRequiredError
	)
		return "login";
}

function isNonemptyString(value: unknown) {
	return typeof value === "string" && value.trim() !== "";
}

function hasUsableRegistration(value: unknown) {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const {
		client_id,
		client_secret,
		token_endpoint_auth_method,
		redirect_uris,
	} = value as Record<string, unknown>;
	const hasSecret = isNonemptyString(client_secret);
	return (
		isNonemptyString(client_id) &&
		(client_secret === undefined || hasSecret) &&
		(token_endpoint_auth_method === undefined ||
			token_endpoint_auth_method === "none" ||
			(hasSecret &&
				(token_endpoint_auth_method === "client_secret_basic" ||
					token_endpoint_auth_method === "client_secret_post"))) &&
		(redirect_uris === undefined ||
			(Array.isArray(redirect_uris) &&
				redirect_uris.every((uri) => typeof uri === "string")))
	);
}

function requireGrant(
	state: McpOAuthState | undefined,
	clientId: string | undefined,
) {
	const tokens = state?.tokens;
	const registration = state?.clientInformation;
	if (
		(clientId !== undefined && registration !== undefined) ||
		(tokens && tokens.token_type.toLowerCase() !== "bearer")
	)
		throw new UnsupportedClientError();
	if (
		!tokens?.refresh_token ||
		(clientId === undefined && !hasUsableRegistration(registration))
	)
		throw new McpOAuthAuthorizationRequiredError();
	return tokens;
}

export function piMcpAuthProvider(
	authFile: string,
	name: string,
	url: string,
	settings: McpOAuthOptions,
	isStopping: () => boolean,
): McpAuthProvider {
	const store = piMcpStore(authFile, name, url);
	const provider = createMcpAuthProvider({
		serverUrl: url,
		clientName: "pid-acp",
		settings: () => settings,
		onChallenge: () => {},
		store: {
			...store,
			withRefreshLock(refresh) {
				return store.withRefreshLock(async () => {
					const state = await store.load();
					// Validate at entry, not on upstream reads between invalidation steps.
					requireGrant(state, settings.clientId);
					const discovery = state?.discovery;
					const metadata = discovery?.authorizationServerMetadata;
					for (const value of [
						discovery?.authorizationServerUrl,
						metadata?.issuer,
						metadata?.token_endpoint,
					]) {
						const url = typeof value === "string" ? URL.parse(value) : null;
						if (!url || !isSecureMcpOAuthUrl(url))
							throw new MissingRefreshEndpointError();
					}
					return refresh();
				});
			},
			async save(state) {
				try {
					await store.save(state);
				} catch {
					throw new RefreshSaveError();
				}
			},
		},
	});
	return {
		settled: () => provider.settled(),
		async token() {
			// Never call upstream token(): its eager refresh uses global fetch.
			await provider.settled();
			return requireGrant(await store.load(), settings.clientId).access_token;
		},
		async onUnauthorized(context) {
			if (isStopping()) throw new Error("MCP is closing.");
			try {
				await provider.onUnauthorized?.({
					...context,
					fetch: (input, init) => {
						// A rejected client clears discovery; do not rediscover from the challenge.
						if (init?.method !== "POST")
							throw new MissingRefreshEndpointError();
						if (!isSecureMcpOAuthUrl(new URL(input)))
							throw new TypeError("Insecure OAuth endpoint");
						return context.fetch(input, { ...init, redirect: "error" });
					},
				});
			} catch (error) {
				if (!(error instanceof McpOAuthAuthorizationRequiredError)) {
					if (oauthFailure(error)) throw error;
					throw new RefreshFailedError();
				}
				const challenge = parseWwwAuthenticate(
					context.response.headers.get("www-authenticate"),
				);
				if (challenge.error === "insufficient_scope") throw error;
				requireGrant(await store.load(), settings.clientId);
				throw new RefreshFailedError();
			}
		},
	};
}
