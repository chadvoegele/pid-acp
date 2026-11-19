+++
status = "draft"
created = 2026-11-13
last_update = 2026-11-15
+++

# Native Durable codemode

## Purpose

Enable Durable's codemode tool in pid-acp so models can batch native-tool calls,
chain dependent calls and filter results in JavaScript. Keep pid-acp's role to
configuration, sandbox ownership and disposal, and ordinary ACP tool presentation.

## Context

This builds on [004](004-persistent-sessions.md) and
[007](007-multiple-conversations.md). Current `main` (`155086e`) uses Durable 1.5.2
with one Runtime-owned Harness, registry and backend, and conversation-keyed
execution environments. Runtime resumes saved work without a client; Session is
a non-owning attachment.

Durable and pi-codemode provide the execution and persistence behavior. This
proposal installs that implementation, independently of the MCP specification.

## Goals

- Make codemode available alongside `bash`, `read`, `edit` and `write`.
- Let Durable and pi-codemode own script execution and native integration.
- Own and dispose the sandbox with Runtime.
- Present the parent codemode call like any other ACP tool call.

## Non-goals

- Nested-call ACP rows, parent/child UI metadata or nested-state reconciliation.
- MCP integration, namespace configuration or extension points for its proposal.
- pid-acp implementations of discovery, alias validation, result mapping,
  batching, scheduling, store/load, journaling, replay or task repair.
- Custom worker admission, concurrency accounting, deadlines or output policies.
- Auxiliary `models.*` calls, arbitrary host globals or user extensions.
- New ACP methods, configuration surfaces, storage formats or artifact retention.

## Specification

### Configuration and installation

Add an exact `@earendil-works/pi-codemode` 1.5.2 dependency for the direct import,
matching the existing Durable 1.5.2 dependency.

Runtime must create one worker-backed `CodemodeSandbox` from
`@earendil-works/pi-codemode`. Configure `memoryLimitBytes` to 64 MiB; otherwise
use upstream sandbox defaults, without custom callbacks or execution wrappers.
This is a VM allocation limit, not a total process-memory limit.

Install `createCodemodeExtension({ sandbox, namespaces: [], models: false })`
from `@earendil-works/pi-durable/codemode` through the existing registry creation
path before `Harness.open`. Keep the four native tool registrations unchanged.
Follow Durable's [Code Mode installation example](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md#code-mode),
which constructs a sandbox and passes it to `createCodemodeExtension`. The caller
retains ownership and closes the sandbox; pi-codemode manages its workers.
Use the extension's own tool definition, prompt sections and discovery helpers;
do not duplicate them in pid-acp or adapt the coding-agent's codemode tool.

Durable controls tool availability through its existing agent configuration.
Existing agents with no explicit tool filter gain codemode through registry
installation. Preserve explicit saved tool selections; do not rewrite saved
agents during attachment or load. No MCP server or configuration is required.

### Ownership and disposal

Runtime owns the sandbox for the shared Harness lifetime. Session and Adapter
must neither create nor close it. Attachment failure, rollback or close must
leave the sandbox and background native work intact.

Extend existing Runtime cleanup to dispose the sandbox after Harness close has
joined native invocations, before releasing the remaining owned resources.
Dispose it on failed Runtime startup too, including failure before Harness
creation. Cleanup must attempt remaining resources if another cleanup step
fails, without introducing a parallel lifecycle manager.

Keep existing transport shutdown deadlines and failure handling. Use the
sandbox's public lifecycle API; add no worker tracking or process supervision.

### Upstream execution boundary

Durable and pi-codemode own input parsing, discovery, tool permissions, nested
execution, result mapping, output limits, temporary artifacts, store/load,
persistence, replay and cancellation. pid-acp must use those behaviors unchanged,
without reading internal codemode documents or implementing their algorithms.

Install the extension before startup recovery and retain existing
conversation-keyed execution environments. Recovery remains automatic;
`session/load` attaches presentation rather than enabling execution. Existing
prompt admission, steering, explicit conversation abort and response-delivery
boundaries remain unchanged. No codemode-specific busy flag, abort path or
recovery gate is needed.

The extension's `models: false` setting excludes auxiliary model calls. Keep
upstream native-tool replay policies: installing codemode does not make shell or
file effects exactly-once. This milestone adds no operator deadline guarantee or
persistent retention of temporary output files.

### Ordinary ACP tool presentation

Translate only the parent `codemode` call through the existing EventBridge tool
path and ordered `Conversation.watch()` stream. Reuse existing translation
where it already handles an ordinary registered tool.

- Emit a `tool_call` with the native call ID, title `codemode`, kind `other`,
  status `in_progress` and the native arguments as `rawInput`.
- Translate available parent progress into ordinary `tool_call_update` messages.
- Translate the parent result into a terminal update using the existing
  success/error mapping and text/image content handling.
- Replay committed parent calls and results through the existing public-history
  translation on load.

Pass through the upstream parent output without synthesizing child summaries or
exposing internal documents. Any summary already included in that output remains
ordinary parent content. Do not consume `pi.live.nestedTools`, emit separate child
rows or add parent/child metadata. Clients need only ordinary tool-call rendering.
No special completion or cancellation delivery barrier is added.

### Security and compatibility

Retain existing private storage, provider configuration and diagnostics rules.
Script source and results are sensitive tool data; stdout remains ACP-only.
Do not expose additional sandbox host APIs or bypass Durable to execute tools.
Native tools retain server-user authority; this is not a multi-tenant sandbox.

No ACP capability, request shape, conversation metadata, UUID mapping or storage
layout changes are required. Existing clients and direct native calls continue
to work.

## Verification

Run the existing build, typecheck, lint, format and deterministic test suites.
Add focused tests for pid-acp's integration responsibilities:

- Registry installation before Harness opening, native tools retained, empty
  namespaces and `models: false`.
- Runtime sandbox ownership and disposal on normal shutdown and failed startup;
  attachment close and rollback do not dispose it.
- An injected provider executes a codemode script using real native tools in a
  temporary workspace and receives the upstream result.
- ACP receives ordinary parent start/progress/terminal updates, including error
  results and committed history replay, with no separate nested-call rows.
- Existing conversation cancellation reaches a running script and permits a
  subsequent prompt; no custom codemode cancellation path is introduced.
- A focused persistent-session restart check confirms the extension is installed
  for native startup recovery without a client and parent history remains loadable.

Use credential-free providers and harmless commands. No MCP infrastructure or
live model is required. Test the integration boundary rather than reproducing
upstream sandbox, discovery, store, replay or resource-limit test suites.

## References

- [Persistent sessions](004-persistent-sessions.md).
- [Shared Harness and multiple conversations](007-multiple-conversations.md).
- [Durable 1.5.2 codemode](https://github.com/earendil-works/pi/tree/v1.5.2/packages/durable/src/codemode).
- [pi-codemode 1.5.2](https://github.com/earendil-works/pi/tree/v1.5.2/packages/codemode).
