export function fixtureEnvironment(env: NodeJS.ProcessEnv = process.env) {
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => !name.startsWith("PID_ACP_")),
	);
}
