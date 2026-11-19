import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));

test("all local source dependencies are acyclic, including type-only imports and re-exports", async () => {
	const files = (await readdir(sourceDirectory, { recursive: true }))
		.filter((file) => file.endsWith(".ts"))
		.map((file) => join(sourceDirectory, file));
	const graph = new Map<string, string[]>();
	for (const file of files) {
		const source = await readFile(file, "utf8");
		const dependencies = ts.preProcessFile(source, true, true).importedFiles;
		graph.set(
			file,
			dependencies
				.filter(({ fileName }) => fileName.startsWith("."))
				.map(({ fileName }) => {
					const resolved = ts.resolveModuleName(
						fileName,
						file,
						{ moduleResolution: ts.ModuleResolutionKind.NodeNext },
						ts.sys,
					).resolvedModule;
					assert.ok(resolved, `Unresolved dependency ${fileName} in ${file}`);
					assert.ok(files.includes(resolved.resolvedFileName));
					return resolved.resolvedFileName;
				}),
		);
	}

	const visited = new Set<string>();
	function visit(file: string, ancestors: string[]) {
		assert.ok(
			!ancestors.includes(file),
			`Circular source dependency: ${[...ancestors, file]
				.map((path) => relative(sourceDirectory, path))
				.join(" → ")}`,
		);
		if (visited.has(file)) return;
		for (const dependency of graph.get(file) ?? [])
			visit(dependency, [...ancestors, file]);
		visited.add(file);
	}
	for (const file of graph.keys()) visit(file, []);
});

test("Adapter has a required readonly Session and no pre-session lifecycle or Runtime dependency", async () => {
	const file = join(sourceDirectory, "adapter.ts");
	const source = ts.createSourceFile(
		file,
		await readFile(file, "utf8"),
		ts.ScriptTarget.Latest,
	);
	const adapter = source.statements.find(
		(node): node is ts.ClassDeclaration =>
			ts.isClassDeclaration(node) && node.name?.text === "Adapter",
	);
	assert.ok(adapter);
	const adapterConstructor = adapter.members.find(ts.isConstructorDeclaration);
	const session = adapterConstructor?.parameters[0];
	assert.equal(adapterConstructor?.parameters.length, 1);
	assert.ok(session && ts.isIdentifier(session.name));
	assert.equal(session.name.text, "session");
	assert.equal(session.type?.getText(source), "Session");
	assert.equal(session.questionToken, undefined);
	assert.equal(session.initializer, undefined);
	assert.ok(
		session.modifiers?.some(
			(modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
		),
	);
	const text = source.getText();
	for (const forbidden of [
		"Runtime",
		"opening",
		"createApp",
		"initialize",
		"createSession",
		"loadSession",
	])
		assert.ok(!text.includes(forbidden), `Adapter must not own ${forbidden}`);
	const acpServer = await readFile(
		join(sourceDirectory, "acp-server.ts"),
		"utf8",
	);
	const open = acpServer.indexOf("? await this.runtime.createSession");
	const attach = acpServer.indexOf("adapter = new Adapter(candidate)");
	const replay = acpServer.indexOf("await adapter.attach(");
	const publish = acpServer.indexOf(
		'this.attachments.set(sessionId, { kind: "ready", adapter })',
	);
	assert.ok(open > 0 && attach > open && replay > attach && publish > replay);
});

test("session store selects its filesystem backend through static value imports", async () => {
	const file = join(sourceDirectory, "session-store.ts");
	const source = ts.createSourceFile(
		file,
		await readFile(file, "utf8"),
		ts.ScriptTarget.Latest,
	);
	const bindings = source.statements.flatMap((statement) => {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== "./filesystem-session-store.js"
		)
			return [];
		const clause = statement.importClause;
		assert.ok(clause && !clause.isTypeOnly);
		assert.ok(clause.namedBindings && ts.isNamedImports(clause.namedBindings));
		return clause.namedBindings.elements.map((binding) => {
			assert.equal(binding.isTypeOnly, false);
			return (binding.propertyName ?? binding.name).text;
		});
	});
	assert.deepEqual(bindings.sort(), [
		"FilesystemSessionStore",
		"prepareSessionsDirectory",
	]);
	function checkStaticImports(node: ts.Node) {
		assert.ok(
			!ts.isCallExpression(node) ||
				node.expression.kind !== ts.SyntaxKind.ImportKeyword,
			"Session store must not dynamically import its backend",
		);
		ts.forEachChild(node, checkStaticImports);
	}
	checkStaticImports(source);
});
