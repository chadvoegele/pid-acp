import { AcpServer } from "../../dist/acp-server.js";
import type { Runtime } from "../../dist/runtime.js";

// In-process fixtures own both the connection and its Runtime.
export class AcpServerFixture extends AcpServer {
	private releasing?: Promise<void>;
	private readonly ownedRuntime: Runtime;
	constructor(runtime: Runtime) {
		super(runtime);
		this.ownedRuntime = runtime;
	}

	close() {
		this.releasing ??= this.release();
		return this.releasing;
	}

	private async release() {
		const [detached] = await Promise.allSettled([this.detach()]);
		const [closed] = await Promise.allSettled([this.ownedRuntime.close()]);
		if (detached.status === "rejected" || closed.status === "rejected")
			throw new Error("Could not release shared session resources.");
	}
}
