import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { socketFixture } from "./helpers/socket-client.ts";

const options = { timeout: 15000 };

test(
	"socket startup validates paths and permissions, preserves collisions, and releases storage",
	options,
	async (t) => {
		const f = await socketFixture(t);
		async function fail(
			path: string,
			diagnostic: RegExp,
			runtimeOpened = true,
			overrides: NodeJS.ProcessEnv = {},
		) {
			const host = f.launch({ PID_ACP_SOCKET_PATH: path, ...overrides });
			assert.deepEqual(await host.exited, [1, null]);
			assert.equal(host.stdout, "");
			assert.match(host.stderr, diagnostic);
			assert.equal(host.events.includes("runtime-open"), runtimeOpened);
			assert.equal(host.events.includes("runtime-closed"), runtimeOpened);
		}
		await fail("", /nonempty absolute Unix socket/, false);
		await fail("relative.sock", /nonempty absolute Unix socket/, false);
		await fail(`${f.path}/`, /valid, unused path/);
		await fail(f.path, /owned by the service user/, true, {
			PID_TEST_FOREIGN_OWNER: "1",
		});
		await chmod(f.cwd, 0o750);
		await fail(f.path, /mode 0700, owned by the service user/);
		await chmod(f.cwd, 0o700);

		await writeFile(f.path, "keep", { mode: 0o640 });
		const file = await lstat(f.path);
		await fail(f.path, /valid, unused path/);
		assert.equal((await lstat(f.path)).ino, file.ino);
		assert.equal((await lstat(f.path)).mode, file.mode);
		assert.equal(await readFile(f.path, "utf8"), "keep");
		await rm(f.path);

		const host = f.launch();
		await host.wait("listening");
		const bound = await lstat(f.path);
		assert.ok(bound.isSocket());
		assert.equal(bound.uid, process.geteuid?.());
		assert.equal(bound.mode & 0o777, 0o600);
		const collision = f.launch({ PID_ACP_SESSIONS_DIR: undefined });
		assert.deepEqual(await collision.exited, [1, null]);
		assert.match(collision.stderr, /valid, unused path/);
		assert.equal((await lstat(f.path)).ino, bound.ino);
		const client = await f.connect();
		assert.equal(client.initialized.agentCapabilities?.loadSession, true);

		host.child.kill("SIGKILL");
		await host.exited;
		await fail(f.path, /Remove a stale socket only after confirming/);
		assert.equal((await lstat(f.path)).ino, bound.ino);
		await rm(f.path);

		const restart = f.launch();
		await restart.wait("listening");
		restart.child.kill("SIGINT");
		assert.deepEqual(await restart.exited, [0, null]);
		await assert.rejects(lstat(f.path), { code: "ENOENT" });
	},
);

test(
	"SDK frames split and coalesced writes and keeps malformed JSON errors local",
	options,
	async (t) => {
		const f = await socketFixture(t);
		const host = f.launch({ PID_ACP_SESSIONS_DIR: undefined });
		await host.wait("listening");
		const b = await f.connect();
		assert.equal(b.initialized.agentCapabilities?.loadSession, false);
		const raw = createConnection(f.path);
		t.after(() => {
			raw.destroy();
		});
		await once(raw, "connect");
		const frames = createInterface({ input: raw })[Symbol.asyncIterator]();
		const init = JSON.stringify({
			jsonrpc: "2.0",
			id: 0,
			method: "initialize",
			params: { protocolVersion: 1 },
		});
		await new Promise<void>((ok, fail) =>
			raw.write(init.slice(0, 20), (err) => (err ? fail(err) : ok())),
		);
		const open = JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "session/new",
			params: { cwd: f.cwd, mcpServers: [] },
		});
		raw.write(`${init.slice(20)}\n{malformed\n${open}\n`);
		const messages = [];
		for (let i = 0; i < 3; i++) {
			const frame = await frames.next();
			assert.ok(!frame.done);
			messages.push(JSON.parse(frame.value));
		}
		assert.equal(
			messages.find((message) => message.id === 0).result.protocolVersion,
			1,
		);
		assert.equal(
			messages.find((message) => message.id === null).error.code,
			-32700,
		);
		assert.equal(
			typeof messages.find((message) => message.id === 2).result.sessionId,
			"string",
		);
		const session = await b.newSession();
		await assert.rejects(b.load(session), /already attached/);
		b.close();
		await host.wait("detached");
		const next = await f.connect();
		await assert.rejects(next.load(session), /requires PID_ACP_SESSIONS_DIR/);
		assert.equal(
			(await next.prompt(await next.newSession(), "still usable")).stopReason,
			"end_turn",
		);
		host.child.kill("SIGTERM");
		assert.deepEqual(await host.exited, [0, null]);
		assert.equal(host.stdout, "");
		assert.equal(host.stderr, "");
	},
);

