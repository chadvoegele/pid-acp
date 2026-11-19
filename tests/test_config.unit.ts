import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { readConfig, validateCwd, configureModels } from "../dist/config.js";
import { UserExtensionError } from "../dist/user-extensions.js";

const env = {
	PID_ACP_PROVIDER_CONFIG: resolve("tests/helpers/native-provider.ts"),
	PID_ACP_MODEL: "faux-1",
};

test("configuration requires an explicit absolute provider module and model", () => {
	assert.throws(() => readConfig({}), /PID_ACP_PROVIDER_CONFIG/);
	assert.throws(
		() => readConfig({ ...env, PID_ACP_PROVIDER_CONFIG: "relative.mjs" }),
		/PID_ACP_PROVIDER_CONFIG/,
	);
	assert.throws(
		() => readConfig({ ...env, PID_ACP_MODEL: " " }),
		/PID_ACP_MODEL/,
	);
	assert.deepEqual(readConfig(env), {
		providerConfig: env.PID_ACP_PROVIDER_CONFIG,
		modelId: "faux-1",
		thinkingLevel: "off",
		extensionPaths: [],
		mcpConfig: {
			path: join(homedir(), ".pi", "agent", "mcp.json"),
			required: false,
		},
		resources: {
			instructionsPath: join(homedir(), ".agents", "AGENTS.md"),
			skillsDir: join(homedir(), ".agents", "skills"),
		},
	});
});

test("user extension paths are opt-in and preserve configuration order", () => {
	for (const value of [undefined, "", "[]"])
		assert.deepEqual(
			readConfig({ ...env, PID_ACP_EXTENSIONS: value }).extensionPaths,
			[],
		);
	const paths = [resolve("z.mts"), resolve("a.mjs"), resolve("z.mts")];
	assert.deepEqual(
		readConfig({ ...env, PID_ACP_EXTENSIONS: JSON.stringify(paths) })
			.extensionPaths,
		paths,
	);
});

test("invalid extension configuration identifies the entry without echoing input", () => {
	const secret = "private-fixture-token";
	const invalidMembers = [
		null,
		1,
		false,
		{},
		[],
		"",
		"relative.mjs",
		"~/extension.mjs",
		"@scope/extension",
		`file:///${secret}/extension.mjs`,
		`https://user:${secret}@example.test/extension.mjs`,
		resolve("embedded\0null.mts"),
	];
	const inputs = [
		...[`["${secret}",`, "null", "{}", '"string"', "  "].map((value) => ({
			value,
			index: undefined,
		})),
		...invalidMembers.map((member) => ({
			value: JSON.stringify([resolve("ok.mjs"), member]),
			index: 1,
		})),
	];
	for (const { value, index } of inputs) {
		assert.throws(
			() => readConfig({ ...env, PID_ACP_EXTENSIONS: value }),
			(error) => {
				assert.ok(error instanceof UserExtensionError);
				assert.equal(error.name, "UserExtensionConfigError");
				const entry = index === undefined ? "" : ` entry ${index + 1}`;
				assert.ok(
					error.message.startsWith(`PID_ACP_EXTENSIONS${entry} (config):`),
				);
				assert.match(error.message, /JSON array of absolute paths/);
				assert.ok(!inspect(error).includes(secret));
				assert.equal(error.cause, undefined);
				return true;
			},
		);
	}
});

test("global resources have independent absolute overrides or can be disabled", () => {
	assert.deepEqual(
		readConfig({ ...env, PID_ACP_INSTRUCTIONS: "", PID_ACP_SKILLS_DIR: "" })
			.resources,
		{ instructionsPath: undefined, skillsDir: undefined },
	);
	assert.deepEqual(
		readConfig({
			...env,
			PID_ACP_INSTRUCTIONS: "/custom/rules.md",
			PID_ACP_SKILLS_DIR: "/custom/skills",
		}).resources,
		{ instructionsPath: "/custom/rules.md", skillsDir: "/custom/skills" },
	);
	assert.equal(
		readConfig({ ...env, PID_ACP_INSTRUCTIONS: "" }).resources.skillsDir,
		join(homedir(), ".agents", "skills"),
	);
	for (const name of ["PID_ACP_INSTRUCTIONS", "PID_ACP_SKILLS_DIR"])
		for (const value of ["relative", "~/not-expanded"])
			assert.throws(
				() => readConfig({ ...env, [name]: value }),
				new RegExp(name),
			);
});

test("native Pi AI provider registers unchanged without endpoint assumptions", async () => {
	const { default: provider } = await import("./helpers/native-provider.ts");
	const { models, model } = await configureModels(readConfig(env));
	assert.deepEqual(model, { provider: provider.id, modelId: "faux-1" });
	assert.deepEqual(models.getModels(), provider.getModels());
	assert.deepEqual(
		models.getModel(model.provider, model.modelId),
		provider.getModels()[0],
	);
	await assert.rejects(
		configureModels(readConfig({ ...env, PID_ACP_MODEL: "missing" })),
		/not registered/,
	);
});

test("thinking defaults off and validates all supported levels", () => {
	for (const value of [
		undefined,
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	])
		assert.equal(
			readConfig({ ...env, PID_ACP_THINKING: value }).thinkingLevel,
			value ?? "off",
		);
	for (const value of ["", "1", "true", "false", "LOW", "unknown"])
		assert.throws(
			() => readConfig({ ...env, PID_ACP_THINKING: value }),
			/PID_ACP_THINKING/,
		);
});

test("missing or invalid explicit modules fail rather than falling back to user settings", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pid-config-"));
	try {
		const path = join(dir, "provider.mjs");
		await assert.rejects(
			configureModels({ ...readConfig(env), providerConfig: path }),
		);
		for (const [name, value] of [
			["empty", "{}"],
			["missing-methods", "{ id: 'incomplete' }"],
			["missing-stream", "{ id: 'incomplete', getModels() { return [] } }"],
		]) {
			const providerConfig = join(dir, `${name}.mjs`);
			await writeFile(providerConfig, `export default ${value};`);
			await assert.rejects(
				configureModels({ ...readConfig(env), providerConfig }),
				/Pi AI Provider/,
			);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("cwd requires an existing absolute directory", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pid-unit-"));
	try {
		await validateCwd(dir);
		await writeFile(join(dir, "file"), "");
		for (const cwd of ["relative", join(dir, "missing"), join(dir, "file")])
			await assert.rejects(validateCwd(cwd), /absolute directory/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("persistent storage is opt-in and requires a nonempty absolute path", () => {
	assert.equal(readConfig(env).sessionsDir, undefined);
	assert.equal(
		readConfig({ ...env, PID_ACP_SESSIONS_DIR: "/private/sessions" })
			.sessionsDir,
		"/private/sessions",
	);
	for (const path of ["", "relative", "~/sessions", " "])
		assert.throws(
			() => readConfig({ ...env, PID_ACP_SESSIONS_DIR: path }),
			/PID_ACP_SESSIONS_DIR/,
		);
});
