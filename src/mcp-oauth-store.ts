import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

function getErrorCode(error: unknown) {
	return error instanceof Error && "code" in error ? error.code : undefined;
}

function sanitizeStoreError(error: unknown): McpOAuthStoreError {
	return error instanceof McpOAuthStoreError
		? error
		: new McpOAuthStoreError("io");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const protocol = URL.parse(value)?.protocol;
	return protocol === "https:" || protocol === "http:";
}

function isNonemptyString(value: unknown) {
	return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown) {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function hasValidTokens(tokens: unknown): boolean {
	if (!isRecord(tokens)) return false;
	const { access_token, token_type, refresh_token, scope } = tokens;
	return (
		isNonemptyString(access_token) &&
		isNonemptyString(token_type) &&
		(refresh_token === undefined || isNonemptyString(refresh_token)) &&
		(scope === undefined || typeof scope === "string")
	);
}

function hasRefreshDiscovery(discovery: unknown): boolean {
	if (!isRecord(discovery) || !isHttpUrl(discovery.authorizationServerUrl))
		return false;
	const { authorizationServerMetadata, resourceMetadata } = discovery;
	if (
		authorizationServerMetadata !== undefined &&
		(!isRecord(authorizationServerMetadata) ||
			!isHttpUrl(authorizationServerMetadata.token_endpoint) ||
			(authorizationServerMetadata.token_endpoint_auth_methods_supported !==
				undefined &&
				!isStringArray(
					authorizationServerMetadata.token_endpoint_auth_methods_supported,
				)))
	)
		return false;
	return (
		resourceMetadata === undefined ||
		(isRecord(resourceMetadata) &&
			isHttpUrl(resourceMetadata.resource) &&
			(resourceMetadata.scopes_supported === undefined ||
				isStringArray(resourceMetadata.scopes_supported)))
	);
}

function validateState(
	value: unknown,
	serverUrl: string,
): asserts value is McpOAuthState {
	if (!isRecord(value) || !isHttpUrl(value.serverUrl))
		throw new McpOAuthStoreError("invalid-state");
	if (value.serverUrl !== serverUrl)
		throw new McpOAuthStoreError("identity-mismatch");
	const { tokens, discovery } = value;
	if (
		(tokens !== undefined && !hasValidTokens(tokens)) ||
		(discovery !== undefined && !hasRefreshDiscovery(discovery))
	)
		throw new McpOAuthStoreError("invalid-state");
}

function parseStates(bytes: Buffer): Record<string, unknown> {
	try {
		const states: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
		);
		if (isRecord(states)) return states;
	} catch {}
	throw new McpOAuthStoreError("invalid-state");
}

function readServerState(
	states: Record<string, unknown>,
	key: string,
	serverUrl: string,
): McpOAuthState | undefined {
	if (!Object.hasOwn(states, key)) return undefined;
	const state = states[key];
	validateState(state, serverUrl);
	return state;
}

function mergeServerState(current: McpOAuthState, state: McpOAuthState) {
	const next = { ...current, ...state };
	for (const field of [
		"tokens",
		"tokensExpireAt",
		"discovery",
		"codeVerifier",
		"oauthState",
		"clientInformation",
	] as const) {
		if (state[field] === undefined) delete next[field];
	}
	return next;
}

export function isPiMcpAuthFile(path: string): boolean {
	return (
		isAbsolute(path) &&
		resolve(path) === path &&
		basename(path) === "mcp-auth.json" &&
		!path.includes("\0")
	);
}

function isPrivate(stats: Stats): boolean {
	return (stats.mode & 0o077) === 0 && stats.uid === process.getuid?.();
}

function requirePrivateFile(stats: Stats) {
	if (!stats.isFile() || stats.nlink !== 1 || !isPrivate(stats))
		throw new McpOAuthStoreError("unsafe-location");
}

async function hasPrivateAuthFile(authFile: string): Promise<boolean> {
	const directory = dirname(authFile);
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
		if (getErrorCode(error) === "ENOENT") return false;
		throw sanitizeStoreError(error);
	}
}

async function withAuthFileLock<T>(
	authFile: string,
	use: (checkLock: () => void) => Promise<T>,
): Promise<T> {
	let compromised = false;
	const checkLock = () => {
		if (compromised) throw new McpOAuthStoreError("io");
	};
	// Match Pi’s realpath lock and ten attempts 20 ms apart.
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
}

async function withServerRefreshLock<T>(
	target: string,
	use: () => Promise<T>,
): Promise<T> {
	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(target, {
			realpath: false,
			stale: 20_000,
			retries: { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 },
			onCompromised: () => {},
		});
	} catch (error) {
		if (getErrorCode(error) === "ELOCKED") throw new McpRefreshLockBusyError();
		throw sanitizeStoreError(error);
	}
	try {
		return await use();
	} finally {
		await release().catch(() => undefined);
	}
}

async function withAuthFile<T>(
	authFile: string,
	mode: number,
	transact: (file: FileHandle, checkLock: () => void) => Promise<T>,
): Promise<T | undefined> {
	if (!(await hasPrivateAuthFile(authFile))) return undefined;
	try {
		return await withAuthFileLock(authFile, async (checkLock) => {
			const file = await open(
				authFile,
				mode | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				requirePrivateFile(await file.stat());
				return await transact(file, checkLock);
			} finally {
				await file.close();
			}
		});
	} catch (error) {
		throw sanitizeStoreError(error);
	}
}

async function writeStates(file: FileHandle, bytes: Buffer) {
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
}

export function piMcpStore(
	authFile: string,
	name: string,
	url: string,
): McpOAuthServerStore {
	if (!isPiMcpAuthFile(authFile))
		throw new McpOAuthStoreError("unsafe-location");
	if (!isHttpUrl(url) || !/^[A-Za-z0-9_-]+$/.test(name))
		throw new McpOAuthStoreError("identity-mismatch");
	const serverUrl = new URL(url).href;
	const key = `${mcpNamespace(name)}|${serverUrl}`;
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
	const refreshTarget = join(dirname(authFile), `mcp-auth-refresh-${hash}`);

	return {
		load: () =>
			withAuthFile(authFile, constants.O_RDONLY, async (file) =>
				readServerState(parseStates(await file.readFile()), key, serverUrl),
			),
		async save(state) {
			validateState(state, serverUrl);
			const saved = await withAuthFile(
				authFile,
				constants.O_RDWR,
				async (file, checkLock) => {
					const states = parseStates(await file.readFile());
					const current = readServerState(states, key, serverUrl);
					if (!current) return false;
					const next = { ...states, [key]: mergeServerState(current, state) };
					const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
					checkLock();
					await writeStates(file, bytes);
					return true;
				},
			);
			if (!saved) throw new McpOAuthStoreError("missing");
		},
		async withRefreshLock(use) {
			if (!(await hasPrivateAuthFile(authFile)))
				throw new McpOAuthStoreError("missing");
			return withServerRefreshLock(refreshTarget, use);
		},
	};
}
