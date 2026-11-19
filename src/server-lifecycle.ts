import type { Stream } from "@agentclientprotocol/sdk";
import { AcpServer } from "./acp-server.js";
import { logger } from "./logger.js";
import type { Runtime } from "./runtime.js";

const shutdownTimeoutMs = 4000;

function exitOnDeadline(): never {
	logger.error("pid-acp: Shutdown deadline exceeded.");
	process.exit(1);
}

export function openConnection(runtime: Runtime, stream: Stream) {
	const acp = new AcpServer(runtime);
	const wire = acp.createApp().connect(stream);
	let draining: Promise<void> | undefined;
	return {
		ended: wire.closed,
		close() {
			if (!draining) {
				draining = acp.detach();
				wire.close();
			}
			return draining;
		},
	};
}

type Transport = {
	readonly ended: Promise<void>;
	close(): Promise<void>;
};

async function closeServer(transport: Transport | undefined, runtime: Runtime) {
	try {
		await transport?.close();
	} finally {
		await runtime.close();
	}
}

export async function serveRuntime(runtime: Runtime, start: () => Transport) {
	const signal = Promise.withResolvers<void>();
	let signalled = false;
	const handleSignal = () => {
		signalled = true;
		signal.resolve();
	};
	process.on("SIGINT", handleSignal);
	process.on("SIGTERM", handleSignal);
	let transport: Transport | undefined;
	try {
		transport = start();
		await Promise.race([transport.ended, runtime.failure, signal.promise]);
	} finally {
		const deadline = setTimeout(exitOnDeadline, shutdownTimeoutMs);
		try {
			await closeServer(transport, runtime);
		} catch {
			process.exitCode = 1;
			logger.error(
				"pid-acp: Shutdown failed; check session storage and execution environment cleanup.",
			);
		} finally {
			clearTimeout(deadline);
			process.off("SIGINT", handleSignal);
			process.off("SIGTERM", handleSignal);
		}
		if (runtime.failed) {
			process.exitCode = 1;
			logger.error(
				"pid-acp: Session storage failed; closing server. Check private session storage and available disk space.",
			);
		}
	}
	if (signalled) process.exit(process.exitCode ?? 0);
}
