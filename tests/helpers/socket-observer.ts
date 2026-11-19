import assert from "node:assert/strict";
import { Server } from "node:net";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { AcpServer } from "../../dist/acp-server.js";
import { Adapter } from "../../dist/adapter.js";
import { Runtime } from "../../dist/runtime.js";

let harness: Harness | undefined;
let options: HarnessOptions | undefined;

async function observePendingSubmission(harness: Harness) {
	const { submissions } = await harness.inspect(context);
	assert.equal(submissions.length, 1);
	const submission = await harness.submission(submissions[0].id, context);
	assert.ok(submission);
	process.send?.("submission-observed");
	const outcome = await submission.wait(context);
	process.send?.(`submission:${outcome.status}`);
}

const heldDetach = Promise.withResolvers<void>();
let detachCount = 0;
let replayGate = false;
let listener: Server | undefined;
if (process.env.PID_TEST_FOREIGN_OWNER) {
	const uid = process.geteuid?.() ?? 0;
	process.geteuid = () => uid + 1;
}
process.on("message", (message) => {
	if (message === "observe-submission" && harness)
		void observePendingSubmission(harness);
	if (message === "fail-listener")
		listener?.emit("error", new Error("PRIVATE_LISTENER"));
	if (message === "fail-storage")
		options?.onReport?.({
			kind: "storage_failed",
			error: new Error("PRIVATE_STORAGE"),
		});
	if (message === "release-detach") heldDetach.resolve();
	if (message === "gate-replay") {
		replayGate = true;
		process.send?.("replay-armed");
	}
});
process.channel?.unref();

const closeListener = Server.prototype.close;
Server.prototype.close = function (...args) {
	process.send?.("listener-closing");
	return closeListener.apply(this, args);
};

const emit = Server.prototype.emit;
Server.prototype.emit = function (
	this: Server,
	event: string | symbol,
	...args: unknown[]
) {
	const emitted = emit.call(this, event, ...args);
	if (event === "listening") {
		listener = this;
		process.send?.("listening");
	}
	return emitted;
};

const openHarness = Harness.open;
Harness.open = async (...args) => {
	options = args[1];
	process.send?.("harness-open");
	harness = await openHarness(...args);
	return harness;
};
const openRuntime = Runtime.open;
Runtime.open = async (...args) => {
	const runtime = await openRuntime(...args);
	process.send?.("runtime-open");
	return runtime;
};
const closeRuntime = Runtime.prototype.close;
Runtime.prototype.close = async function () {
	process.send?.("runtime-close");
	await closeRuntime.call(this);
	process.send?.("runtime-closed");
};

const attach = Adapter.prototype.attach;
Adapter.prototype.attach = function (send, replay) {
	if (!replay || !replayGate) return attach.call(this, send, replay);
	replayGate = false;
	return attach.call(
		this,
		async (update) => {
			await send(update);
			process.send?.("replaying");
			await new Promise<never>(() => {});
		},
		replay,
	);
};
const detach = AcpServer.prototype.detach;
AcpServer.prototype.detach = async function () {
	await detach.call(this);
	if (process.env.PID_TEST_DETACH_RACE) {
		const first = ++detachCount === 1;
		if (first && process.env.PID_TEST_DETACH_RACE === "fail")
			throw new Error("PRIVATE_DETACH");
		process.send?.("holding-detach");
		await heldDetach.promise;
	}
	process.send?.("detached");
};
