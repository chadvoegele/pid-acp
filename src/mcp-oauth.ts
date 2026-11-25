import { McpAuthRequiredError } from "@earendil-works/pi-mcp";
import {
	createMcpAuthProvider,
	McpOAuthAuthorizationRequiredError,
	McpRefreshLockBusyError,
	OAuthError,
	parseWwwAuthenticate,
	type McpAuthProvider,
} from "@earendil-works/pi-mcp/oauth";
import { isSecureMcpOAuthUrl, type PublicMcpOAuth } from "./mcp-config.js";
import { McpOAuthStoreError, piMcpStore } from "./mcp-oauth-store.js";

const reasons = {
	client:
		"OAuth state is not for a supported pre-registered public client; check the Pi and pid-acp client configuration",
	store:
		"Pi OAuth store is invalid or inaccessible; check PID_ACP_MCP_AUTH_FILE, permissions and server identity",
	busy: "Pi OAuth refresh lock is busy; let the other refresher finish",
	refresh:
		"OAuth refresh failed; check the authorization server and public client configuration",
} as const;
export type McpOAuthFailure = keyof typeof reasons | "login";

// pi-mcp's refresh flow otherwise treats a failed token save as a sign-in fallback.
class RefreshSaveError extends OAuthError {
	constructor() {
		super("pid_acp_store_error", reasons.store);
	}
}
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
		error instanceof McpOAuthAuthorizationRequiredError ||
		error instanceof McpAuthRequiredError
	)
		return "login";
}

export function oauthGuidance(name: string, failure: McpOAuthFailure) {
	return failure === "login"
		? `OAuth sign-in required; stop all refreshers and run \`pi mcp login ${name}\` as the service user, then restart pid-acp`
		: `${reasons[failure]}, then restart pid-acp`;
}

export function piMcpAuthProvider(
	authFile: string,
	name: string,
	url: string,
	settings: PublicMcpOAuth,
	isStopping: () => boolean,
): McpAuthProvider {
	const store = piMcpStore(authFile, name, url);
	const load = async () => {
		const state = await store.load();
		// Pi does not persist client information for a configured client. Any
		// existing registration may belong to a different grant or client mode.
		if (
			state?.clientInformation ||
			(state?.tokens && state.tokens.token_type.toLowerCase() !== "bearer")
		)
			throw new UnsupportedClientError();
		return state;
	};
	const provider = createMcpAuthProvider({
		serverUrl: url,
		clientName: "pid-acp",
		settings: () => settings,
		onChallenge: () => {},
		store: {
			...store,
			load,
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
			const tokens = (await load())?.tokens;
			if (!tokens?.refresh_token)
				throw new McpOAuthAuthorizationRequiredError();
			return tokens.access_token;
		},
		async onUnauthorized(context) {
			if (isStopping()) throw new Error("MCP is closing.");
			try {
				await provider.onUnauthorized?.({
					...context,
					fetch: (input, init) => {
						if (!isSecureMcpOAuthUrl(new URL(input)))
							throw new TypeError("Insecure OAuth endpoint");
						return context.fetch(input, { ...init, redirect: "error" });
					},
				});
			} catch (error) {
				if (error instanceof McpOAuthAuthorizationRequiredError) {
					const challenge = parseWwwAuthenticate(
						context.response.headers.get("www-authenticate"),
					);
					if (
						challenge.error === "insufficient_scope" ||
						!(await load())?.tokens?.refresh_token
					)
						throw error;
				} else if (oauthFailure(error)) {
					throw error;
				}
				throw new RefreshFailedError();
			}
		},
	};
}
