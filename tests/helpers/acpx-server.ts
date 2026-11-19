import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [entrypoint, trace] = process.argv.slice(2);
assert.ok(entrypoint && trace);
const tracePath = trace;
const child = spawn(process.execPath, [entrypoint], {
	stdio: ["pipe", "pipe", "inherit"],
});
function record(direction: string, message: unknown) {
	appendFileSync(
		tracePath,
		`${JSON.stringify({ pid: child.pid, launcherPid: process.pid, ownerPid: process.ppid, direction, message })}\n`,
		{ mode: 0o600 },
	);
}
record("server", { method: "started" });
function observe(direction: string) {
	let partial = "";
	return (data: Buffer) => {
		partial += data.toString();
		const lines = partial.split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) if (line) record(direction, JSON.parse(line));
	};
}
process.stdin.on("data", observe("client"));
process.stdin.pipe(child.stdin);
child.stdout.on("data", observe("server"));
child.stdout.pipe(process.stdout);
child.stdin.on("error", () => {});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
	process.on(signal, () => child.kill(signal));
child.on("close", (code) => process.exit(code ?? 1));
