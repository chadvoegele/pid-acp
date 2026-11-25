import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { mcpNamespace } from "@earendil-works/pi-mcp";
import {
	McpRefreshLockBusyError,
	type McpOAuthServerStore,
	type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import lockfile from "proper-lockfile";

const storeErrors = {
	missing: "MCP OAuth state is missing; bootstrap the server in Pi.",
	"unsafe-location":
		"MCP OAuth requires the actual private Pi credential file.",
	"invalid-state": "MCP OAuth state is malformed.",
	"identity-mismatch": "MCP OAuth state belongs to a different server URL.",
	io: "Could not access the Pi MCP OAuth store.",
} as const;

export class McpOAuthStoreError extends Error {
	constructor(readonly code: keyof typeof storeErrors) {
		super(storeErrors[code]);
		this.name = "McpOAuthStoreError";
	}
}

function errorCode(error: unknown) {
	return error instanceof Error && "code" in error ? error.code : undefined;
}

function ioError(error: unknown): McpOAuthStoreError {
	return error instanceof McpOAuthStoreError
		? error
		: new McpOAuthStoreError("io");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonempty = (value: unknown) =>
	typeof value === "string" && value.trim() !== "";
const string = (value: unknown) => typeof value === "string";
const strings = (value: unknown) => Array.isArray(value) && value.every(string);
const httpUrl = (value: unknown) =>
	typeof value === "string" &&
	["http:", "https:"].includes(URL.parse(value)?.protocol ?? "");
const optional = (value: unknown, check: (value: unknown) => boolean) =>
	value === undefined || check(value);

function validDiscovery(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!httpUrl(value.authorizationServerUrl) ||
		!optional(value.resourceMetadataUrl, httpUrl)
	)
		return false;
	const { authorizationServerMetadata: auth, resourceMetadata: resource } =
		value;
	return (
		optional(
			auth,
			(auth) =>
				isRecord(auth) &&
				httpUrl(auth.issuer) &&
				httpUrl(auth.authorization_endpoint) &&
				httpUrl(auth.token_endpoint) &&
				strings(auth.response_types_supported) &&
				optional(auth.token_endpoint_auth_methods_supported, strings),
		) &&
		optional(
			resource,
			(resource) =>
				isRecord(resource) &&
				httpUrl(resource.resource) &&
				optional(resource.scopes_supported, strings),
		)
	);
}

function validateState(
	value: unknown,
	serverUrl: string,
): asserts value is McpOAuthState {
	if (!isRecord(value) || !httpUrl(value.serverUrl))
		throw new McpOAuthStoreError("invalid-state");
	if (value.serverUrl !== serverUrl)
		throw new McpOAuthStoreError("identity-mismatch");
	if (
		!optional(
			value.tokens,
			(tokens) =>
				isRecord(tokens) &&
				nonempty(tokens.access_token) &&
				nonempty(tokens.token_type) &&
				optional(tokens.refresh_token, nonempty) &&
				optional(tokens.expires_in, Number.isFinite) &&
				optional(tokens.scope, string) &&
				optional(tokens.id_token, nonempty),
		) ||
		!optional(value.tokensExpireAt, Number.isFinite) ||
		!optional(
			value.clientInformation,
			(client) =>
				isRecord(client) &&
				nonempty(client.client_id) &&
				optional(client.client_secret, nonempty) &&
				optional(client.redirect_uris, strings),
		) ||
		!optional(value.codeVerifier, nonempty) ||
		!optional(value.oauthState, nonempty) ||
		!optional(value.discovery, validDiscovery)
	)
		throw new McpOAuthStoreError("invalid-state");
}

function parseStates(bytes: Buffer): Record<string, unknown> {
	try {
		const states: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
		);
		if (isRecord(states)) return states;
	} catch {
		// Never expose the parser excerpt.
	}
	throw new McpOAuthStoreError("invalid-state");
}

function isPrivate(stats: Stats): boolean {
	return (stats.mode & 0o077) === 0 && stats.uid === process.getuid?.();
}

function requirePrivateFile(stats: Stats) {
	if (!stats.isFile() || stats.nlink !== 1 || !isPrivate(stats))
		throw new McpOAuthStoreError("unsafe-location");
}

