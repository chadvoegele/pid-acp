import { Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { AcpServer } from "../../dist/acp-server.js";
import { Runtime } from "../../dist/runtime.js";

import { serve } from "../../dist/stdio-server.js";

const opening = Promise.withResolvers<void>();
const cleanup = Promise.withResolvers<void>();
let options: HarnessOptions | undefined;
process.on("message", (message) => {
	if (message === "release-open") opening.resolve();
	if (message === "release-cleanup") cleanup.resolve();
	if (message === "storage-failure")
		options?.onReport?.({
			error: new Error("PRIVATE_STORAGE"),
			kind: "storage_failed",
		});
});
const open = Harness.open;
Harness.open = async (...args: Parameters<typeof open>) => {
	options = args[1];
	return open(...args);
};
const create = Runtime.prototype.createSession;
Runtime.prototype.createSession = async function (...args) {
	const session = await create.call(this, ...args);
	const close = session.close.bind(session);
	session.close = async () => {
		await close();
		process.send?.("rolled-back");
	};
	process.send?.("opening");
	await opening.promise;
	return session;
};
const release = Runtime.prototype.close;
Runtime.prototype.close = function () {
	process.send?.("cleanup");
	return (async () => {
		if (process.env.PID_TEST_DEFER_CLEANUP) await cleanup.promise;
		await release.call(this);
		process.send?.("released");
		if (process.env.PID_TEST_FAIL_CLEANUP) {
			process.send?.("close-error");
			throw new Error("PRIVATE_CLEANUP");
		}
	})();
};
const detach = AcpServer.prototype.detach;
AcpServer.prototype.detach = function () {
	process.send?.("close-attempt");
	return detach.call(this);
};
const runtime = await Runtime.open(
	createModels(),
	{ provider: "unused", modelId: "unused" },
	"off",
	{ instructionsPath: "", skillsDir: "" },
	process.env.PID_ACP_SESSIONS_DIR,
);
await serve(runtime);
process.disconnect?.();
