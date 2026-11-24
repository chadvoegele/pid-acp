import assert from "node:assert/strict";
import { link, readdir, rename, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
	FilesystemSessionStore,
	prepareSessionsDirectory,
} from "../dist/filesystem-session-store.js";
import { persistenceFixture } from "./helpers/persistence.ts";

test("namespace uses one stable lock inode and rejects a second owner before backend opening", async (t) => {
	const f = await persistenceFixture(t);
	const root = await prepareSessionsDirectory(f.sessions);
	const store = await FilesystemSessionStore.open(root);
	const lock = join(root, "owner.lock");
	const inode = (await stat(lock)).ino;
	await assert.rejects(FilesystemSessionStore.open(root), /already owned/);
	const closing = store.close();
	assert.equal(store.close(), closing);
	await closing;
	const next = await FilesystemSessionStore.open(root);
	await next.close();
	assert.equal((await stat(lock)).ino, inode);
	assert.deepEqual(await readdir(root), ["db", "owner.lock"]);
});

test("linked session paths can reopen a conversation and still share one lock", async (t) => {
	const f = await persistenceFixture(t);
	const first = await f.runtime();
	const session = await first.createSession(f.cwd);
	await first.close();

	const root = join(f.root, "storage");
	await rename(f.sessions, root);
	await symlink(root, f.sessions);
	for (const name of ["db", "owner.lock"]) {
		const target = join(f.root, name);
		await rename(join(root, name), target);
		await symlink(target, join(root, name));
	}
	await link(join(root, "db/main.jsonl"), join(f.root, "main-link"));

	const next = await f.runtime();
	assert.equal((await next.loadSession(session.id, f.cwd)).id, session.id);
	await assert.rejects(FilesystemSessionStore.open(root), /already owned/);
});