test(
	"separate sockets isolate equal request IDs, updates, steering, and cancellation",
	options,
	async (t) => {
		const f = await socketFixture(t);
		const host = f.launch();
		await host.wait("listening");
		const [a, b] = await Promise.all([f.connect(), f.connect()]);
		const [aId, bId] = await Promise.all([a.newSession(), b.newSession()]);
		// Both SDK connections have sent exactly initialize and session/new. Their next IDs match.
		const firstA = a.prompt(aId, "hold-alpha");
		const firstB = b.prompt(bId, "hold-beta");
		await Promise.all([
			host.wait("provider:hold-alpha"),
			host.wait("provider:hold-beta"),
		]);
		host.send("release:hold-beta");
		assert.equal((await firstB).stopReason, "end_turn");
		host.send("release:hold-alpha");
		assert.equal((await firstA).stopReason, "end_turn");

		const secondA = a.prompt(aId, "hold-cancel");
		const secondB = b.prompt(bId, "hold-keep");
		await Promise.all([
			host.wait("provider:hold-cancel"),
			host.wait("provider:hold-keep"),
		]);
		await assert.rejects(a.prompt(bId, "foreign"), /Unknown session ID/);
		await assert.rejects(a.steer(bId, "foreign"), /Unknown session ID/);
		await a.cancel(bId);
		await a.cancel(aId);
		assert.equal((await secondA).stopReason, "cancelled");
		host.send("release:hold-keep");
		assert.equal((await secondB).stopReason, "end_turn");
		assert.equal((await b.prompt(bId, "followup")).stopReason, "end_turn");
		await Promise.all([
			a.waitForText("Answer: hold-alpha"),
			b.waitForText("Answer: followup"),
		]);
		assert.ok(a.updates.every(({ sessionId }) => sessionId === aId));
		assert.ok(b.updates.every(({ sessionId }) => sessionId === bId));
		assert.equal(a.text(), "Answer: hold-alpha");
		assert.equal(
			b.text(),
			"Answer: hold-betaAnswer: hold-keepAnswer: followup",
		);
		assert.deepEqual(
			host.events.filter((event) => event.endsWith("-open")).sort(),
			["harness-open", "runtime-open"],
		);

		const competingPath = join(f.cwd, "other.sock");
		const competing = f.launch({ PID_ACP_SOCKET_PATH: competingPath });
		assert.deepEqual(await competing.exited, [1, null]);
		assert.ok(!competing.events.includes("runtime-open"));
		await assert.rejects(lstat(competingPath), { code: "ENOENT" });

		host.child.kill("SIGTERM");
		assert.deepEqual(await host.exited, [0, null]);
		assert.equal(host.stdout, "");
		assert.equal(host.stderr, "");
		assert.equal(
			host.events.filter((event) => event === "runtime-close").length,
			1,
		);
		assert.equal(host.events.filter((event) => event === "detached").length, 2);
		assert.ok(
			host.events.lastIndexOf("detached") <
				host.events.indexOf("runtime-close"),
		);
		await assert.rejects(lstat(f.path), { code: "ENOENT" });
	},
);

test(
	"disconnect preserves native work; interrupted replay rolls back; storage failure shuts down",
	options,
	async (t) => {
		const f = await socketFixture(t);
		const host = f.launch();
		await host.wait("listening");
		const [a, b] = await Promise.all([f.connect(), f.connect()]);
		const [aId, bId] = await Promise.all([a.newSession(), b.newSession()]);
		const missed = assert.rejects(a.prompt(aId, "hold-persist"));
		const other = b.prompt(bId, "hold-other");
		await Promise.all([
			host.wait("provider:hold-persist"),
			host.wait("provider:hold-other"),
		]);
		a.close();
		await missed;
		await host.wait("detached");
		assert.ok(!host.events.includes("runtime-close"));
		host.send("release:hold-other");
		assert.equal((await other).stopReason, "end_turn");
		host.send("observe-submission");
		await host.wait("submission-observed");
		host.send("release:hold-persist");
		await host.wait("submission:done");

		const resumed = await f.connect();
		await resumed.load(aId);
		assert.deepEqual(
			resumed.updates.map(({ sessionId, update }) => ({
				sessionId,
				kind: update.sessionUpdate,
				text:
					(update.sessionUpdate === "user_message_chunk" ||
						update.sessionUpdate === "agent_message_chunk") &&
					update.content.type === "text"
						? update.content.text
						: undefined,
			})),
			[
				{ sessionId: aId, kind: "user_message_chunk", text: "hold-persist" },
				{
					sessionId: aId,
					kind: "agent_message_chunk",
					text: "Answer: hold-persist",
				},
			],
		);
		assert.equal(
			host.events.filter((event) => event === "provider:hold-persist").length,
			1,
		);
		resumed.close();
		b.close();
		await host.wait("detached", 3);

		host.send("gate-replay");
		await host.wait("replay-armed");
		const interrupted = await f.connect();
		const lostLoad = assert.rejects(interrupted.load(aId));
		await host.wait("replaying");
		interrupted.close();
		await lostLoad;
		await host.wait("detached", 4);
		const last = await f.connect();
		await last.load(aId);
		assert.match(last.text(), /Answer: hold-persist/);
		assert.ok(!host.events.includes("runtime-close"));
		host.send("fail-storage");
		assert.deepEqual(await host.exited, [1, null]);
		assert.equal(host.stdout, "");
		assert.match(host.stderr, /Session storage failed; closing server/);
		assert.doesNotMatch(host.stderr, /PRIVATE_STORAGE/);
		assert.equal(
			host.events.filter((event) => event === "runtime-closed").length,
			1,
		);
		assert.ok(
			host.events.lastIndexOf("detached") <
				host.events.indexOf("runtime-close"),
		);
		await assert.rejects(lstat(f.path), { code: "ENOENT" });

		const reacquired = f.launch();
		await reacquired.wait("listening");
		reacquired.child.kill("SIGTERM");
		assert.deepEqual(await reacquired.exited, [0, null]);
	},
);

