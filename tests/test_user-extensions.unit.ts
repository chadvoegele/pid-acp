import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodingRegistry } from "../dist/conversation-resources.js";
import {
	loadUserExtensions,
	UserExtensionError,
} from "../dist/user-extensions.js";

async function createFixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pid-extensions-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

function expectFailure(category: string, index: number, hint: RegExp) {
	return (error: unknown) => {
		assert.ok(error instanceof UserExtensionError);
		assert.ok(
			error.message.startsWith(
				`PID_ACP_EXTENSIONS entry ${index + 1} (${category}):`,
			),
		);
		assert.match(error.message, hint);
		assert.equal(error.cause, undefined);
		assert.doesNotMatch(inspect(error), /private-fixture-token/);
		return true;
	};
}

test("no paths imports no extensions", async () => {
	assert.deepEqual(await loadUserExtensions([]), []);
});

test("same-name user extensions replace host and earlier user definitions", async (t) => {
	const root = await createFixture(t);
	const sandbox = new CodemodeSandbox();
	t.after(() => sandbox.close());
	const first = join(root, "first.mjs");
	const second = join(root, "second.mjs");
	const mcp = join(root, "mcp.mjs");
	await writeFile(
		first,
		'export default { name: "codemode", tools: [{ name: "first" }] };',
	);
	await writeFile(
		second,
		'export default { name: "codemode", tools: [{ name: "last" }] };',
	);
	await writeFile(mcp, 'export default { name: "mcp" };');
	const registry = await createCodingRegistry(sandbox, undefined, [
		first,
		mcp,
		second,
	]);
	const snapshot = registry.snapshot();
	assert.deepEqual(
		snapshot.installed().map(({ name }) => name),
		["coding", "skills", "codemode", "mcp"],
	);
	assert.deepEqual(
		snapshot.extension("codemode")?.tools?.map(({ name }) => name),
		["last"],
	);
});

test("loads all supported suffixes through native file URLs in configured order", async (context) => {
	const root = await createFixture(context);
	const dir = join(root, "extension");
	await mkdir(dir);
	await writeFile(join(dir, "package.json"), '{"type":"module"}');

	const first = join(root, "z #%.mjs");
	await writeFile(
		first,
		`import { writeFile } from "node:fs/promises";
		await writeFile(new URL("./ready", import.meta.url), "ordered");
		export default { name: "first" };`,
	);
	const second = join(dir, "index.ts");
	await writeFile(
		join(dir, "helper.mts"),
		'export const suffix: string = "second";',
	);
	await writeFile(
		second,
		`import { readFile } from "node:fs/promises";
		import { suffix } from "./helper.mts";
		const marker: string = await readFile(new URL("../ready", import.meta.url), "utf8");
		export default { name: marker + "-" + suffix };`,
	);
	const third = join(dir, "a.js");
	await writeFile(third, 'export default { name: "third" };');
	const fourth = join(root, "last.mts");
	await writeFile(
		fourth,
		'const name: string = "fourth"; export default { name };',
	);

	const loaded = await loadUserExtensions([first, dir, third, fourth]);
	assert.deepEqual(
		loaded.map(({ name }) => name),
		["first", "ordered-second", "third", "fourth"],
	);
});

test("directory resolution checks only supported top-level index files", async (context) => {
	const root = await createFixture(context);
	const nested = join(root, "nested");
	await mkdir(nested);
	await writeFile(
		join(nested, "index.mjs"),
		'export default { name: "nested" };',
	);
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({
			main: "./nested/index.mjs",
			exports: "./nested/index.mjs",
			pi: { extensions: ["./nested/index.mjs"] },
		}),
	);
	const rejectResolution = expectFailure(
		"resolution",
		0,
		/exactly one supported index file/,
	);
	await assert.rejects(loadUserExtensions([root]), rejectResolution);

	const a = join(root, "index.mjs");
	await writeFile(a, 'export default { name: "explicit" };');
	assert.deepEqual(await loadUserExtensions([root]), [{ name: "explicit" }]);
	await writeFile(join(root, "index.mts"), 'export default { name: "other" };');
	await assert.rejects(loadUserExtensions([root]), rejectResolution);
	assert.deepEqual(await loadUserExtensions([a]), [{ name: "explicit" }]);
});

test("missing and unsupported file paths report safe resolution errors", async (context) => {
	const root = await createFixture(context);
	const good = join(root, "good.mjs");
	const unsupported = join(root, "private-fixture-token.cjs");
	await writeFile(good, 'export default { name: "valid" };');
	await writeFile(unsupported, 'module.exports = { name: "unsupported" };');
	for (const path of [join(root, "private-fixture-token.mjs"), unsupported]) {
		await assert.rejects(
			loadUserExtensions([good, path]),
			expectFailure("resolution", 1, /Select a readable/),
		);
	}
});

test("follows file, directory, and index symlinks", async (context) => {
	const root = await createFixture(context);
	const module = join(root, "module.mjs");
	await writeFile(module, 'export default { name: "linked" };');
	const dir = join(root, "dir");
	await mkdir(dir);
	const index = join(dir, "index.mjs");
	const alias = join(root, "alias.mjs");
	const dirAlias = join(root, "dir-alias");
	await symlink("../module.mjs", index, "file");
	await symlink(module, alias, "file");
	await symlink(dir, dirAlias, "dir");

	const [original, linkedFile, linkedDir] = await loadUserExtensions([
		module,
		alias,
		dirAlias,
	]);
	assert.equal(linkedFile, original);
	assert.equal(linkedDir, original);
});

test("invalid defaults report export errors without invoking factories", async (context) => {
	const root = await createFixture(context);
	const sources = [
		'export const name = "not-default";',
		'export default function named() { throw Error("not called"); }',
		'export default Object.assign([], { name: "named-array" });',
		"export default null;",
		'export default "not-an-object";',
		"export default {};",
		"export default { name: 1 };",
		'export default { name: "" };',
		'export default { name: " " };',
		'export default { get name() { throw Error("private-fixture-token"); } };',
	];
	for (const [index, source] of sources.entries()) {
		const path = join(root, `invalid-${index}.mjs`);
		await writeFile(path, source);
		await assert.rejects(
			loadUserExtensions([path]),
			expectFailure("export", 0, /Default-export a Durable extension object/),
		);
	}
});

test("failed imports withhold raw errors and stop before later configured modules", async (context) => {
	const root = await createFixture(context);
	const failed = join(root, "private-fixture-token.mjs");
	const later = join(root, "later.mjs");
	await writeFile(failed, 'throw new Error("private-fixture-token");');
	await writeFile(
		later,
		'import { writeFile } from "node:fs/promises"; await writeFile(new URL("./ran", import.meta.url), "yes");',
	);
	await assert.rejects(
		loadUserExtensions([failed, later]),
		expectFailure("import", 0, /Check the module's syntax/),
	);
	assert.deepEqual((await readdir(root)).sort(), [
		"later.mjs",
		"private-fixture-token.mjs",
	]);
});
