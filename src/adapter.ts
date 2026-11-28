import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";
import {
	BACKGROUND_CONTEXT as context,
	awaitWithContext,
	withCancel,
} from "@earendil-works/chord/context";
import {
	ConversationBusy,
	ConversationIdle,
	LiveDoc,
	type ConversationWatch,
	type LiveState,
	type Submission,
} from "@earendil-works/pi-durable";
import { EventBridge, createHistoryUpdates } from "./events.js";
import { logger } from "./logger.js";
import type { Session } from "./session.js";

type Sink = (update: SessionUpdate) => Promise<void>;
type RequestDelivery = { cancellationSends?: Promise<void> };

export class Adapter {
	private shutdown?: Promise<void>;
	private closing = false;
	private deliveryFailed = false;
	private watch?: ConversationWatch;
	private callback: Promise<void> = Promise.resolve();
	private sending: Promise<void> = Promise.resolve();
	// Only admission and explicit abort are ordered, never execution or delivery.
	private operations: Promise<void> = Promise.resolve();
	private readonly requests = new Set<RequestDelivery>();
	private readonly attachment = withCancel(context);
	constructor(private readonly session: Session) {}

	private requireSession(id: string) {
		if (this.closing || this.deliveryFailed || this.session.failed)
			throw new RequestError(-32000, "Server is shutting down.");
		if (this.session.id !== id)
			throw new RequestError(
				-32602,
				"Unknown session ID. Create a session first.",
			);
		return this.session;
	}

	async attach(send: Sink, replay = false) {
		if (this.watch)
			throw new Error("Session presentation is already attached.");
		const conversation = this.session.conversation;
		const live = replay
			? await this.session.harness.snapshot(LiveDoc, conversation.id, context)
			: undefined;
		const snapshot = replay ? await conversation.context(context) : undefined;
		const watch = await conversation.watch(context);
		this.watch = watch;
		const notify: Sink = (update) => {
			this.attachment.context.abortSignal?.throwIfAborted();
			this.sending = awaitWithContext(send(update), this.attachment.context);
			return this.sending;
		};
		const bridge = new EventBridge(
			snapshot?.entries ?? watch.value.entries,
			notify,
			replay,
		);
		if (snapshot) {
			const watched = watch.value.docs["pi.live"] as LiveState | undefined;
			const pendingTools = new Set(
				[...(live?.tools ?? []), ...(watched?.tools ?? [])]
					.filter((slot) => slot.status !== "done" || slot.entry !== undefined)
					.map((slot) => slot.callId),
			);
			for (const update of createHistoryUpdates(snapshot, pendingTools))
				await notify(update);
		}
		await bridge.accept(watch.value, conversation);
		watch.start((call) => {
			this.callback = this.deliver(call, bridge);
			return this.callback;
		});
		void watch.closed.then(() => {
			if (this.watch === watch && !this.closing) this.failDelivery();
		});
	}

	private async deliver(
		call: Parameters<Parameters<ConversationWatch["start"]>[0]>[0],
		bridge: EventBridge,
	) {
		try {
			if (call.kind !== "value") throw call.error;
			await bridge.accept(call.value, this.session.conversation);
		} catch {
			this.failDelivery();
			void this.watch?.stop();
		}
	}
	private failDelivery() {
		this.deliveryFailed = true;
		this.attachment.cancel(new Error("Attachment stopped."));
	}
	private async stopWatch() {
		const watch = this.watch;
		this.watch = undefined;
		await watch?.stop();
		await this.callback;
	}

	private order<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operations.then(operation);
		this.operations = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	private async inspectWork() {
		const inspection = await this.session.harness.inspect(context);
		return {
			tasks: inspection.tasks.filter(
				(task) => task.record.conversationId === this.session.conversation.id,
			),
			submissions: inspection.submissions.filter(
				(submission) =>
					submission.conversationId === this.session.conversation.id,
			),
		};
	}

	private async requireAdmission(id: string) {
		const { tasks } = await this.inspectWork();
		if (tasks.some((task) => task.state.kind === "blocked"))
			throw new RequestError(
				-32000,
				"Saved work is blocked by an unavailable or incompatible task definition. Restore compatible runtime code or use Durable tooling before prompting.",
			);
		this.requireSession(id);
		if (!this.watch) throw new Error("Session presentation is not attached.");
	}

