import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Storage } from "@earendil-works/pi-durable";
import { Runtime } from "../../dist/runtime.js";
import type { Session } from "../../dist/session.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { startClient } from "./client.ts";

export async function persistenceFixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pid-persistence-"));
	const cwd = join(root, "workspace");
	const sessions = join(root, "sessions");
	await mkdir(cwd);
	const clients: Awaited<ReturnType<typeof startClient>>[] = [];
	const ownedSessions: Session[] = [];
	const runtimes: Runtime[] = [];
	t.after(async () => {
		await Promise.all(clients.map((client) => client.close()));
		await Promise.all(
			ownedSessions
				.filter((session) => !session.closed)
				.map((session) => session.close()),
		);
		await Promise.all(runtimes.map((runtime) => runtime.close()));
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		cwd,
		sessions,
		async track(opening: Promise<Session>) {
			const session = await opening;
			ownedSessions.push(session);
			return session;
		},
		async runtime(
			options: {
				modelId?: string;
				provider?: string;
				thinking?: ModelThinkingLevel;
				resources?: { instructionsPath?: string; skillsDir?: string };
			} = {},
		) {
			const models = createModels();
			models.setProvider(fauxProvider().provider);
			const runtime = await Runtime.open(
				models,
				{
					provider: options.provider ?? "faux",
					modelId: options.modelId ?? "faux-1",
				},
				options.thinking ?? "off",
				options.resources ?? {},
				sessions,
			);
			runtimes.push(runtime);
			return runtime;
		},
		async client(
			env: NodeJS.ProcessEnv = {},
			onUpdate?: (sessionId: string, update: SessionUpdate) => void,
		) {
			const client = await startClient({
				live: true,
				onUpdate,
				env: {
					PID_ACP_PROVIDERS: resolve("tests/helpers/persistence-provider.ts"),
					PID_ACP_MODEL: "faux-1",
					PID_ACP_THINKING: "off",
					PID_ACP_SESSIONS_DIR: sessions,
					...env,
				},
			});
			clients.push(client);
			return client;
		},
		async edit(change: (storage: Storage) => Promise<void>) {
			const storage = await openNodeJsonlStorage(
				join(sessions, "db"),
				context,
				{
					fsync: true,
				},
			);
			try {
				await change(storage);
			} finally {
				await storage.close(context);
			}
		},
	};
}
