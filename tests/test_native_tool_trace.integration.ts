import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { readNativeToolTrace } from "./helpers/native-tool-trace.ts";
import { persistenceFixture } from "./helpers/persistence.ts";

test("live trace helper follows actual native parent IDs and nested operations without comparing prompted source", async (t) => {
	const fixture = await persistenceFixture(t);
	const client = await fixture.client({
		PID_ACP_PROVIDER_CONFIG: resolve("tests/helpers/file-provider.ts"),
		PID_ACP_MODEL: "files",
	});
	const { sessionId } = await client.request("session/new", {
		cwd: fixture.cwd,
		mcpServers: [],
	});
	for (const code of [
		'await tools.write({ path: "value.txt", content: "value" }); text(JSON.stringify(await tools.read({ path: "value.txt" })))',
		'text(await tools.bash({ command: "pwd" }));',
	]) {
		await client.prompt(
			JSON.stringify({ name: "codemode", args: { code } }),
			sessionId,
		);
	}
	await client.close();
	const calls = client.updates.filter(
		(update) => update.sessionUpdate === "tool_call",
	);
	assert.equal(calls.length, 2);
	const traces = [];
	for (const call of calls) {
		const trace = await readNativeToolTrace(fixture.sessions, call.toolCallId);
		assert.equal(trace.call.id, call.toolCallId);
		assert.deepEqual(trace.call.arguments, call.rawInput);
		assert.equal(trace.state.status, "terminal");
		assert.ok(
			trace.nested.every(
				({ state }) =>
					state.status === "terminal" && state.outcome.status === "completed",
			),
		);
		traces.push(trace);
	}
	assert.deepEqual(
		traces.map((trace) => trace.nested.map(({ call }) => call.name)),
		[["write", "read"], ["bash"]],
	);
	await assert.rejects(
		readNativeToolTrace(fixture.sessions, "not-admitted"),
		/admitted native tool task/,
	);
});