	async steer(sessionId: string, content: string) {
		this.requireSession(sessionId);
		try {
			await this.order(async () => {
				await this.requireAdmission(sessionId);
				await this.session.conversation.submit(
					{ type: "input", content, whenBusy: "steer", whenIdle: "reject" },
					context,
				);
			});
			return { outcome: "injected" as const };
		} catch (error) {
			if (error instanceof ConversationIdle) {
				this.requireSession(sessionId);
				return {
					outcome: "promptRequired" as const,
					reason: "noRunningTurn" as const,
				};
			}
			this.failPrompt(error);
		}
	}

	async prompt(sessionId: string, content: string) {
		this.requireSession(sessionId);
		const request: RequestDelivery = {};
		this.requests.add(request);
		try {
			const submission = await this.order(async () => {
				await this.requireAdmission(sessionId);
				return this.session.conversation.submit(
					{ type: "input", content, whenBusy: "followUp" },
					context,
				);
			});
			return await this.finishPrompt(submission, request);
		} catch (error) {
			this.failPrompt(error);
		} finally {
			this.requests.delete(request);
		}
	}
	private failPrompt(error: unknown): never {
		if (error instanceof RequestError) throw error;
		if (error instanceof ConversationBusy)
			throw new RequestError(
				-32000,
				"A prompt is already active. Cancel it or wait for completion.",
			);
		if (this.session.failed) {
			logger.error(
				"pid-acp: Session storage failed; admission stopped. Check private session storage and available disk space.",
			);
			throw new RequestError(
				-32603,
				"Session storage failed. The server must close; inspect storage and restart.",
			);
		}
		if (this.closing || this.deliveryFailed)
			throw new RequestError(
				-32000,
				"Server stopped before prompt completion. Reconnect and load the saved session.",
			);
		logger.error(
			"pid-acp: Prompt failed; check provider connectivity, model configuration and credentials.",
		);
		throw new RequestError(
			-32603,
			"Prompt failed. Check server diagnostics and provider configuration.",
		);
	}
	private async finishPrompt(submission: Submission, request: RequestDelivery) {
		const result = await submission.wait(this.attachment.context);
		this.attachment.context.abortSignal?.throwIfAborted();
		if (this.session.failed) throw new Error("Session storage failed.");
		if (result.status === "unanswered" && result.reason === "aborted") {
			// Capture-only boundary: never join a future watch callback or native tail.
			if (request.cancellationSends) await request.cancellationSends;
			this.attachment.context.abortSignal?.throwIfAborted();
			if (this.session.failed) throw new Error("Session storage failed.");
			return { stopReason: "cancelled" as const };
		}
		if (
			result.status === "unanswered" &&
			result.reason === "model_error" &&
			typeof result.detail === "string" &&
			result.detail.trim().length > 0
		)
			throw new RequestError(-32603, result.detail);
		if (result.status !== "done")
			throw new Error("Provider or Durable run failed.");
		return { stopReason: "end_turn" as const };
	}
	async cancel(id: string) {
		this.requireSession(id);
		const sends = this.sending;
		for (const request of this.requests) request.cancellationSends ??= sends;
		const cancelled = this.order(async () => {
			const { tasks, submissions } = await this.inspectWork();
			if (this.closing) return;
			if (tasks.length || submissions.length)
				await this.session.conversation.abort(context);
		});
		return Promise.all([cancelled, sends]).then(
			() => {},
			() => {
				throw new RequestError(
					-32603,
					"Could not cancel session. Check server diagnostics and retry.",
				);
			},
		);
	}
	stopAdmission() {
		this.closing = true;
		this.attachment.cancel(new Error("Attachment stopped."));
	}
	close(): Promise<void> {
		this.stopAdmission();
		this.shutdown ??= this.closeSession();
		return this.shutdown;
	}
	private async closeSession() {
		await this.operations;
		try {
			await this.stopWatch();
		} finally {
			await this.session.close();
		}
	}
}
