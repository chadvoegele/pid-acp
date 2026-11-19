import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import type { Session } from "../../dist/session.js";

// Exercise the public SDK environment callback without starting model work in lifecycle unit tests.
export function captureEnvironmentFactory(t: TestContext) {
	const factories = new Map<Harness, HarnessOptions["env"]>();
	const open = Harness.open;
	t.mock.method(
		Harness,
		"open",
		async (...args: Parameters<typeof Harness.open>) => {
			const harness = await open(...args);
			factories.set(harness, args[1].env);
			return harness;
		},
	);
	return async (session: Session, cwd: string) => {
		const factory = factories.get(session.harness);
		assert.ok(factory);
		return factory(
			{ cwd, conversationId: session.conversation.id, read: session.harness },
			context,
		);
	};
}
