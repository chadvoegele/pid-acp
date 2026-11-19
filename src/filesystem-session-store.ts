import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { tryLock } from "fs-native-extensions";
import { SessionOpenError } from "./session-errors.js";

const PUBLIC_ACCESS_BITS = 0o077;

export async function prepareSessionsDirectory(directory: string) {
	const privateDirectoryMode = 0o700;
	if (!directory || !isAbsolute(directory))
		throw new Error(
			"PID_ACP_SESSIONS_DIR must be a nonempty absolute directory.",
		);
	// JSONL has no file-mode option, including for new sidecars.
	process.umask(process.umask() | PUBLIC_ACCESS_BITS);
	const canonical = resolve(directory);
	await mkdir(canonical, { recursive: true, mode: privateDirectoryMode });
	await validatePrivatePath(canonical, true);
	if ((await realpath(canonical)) !== canonical)
		throw new Error("Sessions root must not contain symlinks.");
	return canonical;
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
			await mkdir(directory, { mode: 0o700, recursive: true });
			const parent = await open(
				root,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
			await validatePrivatePath(directory, true);
			await validateStorageFiles(directory);
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

async function validatePrivatePath(path: string, directory = false) {
	const stat = await lstat(path);
	if (
		(directory ? !stat.isDirectory() : !stat.isFile()) ||
		(stat.mode & PUBLIC_ACCESS_BITS) !== 0 ||
		stat.uid !== process.getuid?.() ||
		(!directory && stat.nlink !== 1)
	)
		throw new SessionOpenError(
			"Session storage must be private, owned by this user, and contain no symlinks or linked files.",
		);
}

async function validateStorageFiles(directory: string) {
	const names = await readdir(directory);
	if (names.length && !names.includes("main.jsonl"))
		throw new SessionOpenError(
			"Shared storage is incomplete. Restore a whole-store backup before restarting.",
		);
	for (const name of names) {
		await validatePrivatePath(join(directory, name));
	}
}

async function acquireOwnership(directory: string) {
	const privateFileMode = 0o600;
	const file = await open(
		join(directory, "owner.lock"),
		constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
		privateFileMode,
	);
	try {
		if (!tryLock(file.fd))
			throw new SessionOpenError(
				"Session namespace is already owned by another server process. Close that process and retry.",
			);
		await validatePrivatePath(join(directory, "owner.lock"));
		return file;
	} catch (error) {
		await file.close();
		throw error;
	}
}
