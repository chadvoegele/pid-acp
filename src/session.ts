import type { Conversation, Harness } from "@earendil-works/pi-durable";

// An attachment handle. Runtime, not this handle, owns native execution and resources.
export class Session {
	private released = false;
	private closing?: Promise<void>;
	constructor(
		readonly id: string,
		readonly conversation: Conversation,
		readonly harness: Harness,
		private readonly isFailed: () => boolean,
	) {}
	get failed() {
		return this.isFailed();
	}
	get closed() {
		return this.released;
	}
	close(): Promise<void> {
		this.released = true;
		this.closing ??= Promise.resolve();
		return this.closing;
	}
}
