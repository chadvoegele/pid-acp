#!/usr/bin/env node
import {
	configureModels,
	readConfig,
	SocketConfigurationError,
} from "./config.js";
import { logger } from "./logger.js";
import { loadMcpConfig, McpConfigurationError } from "./mcp-config.js";
import { Runtime } from "./runtime.js";
import { serveSocket } from "./socket-server.js";
import { serve } from "./stdio-server.js";
import { UserExtensionError } from "./user-extensions.js";

try {
	const config = readConfig();
	const { models, model } = await configureModels(config);
	const runtime = await Runtime.open(
		models,
		model,
		config.thinkingLevel,
		config.resources,
		config.sessionsDir,
		await loadMcpConfig(config.mcpConfig),
		config.extensionPaths,
	);
	if (config.socketPath === undefined) await serve(runtime);
	else await serveSocket(runtime, config.socketPath);
} catch (error) {
	logger.error(
		error instanceof McpConfigurationError ||
			error instanceof UserExtensionError ||
			error instanceof SocketConfigurationError
			? `pid-acp: ${error.message}`
			: "pid-acp: Startup failed. Set PID_ACP_PROVIDER_CONFIG (absolute trusted module path) and PID_ACP_MODEL; verify the provider's endpoint and credentials; PID_ACP_THINKING must be off, minimal, low, medium, high, xhigh or max if set. PID_ACP_INSTRUCTIONS and PID_ACP_SKILLS_DIR must be absolute or empty if set. PID_ACP_SESSIONS_DIR must be a nonempty absolute directory path if set. PID_ACP_MCP_CONFIG must select a supported trusted MCP file, or be empty to disable MCP. Verify installed dependencies.",
	);
	process.exitCode = 1;
}
