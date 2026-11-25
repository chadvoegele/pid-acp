import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { readConfig, validateCwd, configureModels } from "../dist/config.js";
import { UserExtensionError } from "../dist/user-extensions.js";

const env = {
	PID_ACP_PROVIDERS: resolve("tests/helpers/native-provider.ts"),
	PID_ACP_MODEL: "faux-1",
};

test("configuration requires a provider config and a literal model ID", () => {
	assert.throws(() => readConfig({}), /PID_ACP_PROVIDERS/);
	assert.throws(
		() => readConfig({ ...env, PID_ACP_PROVIDERS: "relative.mjs" }),
		/PID_ACP_PROVIDERS/,
	);
	assert.throws(
		() => readConfig({ ...env, PID_ACP_MODEL: " " }),
		/PID_ACP_MODEL/,
	);
	assert.deepEqual(readConfig(env), {
		providerPaths: [env.PID_ACP_PROVIDERS],
		providerId: undefined,
		modelId: "faux-1",
		thinkingLevel: "off",
		extensionPaths: [],
		mcpAuthFile: join(homedir(), ".pi", "agent", "mcp-auth.json"),
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

test("MCP auth file selection is independent of the server config", () => {
	const path = "/fixture/agent/mcp-auth.json";
	assert.equal(
		readConfig({ ...env, PID_ACP_MCP_CONFIG: "", PID_ACP_MCP_AUTH_FILE: path })
			.mcpAuthFile,
		path,
	);
	for (const invalid of [
		"",
		"mcp-auth.json",
		`${path}/`,
		"/fixture/copied.json",
	]) {
		assert.throws(
			() => readConfig({ ...env, PID_ACP_MCP_AUTH_FILE: invalid }),
			/PID_ACP_MCP_AUTH_FILE/,
		);
	}
});

test("provider paths accept a nonempty JSON array and preserve order and repeated paths", () => {
	const paths = [resolve("z.mts"), resolve("a.mjs"), resolve("z.mts")];
	const config = readConfig({
		...env,
		PID_ACP_PROVIDERS: JSON.stringify(paths),
		PID_ACP_PROVIDER: "selected",
	});
	assert.deepEqual(config.providerPaths, paths);
	assert.equal(config.providerId, "selected");
	assert.deepEqual(config.extensionPaths, []);
});

test("invalid provider lists identify bad entries without echoing input", () => {
	const secret = "private-fixture-token";
	for (const value of [
		"",
		"[]",
		"null",
		"{}",
		JSON.stringify(resolve("provider.mjs")),
		`["${secret}",`,
	])
		assert.throws(() => readConfig({ ...env, PID_ACP_PROVIDERS: value }), {
			message:
				"Set PID_ACP_PROVIDERS to an absolute provider module path or a nonempty JSON array of absolute paths.",
		});
	for (const member of [null, [], 1, "", `https://user:${secret}@example.test`])
		assert.throws(
			() =>
				readConfig({
					...env,
					PID_ACP_PROVIDERS: JSON.stringify([env.PID_ACP_PROVIDERS, member]),
				}),
			{
				message:
					"PID_ACP_PROVIDERS entry 2: Use an absolute provider module path.",
			},
		);
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
	assert.deepEqual(
		(
			await configureModels(
				readConfig({ ...env, PID_ACP_PROVIDER: provider.id }),
			)
		).model,
		model,
	);
});

async function makeProviderDirectory(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "pid-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function writeProvider(path: string, id: string, ...modelIds: string[]) {
	const fauxModule = import.meta.resolve(
		"@earendil-works/pi-ai/providers/faux",
	);
	await writeFile(
		path,
		`
		import { fauxProvider } from ${JSON.stringify(fauxModule)};
		export default fauxProvider(${JSON.stringify({
			provider: id,
			models: modelIds.map((id) => ({ id })),
		})}).provider;
	`,
	);
	return path;
}

test("multiple providers require an explicit default and disambiguate shared model IDs", async (t) => {
	const dir = await makeProviderDirectory(t);
	const paths = [
		await writeProvider(
			join(dir, "first.mjs"),
			"first",
			"shared",
			"first-only",
		),
		await writeProvider(
			join(dir, "second.mjs"),
			"second",
			"shared",
			"first/shared",
		),
	];
	const launch = {
		PID_ACP_PROVIDERS: JSON.stringify(paths),
		PID_ACP_MODEL: "shared",
	};
	await assert.rejects(
		configureModels(readConfig(launch)),
		/Set PID_ACP_PROVIDER.*more than one/,
	);
	for (const provider of ["first", "second"]) {
		const { models, model } = await configureModels(
			readConfig({ ...launch, PID_ACP_PROVIDER: provider }),
		);
		assert.deepEqual(
			models.getProviders().map(({ id }) => id),
			["first", "second"],
		);
		assert.deepEqual(model, { provider, modelId: "shared" });
		assert.equal(
			models.getModel(model.provider, model.modelId)?.provider,
			provider,
		);
	}
	const selected = { ...launch, PID_ACP_PROVIDER: "second" };
	assert.deepEqual(
		(
			await configureModels(
				readConfig({ ...selected, PID_ACP_MODEL: "first/shared" }),
			)
		).model,
		{ provider: "second", modelId: "first/shared" },
	);
	for (const modelId of ["missing", "first-only", "second/shared"])
		await assert.rejects(
			configureModels(readConfig({ ...selected, PID_ACP_MODEL: modelId })),
			/PID_ACP_MODEL is not registered by the selected provider/,
		);
	for (const providerId of ["missing", ""])
		await assert.rejects(
			configureModels(readConfig({ ...launch, PID_ACP_PROVIDER: providerId })),
			/PID_ACP_PROVIDER is not registered/,
		);
});

test("duplicate provider IDs use Pi AI replacement and count as one registered provider", async (t) => {
	const dir = await makeProviderDirectory(t);
	const paths = [
		await writeProvider(join(dir, "original.mjs"), "same", "old"),
		await writeProvider(join(dir, "replacement.mjs"), "same", "new"),
	];
	const launch = {
		PID_ACP_PROVIDERS: JSON.stringify(paths),
		PID_ACP_MODEL: "new",
	};
	const { models, model } = await configureModels(readConfig(launch));
	assert.deepEqual(model, { provider: "same", modelId: "new" });
	assert.equal(models.getProviders().length, 1);
	assert.equal(models.getModel("same", "old"), undefined);
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

test("module load and registration failures identify the entry without echoing module errors", async (t) => {
	const dir = await makeProviderDirectory(t);
	const secret = "private-fixture-token";
	const diagnostics =
		/PID_ACP_PROVIDERS entry 2: Could not load or register provider/;
	for (const [name, source] of [
		["missing", undefined],
		["bad\0path", undefined],
		["no-default", "export const notDefault = {};"],
		["import-failure", `throw new Error("${secret}");`],
		[
			"registration-failure",
			`export default { get id() { throw new Error("${secret}"); } };`,
		],
	] as const) {
		const path = join(dir, `${name}.mjs`);
		if (source !== undefined) await writeFile(path, source);
		await assert.rejects(
			configureModels(
				readConfig({
					...env,
					PID_ACP_PROVIDERS: JSON.stringify([env.PID_ACP_PROVIDERS, path]),
				}),
			),
			(error: Error) => {
				assert.match(error.message, diagnostics);
				assert.doesNotMatch(inspect(error), new RegExp(secret));
				return true;
			},
		);
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
