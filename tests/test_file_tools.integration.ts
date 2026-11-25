import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startClient } from "./helpers/client.ts";
import { readText, requireToolUpdate } from "./helpers/updates.ts";

test("vision-capable native read keeps image pixels through provider transformation and ACP", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pid-vision-"));
	const client = await startClient({
		live: true,
		cwd,
		env: {
			PID_ACP_PROVIDERS: resolve("tests/helpers/file-provider.ts"),
			PID_ACP_MODEL: "files",
			PID_ACP_THINKING: "off",
			FILE_VISION: "1",
		},
	});
	try {
		const data =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
		await writeFile(join(cwd, "pixel.png"), Buffer.from(data, "base64"));
		assert.equal(
			(
				await client.prompt(
					JSON.stringify({ name: "read", args: { path: "pixel.png" } }),
				)
			).stopReason,
			"end_turn",
		);
		await client.waitForAnswer((text) => {
			try {
				JSON.parse(text);
				return true;
			} catch {
				return false;
			}
		});
		const result = JSON.parse(client.updates.map(readText).join("")) as {
			content: unknown[];
		};
		assert.deepEqual(result.content[0], {
			type: "image",
			data,
			mimeType: "image/png",
		});
		const final = client.updates.find(
			(update) => "status" in update && update.status === "completed",
		);
		assert.ok(final);
		assert.deepEqual(requireToolUpdate(final).content?.[0], {
			type: "content",
			content: { type: "image", data, mimeType: "image/png" },
		});
		const tooWide = Buffer.from(data, "base64");
		tooWide.writeUInt32BE(2, 16);
		for (const [path, bytes, diagnostic] of [
			["wide.png", tooWide, /larger than 1x1/],
			[
				"bytes.png",
				Buffer.concat([Buffer.from(data, "base64"), Buffer.alloc(1024)]),
				/too large to send/,
			],
			[
				"broken.png",
				Buffer.from(data, "base64").subarray(0, 16),
				/size cannot be read/,
			],
		] as const) {
			await writeFile(join(cwd, path), bytes);
			const start = client.updates.length;
			assert.equal(
				(await client.prompt(JSON.stringify({ name: "read", args: { path } })))
					.stopReason,
				"end_turn",
			);
			await client.waitForAnswer((text) => {
				try {
					JSON.parse(text);
					return true;
				} catch {
					return false;
				}
			}, start);
			const failed = client.updates
				.slice(start)
				.find((update) => "status" in update && update.status === "failed");
			assert.ok(failed, `Expected failed image read for ${path}`);
			assert.match(
				JSON.stringify(requireToolUpdate(failed).rawOutput),
				diagnostic,
			);
		}
		await assert.rejects(
			client.request("session/prompt", {
				sessionId: client.session?.sessionId ?? "",
				prompt: [{ type: "image", data, mimeType: "image/png" }],
			}),
		);
		assert.equal(client.stderr, "");
	} finally {
		await client.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
