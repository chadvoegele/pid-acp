import { constants } from "node:fs";
import { mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { tryLock } from "fs-native-extensions";
import { SessionOpenError } from "./session-errors.js";

export async function prepareSessionsDirectory(directory: string) {
	if (!directory || !isAbsolute(directory))
		throw new Error(
			"PID_ACP_SESSIONS_DIR must be a nonempty absolute directory.",
		);
	const root = resolve(directory);
	await mkdir(root, { recursive: true });
	return root;
}

export class FilesystemSessionStore {
	readonly persistent = true;
	private closing?: Promise<void>;
	private constructor(
		private readonly path: string,
		private readonly ownership: FileHandle,
	) {}

	get directory() {
		return this.path;
	}

	static async open(root: string) {
		const ownership = await acquireOwnership(root);
		try {
			const directory = join(root, "db");
			await mkdir(directory, { recursive: true });
			const parent = await open(root, "r");
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
			const names = await readdir(directory);
			if (names.length && !names.includes("main.jsonl"))
				throw new SessionOpenError(
					"Shared storage is incomplete. Restore a whole-store backup before restarting.",
				);
			return new FilesystemSessionStore(directory, ownership);
		} catch (error) {
			await ownership.close();
			throw error;
		}
	}

	async openStorage() {
		return openNodeJsonlStorage(this.path, context, { fsync: true });
	}

	close() {
		this.closing ??= this.ownership.close();
		return this.closing;
	}
}

async function acquireOwnership(directory: string) {
	const file = await open(
		join(directory, "owner.lock"),
		constants.O_CREAT | constants.O_RDWR,
	);
	try {
		if (!tryLock(file.fd))
			throw new SessionOpenError(
				"Session namespace is already owned by another server process. Close that process and retry.",
			);
		return file;
	} catch (error) {
		await file.close();
		throw error;
	}
}
