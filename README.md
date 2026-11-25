## Overview

pid-acp connects ACP clients to Pi Durable.

![ACP clients connect to pid-acp, which embeds Pi Durable, pi-mcp, pi-codemode, and pi-ai](docs/overview.svg)

## Quickstart

```sh
npm ci && npm run build
PID_ACP_PROVIDERS=/provider.mts PID_ACP_MODEL=example-model node dist/main.js
```

## Features

- Skills
- `AGENTS.md`
- MCP
- Codemode
- User extensions
- ACP v1 (`initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`)
- Steering (`_session/steering`)
- Tools (`bash`, `read`, `write`, `edit`)
- Transport (stdio, Unix socket)

## ACP → Durable SDK

| ACP method | Durable SDK call |
| --- | --- |
| `initialize` | None |
| `session/new` | `harness.createConversation()`, then `conversation.watch()` |
| `session/load` | `harness.snapshot()` and `harness.conversation()`, then `conversation.context()` and `conversation.watch()` |
| `session/prompt` | `conversation.submit({ type: "input", content, whenBusy: "followUp" }, context)`, then `submission.wait()` |
| `session/cancel` (notification) | `conversation.abort()` |
| `_session/steering` | `conversation.submit({ type: "input", content, whenBusy: "steer", whenIdle: "reject" }, context)` |

## Configuration

| Environment variable | Description |
| --- | --- |
| `PID_ACP_PROVIDERS` | Absolute path or nonempty JSON array of absolute paths. |
| `PID_ACP_PROVIDER` | Default provider ID; optional with one provider. |
| `PID_ACP_MODEL` | Default chat model ID registered by the selected provider. |
| `PID_ACP_THINKING` | Model thinking level; defaults to `off`. |
| `PID_ACP_INSTRUCTIONS` | Global instructions file; empty disables it. |
| `PID_ACP_SKILLS_DIR` | Global skills directory; empty disables it. |
| `PID_ACP_MCP_CONFIG` | MCP config file; empty disables MCP. |
| `PID_ACP_MCP_AUTH_FILE` | Absolute path to Pi’s live `mcp-auth.json`; defaults to `~/.pi/agent/mcp-auth.json`. Only used for opted-in OAuth servers. |
| `PID_ACP_EXTENSIONS` | JSON array of absolute Durable extension paths. |
| `PID_ACP_SESSIONS_DIR` | Absolute directory for persistent sessions. |
| `PID_ACP_SOCKET_PATH` | Absolute Unix socket path; unset uses stdio. |

### Providers

Each trusted module default-exports one Pi AI provider. To load more than one, set `PID_ACP_PROVIDERS='["/provider.mts","/other.mts"]'`. For duplicate provider IDs, the last module wins.

Example `provider.mts`:

```ts
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export default createProvider({
  id: "example",
  name: "Example",
  baseUrl: "https://api.example.com/v1",
  api: openAICompletionsApi(),
  models: [{ id: "example-model" /* add Pi AI model metadata */ }],
  // Add authentication if required.
});
```

### MCP OAuth

For a Streamable HTTP server, a service operator can sign in with Pi CLI 1.5.2 and let pid-acp reuse and refresh that grant. See [MCP OAuth setup](docs/mcp-oauth.md) for a headless example, compatibility limits, and the required stop-before-reauthorizing procedure.

### User extension sketch

Set `PID_ACP_EXTENSIONS='["/absolute/path/to/todo.mts"]'`.

```ts
import { defineExtension } from "@earendil-works/pi-durable";
import { todoTool, todoSection } from "./todo-state.mts";

export default defineExtension({
  name: "user.todo",
  tools: [todoTool],
  sections: [todoSection],
});
```

## AI disclosure

Built with 6.1 Sol, 6.2 Sol, and 6.2 Astra.

Initial project prompt:

> make mr for a spec doc with a svg diagram for replacing pi rpc with pi durable in pi-acp. what's the minimal tracer bullet to poc?