async function privateStoreExists(authFile: string, directory: string) {
	try {
		const dir = await lstat(directory);
		if (
			!dir.isDirectory() ||
			!isPrivate(dir) ||
			(await realpath(directory)) !== directory
		)
			throw new McpOAuthStoreError("unsafe-location");
		requirePrivateFile(await lstat(authFile));
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw ioError(error);
	}
}

export function piMcpStore(
	authFile: string,
	name: string,
	url: string,
): McpOAuthServerStore {
	if (!isAbsolute(authFile) || basename(authFile) !== "mcp-auth.json")
		throw new McpOAuthStoreError("unsafe-location");
	if (!httpUrl(url) || !/^[A-Za-z0-9_-]+$/.test(name))
		throw new McpOAuthStoreError("identity-mismatch");
	const directory = dirname(authFile);
	if (join(directory, "mcp-auth.json") !== authFile)
		throw new McpOAuthStoreError("unsafe-location");
	const serverUrl = String(new URL(url));
	const key = `${mcpNamespace(name)}|${serverUrl}`;
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
	const refreshTarget = join(directory, `mcp-auth-refresh-${hash}`);

	async function withFileLock<T>(
		use: (checkLock: () => void) => Promise<T>,
	): Promise<T | undefined> {
		if (!(await privateStoreExists(authFile, directory))) return undefined;
		try {
			let compromised = false;
			const checkLock = () => {
				if (compromised) throw new McpOAuthStoreError("io");
			};
			// Pi's synchronous backend uses realpath and ten attempts 20 ms apart.
			const release = await lockfile.lock(authFile, {
				retries: { retries: 9, factor: 1, minTimeout: 20, maxTimeout: 20 },
				onCompromised: () => {
					compromised = true;
				},
			});
			try {
				const result = await use(checkLock);
				checkLock();
				return result;
			} finally {
				await release();
			}
		} catch (error) {
			throw ioError(error);
		}
	}

	function access(state?: McpOAuthState): Promise<McpOAuthState | undefined> {
		return withFileLock(async (checkLock) => {
			const file = await open(
				authFile,
				(state ? constants.O_RDWR : constants.O_RDONLY) |
					constants.O_NOFOLLOW |
					constants.O_NONBLOCK,
			);
			try {
				requirePrivateFile(await file.stat());
				const states = parseStates(await file.readFile());
				if (!Object.hasOwn(states, key)) return undefined;
				const current = states[key];
				validateState(current, serverUrl);
				if (!state) return current;
				// Preserve opaque entry fields, but honor deletions of provider-owned state.
				const next = { ...current, ...state };
				for (const field of [
					"tokens",
					"tokensExpireAt",
					"discovery",
					"codeVerifier",
					"oauthState",
					"clientInformation",
				] as const)
					if (state[field] === undefined) delete next[field];
				states[key] = next;
				const bytes = Buffer.from(`${JSON.stringify(states, null, 2)}\n`);
				checkLock();
				// Write in place at offset zero, keeping Pi's inode and permissions.
				for (let offset = 0; offset < bytes.length; ) {
					const { bytesWritten } = await file.write(
						bytes,
						offset,
						bytes.length - offset,
						offset,
					);
					if (bytesWritten === 0) throw new McpOAuthStoreError("io");
					offset += bytesWritten;
				}
				await file.truncate(bytes.length);
				return next;
			} finally {
				await file.close();
			}
		});
	}

	return {
		load: () => access(),
		async save(state) {
			validateState(state, serverUrl);
			if (!(await access(state))) throw new McpOAuthStoreError("missing");
		},
		async withRefreshLock(fn) {
			if (!(await privateStoreExists(authFile, directory)))
				throw new McpOAuthStoreError("missing");
			let release: () => Promise<void>;
			try {
				release = await lockfile.lock(refreshTarget, {
					realpath: false,
					stale: 20_000,
					retries: {
						retries: 250,
						factor: 1,
						minTimeout: 100,
						maxTimeout: 100,
					},
					onCompromised: () => {},
				});
			} catch (error) {
				if (errorCode(error) === "ELOCKED") throw new McpRefreshLockBusyError();
				throw ioError(error);
			}
			try {
				return await fn();
			} finally {
				await release().catch(() => undefined);
			}
		},
	};
}