test(
	"fatal listener failure closes active sockets and releases the persistent root",
	options,
	async (t) => {
		const f = await socketFixture(t);
		const host = f.launch();
		await host.wait("listening");
		const a = await f.connect();
		await a.newSession();
		host.send("fail-listener");
		await a.wire.closed;
		assert.deepEqual(await host.exited, [1, null]);
		assert.equal(host.stdout, "");
		assert.match(host.stderr, /Unix socket listener failed/);
		assert.doesNotMatch(host.stderr, /PRIVATE_LISTENER/);
		assert.ok(
			host.events.indexOf("detached") < host.events.indexOf("runtime-close"),
		);
		assert.ok(host.events.includes("runtime-closed"));
		await assert.rejects(lstat(f.path), { code: "ENOENT" });

		const next = f.launch();
		await next.wait("listening");
		next.child.kill("SIGTERM");
		assert.deepEqual(await next.exited, [0, null]);
	},
);

for (const race of ["fail", "signal"] as const) {
	test(
		`shutdown joins disconnected peers and siblings before Runtime close: ${race}`,
		options,
		async (t) => {
			const f = await socketFixture(t);
			const host = f.launch({ PID_TEST_DETACH_RACE: race });
			await host.wait("listening");
			const a = await f.connect();
			await a.newSession();
			if (race === "fail") await (await f.connect()).newSession();
			a.close();
			await host.wait("holding-detach");
			if (race === "signal") host.child.kill("SIGTERM");
			await host.wait("listener-closing");
			assert.ok(!host.events.includes("runtime-close"));
			host.send("release-detach");
			assert.deepEqual(await host.exited, [race === "fail" ? 1 : 0, null]);
			assert.ok(host.events.includes("detached"));
			assert.ok(
				host.events.indexOf("detached") < host.events.indexOf("runtime-close"),
			);
			assert.equal(
				host.events.filter((event) => event === "runtime-close").length,
				1,
			);
			assert.doesNotMatch(host.stderr, /PRIVATE|deadline/);
			if (race === "fail")
				assert.match(host.stderr, /Could not release socket sessions/);
			await assert.rejects(lstat(f.path), { code: "ENOENT" });
			const next = f.launch();
			await next.wait("listening");
			next.child.kill("SIGTERM");
			assert.deepEqual(await next.exited, [0, null]);
		},
	);
}

test(
	"restart resumes interrupted native work without a socket client",
	options,
	async (t) => {
		const f = await socketFixture(t);
		const first = f.launch();
		await first.wait("listening");
		const a = await f.connect();
		const id = await a.newSession();
		const lost = assert.rejects(a.prompt(id, "hold-restart"));
		await first.wait("provider:hold-restart");
		a.close();
		await lost;
		await first.wait("detached");
		first.child.kill("SIGTERM");
		assert.deepEqual(await first.exited, [0, null]);
		const next = f.launch({ PID_TEST_RECOVER: "1" });
		await next.wait("provider:hold-restart");
		await next.wait("listening");
		const b = await f.connect();
		await b.load(id);
		await b.waitForText("Answer: hold-restart");
		assert.equal(
			next.events.filter((event) => event === "provider:hold-restart").length,
			1,
		);
		next.child.kill("SIGTERM");
		assert.deepEqual(await next.exited, [0, null]);
	},
);
