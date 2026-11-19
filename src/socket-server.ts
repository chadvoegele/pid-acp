import { chmodSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { Duplex } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { SocketConfigurationError } from "./config.js";
import type { Runtime } from "./runtime.js";
import { openConnection, serveRuntime } from "./server-lifecycle.js";

function checkParent(path: string) {
	try {
		const parent = statSync(dirname(path));
		if (
			parent.isDirectory() &&
			parent.uid === process.geteuid?.() &&
			(parent.mode & 0o7777) === 0o700
		)
			return;
	} catch {
		// Report the same corrective action for inaccessible and missing directories.
	}
	throw new SocketConfigurationError(
		"Create an accessible PID_ACP_SOCKET_PATH parent directory with mode 0700, owned by the service user.",
	);
}

function attachSocket(runtime: Runtime, socket: Socket) {
	socket.on("error", () => socket.destroy());
	const { readable, writable } = Duplex.toWeb(socket);
	const connection = openConnection(runtime, ndJsonStream(writable, readable));
	return {
		ended: connection.ended,
		close() {
			const drained = connection.close();
			socket.destroy();
			return drained;
		},
	};
}

function closeListener(listener: Server) {
	if (!listener.listening) return Promise.resolve();
	// Node removes the bound endpoint when it closes its Unix listener.
	return new Promise<void>((resolve, reject) =>
		listener.close((error) => (error ? reject(error) : resolve())),
	);
}

function startListener(runtime: Runtime, path: string) {
	checkParent(path);
	const failure = Promise.withResolvers<never>();
	const connections = new Set<ReturnType<typeof attachSocket>>();
	let accepting = false;
	let stopping = false;
	const listener = createServer((socket) => {
		if (!accepting) {
			socket.destroy();
			return;
		}
		const connection = attachSocket(runtime, socket);
		connections.add(connection);
		void connection.ended.then(connection.close).then(
			() => connections.delete(connection),
			() =>
				failure.reject(
					new SocketConfigurationError(
						"Could not release socket sessions. Check session storage and restart.",
					),
				),
		);
	});
	const failListen = () => {
		accepting = false;
		failure.reject(
			new SocketConfigurationError(
				"Unix socket listener failed. Set PID_ACP_SOCKET_PATH to a valid, unused path in a private directory. Remove a stale socket only after confirming its listener is gone.",
			),
		);
	};
	listener.on("error", failListen);
	try {
		listener.listen(path, () => {
			if (stopping) return;
			try {
				chmodSync(path, 0o600);
				accepting = true;
			} catch {
				failure.reject(
					new SocketConfigurationError(
						"Could not set Unix socket mode 0600. Check service ownership and filesystem permissions.",
					),
				);
			}
		});
	} catch {
		failListen();
	}
	return {
		ended: failure.promise,
		async close() {
			stopping = true;
			accepting = false;
			const results = await Promise.allSettled([
				closeListener(listener),
				...[...connections].map((connection) => connection.close()),
			]);
			if (results.some((result) => result.status === "rejected"))
				throw new Error("Could not close socket listener and sessions.");
		},
	};
}

export function serveSocket(runtime: Runtime, path: string) {
	return serveRuntime(runtime, () => startListener(runtime, path));
}
