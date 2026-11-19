import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import {
	FilesystemSessionStore,
	prepareSessionsDirectory,
} from "./filesystem-session-store.js";

// Harness owns the backend; this owner retains the namespace lock until native close.
export type SessionStore = {
	readonly persistent: boolean;
	openStorage(): Promise<Storage>;
	close(): Promise<void>;
};

export async function openSessionStore(
	directory?: string,
): Promise<SessionStore> {
	if (directory !== undefined)
		return FilesystemSessionStore.open(
			await prepareSessionsDirectory(directory),
		);
	const storage = new MemoryStorage();
	return {
		persistent: false,
		openStorage: async () => storage,
		close: async () => {},
	};
}
