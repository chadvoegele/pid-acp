import assert from "node:assert/strict";
import {
	chmod,
	link,
	readFile,
	readdir,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
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

for (const target of ["owner.lock", "db/sidecar"]) {
	for (const mutation of ["public", "hardlink", "symlink"] as const) {
		test(`namespace rejects ${mutation} ${target} and releases acquired lock`, async (t) => {
			const f = await persistenceFixture(t);
			const runtime = await f.runtime();
			await runtime.createSession(f.cwd);
			await runtime.close();
			const path = join(f.sessions, target);
			if (target !== "owner.lock") await writeFile(path, "", { mode: 0o600 });
			const outside = join(f.root, "outside");
			if (mutation === "public") await chmod(path, 0o644);
			if (mutation === "hardlink") await link(path, outside);
			if (mutation === "symlink") {
				await unlink(path);
				await writeFile(outside, "", { mode: 0o600 });
				await symlink(outside, path);
			}
			await assert.rejects(
				FilesystemSessionStore.open(f.sessions),
				/private|linked|symbolic|ELOOP/,
			);
			if (mutation === "public") await chmod(path, 0o600);
			if (mutation === "hardlink") await unlink(outside);
			if (mutation === "symlink") {
				await unlink(path);
				await writeFile(path, "", { mode: 0o600 });
			}
			const next = await FilesystemSessionStore.open(f.sessions);
			await next.close();
		});
	}
}

for (const target of ["main", "document"] as const) {
	for (const mutation of ["public", "hardlink", "symlink"] as const) {
		test(`Runtime rejects ${mutation} of real JSONL ${target} before writes and releases its lock`, async (t) => {
			const f = await persistenceFixture(t);
			const first = await f.runtime();
			const a = await first.createSession(f.cwd);
			await first.close();
			const directory = join(f.sessions, "db");
			const name =
				target === "main"
					? "main.jsonl"
					: (await readdir(directory)).find((name) => name.startsWith("doc-"));
			assert.ok(name);
			const path = join(directory, name);
			const original = await readFile(path);
			const outside = join(f.root, "outside");
			if (mutation === "public") await chmod(path, 0o644);
			if (mutation === "hardlink") await link(path, outside);
			if (mutation === "symlink") {
				await unlink(path);
				await writeFile(outside, original, { mode: 0o600 });
				await symlink(outside, path);
			}
			await assert.rejects(f.runtime(), /private|linked|symbolic/);
			assert.deepEqual(await readFile(path), original);
			if (mutation === "public") await chmod(path, 0o600);
			if (mutation === "hardlink") await unlink(outside);
			if (mutation === "symlink") {
				await unlink(path);
				await writeFile(path, original, { mode: 0o600 });
			}
			const next = await f.runtime();
			assert.equal((await next.loadSession(a.id, f.cwd)).id, a.id);
		});
	}
}
