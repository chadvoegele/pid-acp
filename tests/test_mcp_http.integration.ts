import assert from "node:assert/strict";
import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { McpAdapter } from "../dist/mcp.js";
import { startMcpHttpFixture } from "./helpers/mcp-http-fixture.ts";
import { fixtureTool } from "./helpers/mcp-fixture.ts";

async function listen(
	t: TestContext,
	handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
	const server = createServer(handle);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}/mcp`;
}
async function prepare(t: TestContext, urls: string[]) {
	const adapter = new McpAdapter({
		servers: urls.map((url, index) => ({
			kind: "http",
			name: `fixture${index}`,
			config: {
				url,
				headers: { Authorization: "Bearer PRIVATE_FIXTURE_TOKEN" },
				timeout: 1,
				exposure: "codemode",
			},
		})),
	});
	t.after(async () => {
		await adapter.close();
	});
	return (await adapter.discover(tmpdir())).tools.map((tool) => tool.name);
}

for (const status of [301, 302, 303, 307, 308]) {
	test(`HTTP ${status} redirects never forward credentials or MCP requests to another origin`, async (t) => {
		let forwarded = 0;
		const target = await listen(t, (_request, response) => {
			forwarded++;
			response.writeHead(500).end();
		});
		let attempts = 0;
		const redirect = await listen(t, (_request, response) => {
			attempts++;
			response.writeHead(status, { location: target }).end();
		});
		await assert.rejects(prepare(t, [redirect]), /startup discovery failed/);
		assert.equal(attempts, 1);
		assert.equal(forwarded, 0);
	});
}

for (const status of [401, 403]) {
	test(`HTTP ${status} aborts startup discovery without exposing its body`, async (t) => {
		const failed = await listen(t, (_request, response) =>
			response.writeHead(status).end("PRIVATE_AUTH_BODY"),
		);
		const healthy = await startMcpHttpFixture();
		t.after(() => healthy.close());
		await assert.rejects(prepare(t, [failed, healthy.url]), (error: Error) => {
			assert.match(error.message, /startup discovery failed/);
			assert.doesNotMatch(
				error.message,
				/PRIVATE_AUTH_BODY|PRIVATE_FIXTURE_TOKEN/,
			);
			return true;
		});
		assert.equal(healthy.requests.length, 0);
	});
}

test("real HTTP message limit rejects an oversized discovery response atomically", async (t) => {
	const fixture = await startMcpHttpFixture();
	t.after(() => fixture.close());
	fixture.setTools([
		{ ...fixtureTool("oversized"), description: "x".repeat(16 * 1024 * 1024) },
	]);
	await assert.rejects(prepare(t, [fixture.url]), /startup discovery failed/);
	assert.equal(
		fixture.requests.filter((record) => record.message.method === "initialize")
			.length,
		1,
	);
	assert.equal(fixture.deleted.length, 1);
});
