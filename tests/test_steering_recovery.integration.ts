import assert from "node:assert/strict";
import { test } from "node:test";
import { client } from "@agentclientprotocol/sdk";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AcpServerFixture } from "./helpers/acp-server-fixture.ts";
import { Runtime } from "../dist/runtime.js";
import { persistenceFixture } from "./helpers/persistence.ts";

test("ACP load steers recovered work without a prompt and isolates idle siblings", {
	timeout: 8000,
}, async (t) => {
	const f = await persistenceFixture(t);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	t.after(() => release.resolve());
	const provider = fauxProvider();
	provider.setResponses([
		async () => {
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{ command: "printf recovered" },
					{ id: "recovered-tool" },
				),
				{ stopReason: "toolUse" },
			);
		},
		async (request) => {
			assert.ok(
				request.messages.some(
					(m) => m.role === "user" && m.content === "recovered steering",
				),
			);
			return fauxAssistantMessage("recovered answer");
		},
	]);
	const models = createModels();
	models.setProvider(provider.provider);
	const runtime = await Runtime.open(
		models,
		{ provider: "faux", modelId: "faux-1" },
		"off",
		{ instructionsPath: "", skillsDir: "" },
		f.sessions,
	);
	const a = await runtime.createSession(f.cwd);
	const b = await runtime.createSession(f.cwd);
	const native = await a.conversation.submit(
		{ type: "input", content: "background work" },
		context,
	);
	await entered.promise;
	const server = new AcpServerFixture(runtime);
	const connection = client().connect(server.createApp());
	t.after(async () => {
		release.resolve();
		connection.close();
		await server.close();
	});
	const agent = connection.agent;
	await agent.request("session/load", {
		sessionId: a.id,
		cwd: f.cwd,
		mcpServers: [],
	});
	await agent.request("session/load", {
		sessionId: b.id,
		cwd: f.cwd,
		mcpServers: [],
	});
	await assert.rejects(
		agent.request("session/prompt", {
			sessionId: a.id,
			prompt: [{ type: "text", text: "busy" }],
		}),
		/already active/,
	);
	assert.deepEqual(
		await agent.request("_session/steering", {
			sessionId: b.id,
			prompt: [{ type: "text", text: "idle" }],
		}),
		{ outcome: "promptRequired", reason: "noRunningTurn" },
	);
	assert.deepEqual(
		await agent.request("_session/steering", {
			sessionId: a.id,
			prompt: [{ type: "text", text: "recovered steering" }],
		}),
		{ outcome: "injected" },
	);
	assert.equal((await b.conversation.context(context)).messages.length, 0);
	release.resolve();
	assert.equal((await native.wait(context)).status, "done");
	assert.equal(
		(await a.conversation.context(context)).messages.filter(
			(m) => m.role === "user" && m.content === "recovered steering",
		).length,
		1,
	);
});
