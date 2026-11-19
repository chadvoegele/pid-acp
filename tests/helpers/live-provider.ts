import assert from "node:assert/strict";

export async function requireLiveProvider() {
	for (const name of [
		"PID_ACP_PROVIDER_CONFIG",
		"PID_ACP_BASE_URL",
		"PID_ACP_MODEL",
		"PID_ACP_API_KEY",
	]) {
		if (!process.env[name])
			throw new Error(`Set ${name} explicitly for live testing.`);
	}
	const baseUrl = new URL(process.env.PID_ACP_BASE_URL ?? "");
	assert.ok(
		!baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash,
	);
	const response = await fetch(`${baseUrl.href.replace(/\/$/, "")}/models`, {
		headers: { Authorization: `Bearer ${process.env.PID_ACP_API_KEY}` },
		signal: AbortSignal.timeout(10000),
	});
	assert.equal(
		response.status,
		200,
		"Provider /models must respond successfully.",
	);
	assert.ok(
		((await response.json()) as { data: { id: string }[] }).data.some(
			(model) => model.id === process.env.PID_ACP_MODEL,
		),
		"Configured exact model ID must be loaded.",
	);
	return {
		date: new Date().toISOString(),
		node: process.version,
		endpoint: baseUrl.href,
		model: process.env.PID_ACP_MODEL,
		thinkingLevel: process.env.PID_ACP_THINKING ?? "off",
	};
}
