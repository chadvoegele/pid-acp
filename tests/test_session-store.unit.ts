import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openSessionStore } from "../dist/session-store.js";
import { persistenceFixture } from "./helpers/persistence.ts";

test("transient runtime store retains exactly one native MemoryStorage", async () => {
	const store = await openSessionStore();
	assert.equal(store.persistent, false);
	const storage = await store.openStorage();
	assert.ok(storage instanceof MemoryStorage);
	assert.equal(await store.openStorage(), storage);
	await storage.close(context);
	await store.close();
});

test("shared filesystem lifecycle retains namespace ownership until explicit release", async (t) => {
	const f = await persistenceFixture(t);
	const store = await openSessionStore(f.sessions);
	assert.equal(store.persistent, true);
	const storage = await store.openStorage();
	await assert.rejects(openSessionStore(f.sessions), /already owned/);
	await storage.close(context);
	await store.close();
	const next = await openSessionStore(f.sessions);
	await next.close();
});
