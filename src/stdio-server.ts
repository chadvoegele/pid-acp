import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { Runtime } from "./runtime.js";
import { openConnection, serveRuntime } from "./server-lifecycle.js";

export function serve(runtime: Runtime) {
	return serveRuntime(runtime, () =>
		openConnection(
			runtime,
			ndJsonStream(
				Writable.toWeb(process.stdout),
				Readable.toWeb(process.stdin),
			),
		),
	);
}
