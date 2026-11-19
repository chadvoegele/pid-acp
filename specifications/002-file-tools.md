+++
status = "draft"
created = 2026-10-22
last_update = 2026-10-22T17:22:08Z
+++

# Native file tools

## Purpose

Let a trusted local ACP client ask the agent to read, edit, and write files directly, with accurate tool identity and results. Use Durable's existing tools so filesystem execution and model continuation remain owned by Durable.

## Context

This extends [milestone one](001-durable-skateboard.md)'s bash-only tool surface. The original baseline pinned Durable and Pi AI 1.4.0 and ACP SDK 2.0.1.
The current application uses Durable/Pi AI 1.5.2; conversation watches replace the
live-event API described below. README documents current presentation limits. Session admission, text-only ACP prompts, thinking delivery, in-memory storage, and the single-session lifecycle remain in effect.

## Goals

- Offer native `read`, `edit`, and `write` alongside the existing real `bash`.
- Use the session cwd consistently and preserve native validation, diagnostics, and image handling.
- Show correct ACP tool identity, input, output, and exactly one terminal update per call, for the live event stream.
- Verify filesystem effects through ACP stdio with deterministic providers and real tools.

## Non-goals

- Custom file implementations, schema replacements, a new workflow layer, or Pi settings/subprocess integration.
- Sandboxing, cwd confinement, permission prompts, remote execution, or client-side ACP filesystem RPCs.
- ACP prompt images, attachments, session persistence, restart recovery, or multi-session support.
- Transactions across files, rollback on cancellation, external-process locking, or mandatory diff/location rendering.

## Specification

### Ownership and registration

The runtime must register `createReadTool()`, `createEditTool()`, and `createWriteTool()` from `@earendil-works/pi-durable/tools` alongside the unchanged `createBashTool()`. All must use the conversation's existing `NodeExecutionEnv`. The model must receive all four native schemas; no tool name or parameter translation is required. Existing provider injection remains the testing seam.

Durable must own tool execution, transcript entries, tasks, and submission settlement. Adapter must retain admission and cancellation ownership. EventBridge may keep only per-prompt presentation metadata, output, and deduplication state; it must not execute tools or become a second transcript store.

### Paths and trust

Relative paths must resolve against the cwd accepted by `session/new`, even when the server process has a different cwd. Absolute paths must remain absolute. Native path normalization and aliases, including home expansion, must pass through unchanged. Read's native filename-variant lookup must remain available; the adapter must not apply separate path rewriting.

The cwd is a starting directory, not a security boundary. Parent traversal, absolute paths outside cwd, and symlink targets follow native filesystem permissions. File tools and bash run with the local user's privileges and require trusted local clients and prompts. Documentation must describe this shared boundary without claiming approval or confinement. Tests that exercise paths outside cwd must use only temporary fixtures.

### Native tool behavior

The following behavior belongs to the pinned native tools. The application must preserve it rather than reimplement it.

| Tool | Model input | Required behavior |
| --- | --- | --- |
| `read` | `path`, optional numeric `offset` and `limit` | Read text or a supported image; text offset is one-based, limit selects lines. |
| `edit` | `path`, `edits: [{ oldText, newText }, ...]` | Apply nonempty, unique, non-overlapping replacements against the original file. |
| `write` | `path`, `content` | Create or overwrite the entire file and create missing parent directories. |
| `bash` | Existing native schema | Preserve command execution, streaming output, failure, timeout, and cleanup behavior. |

The application must not impose stricter pagination schemas or duplicate Durable's argument repair. In particular, native edit can repair a single edit object, JSON-string `edits`, and legacy top-level `oldText`/`newText`. ACP `rawInput` must identify the arguments actually observed, as specified below.

Text reads default to the file start and return at most 2,000 lines or 50 KiB, whichever bounds the native result first. `offset`/`limit` select a page before truncation. Continuation and truncation diagnostics must reach both the model and ACP client. An oversized first line returns its UTF-8-safe prefix and a diagnostic suggesting bash for continuation. Offset beyond EOF is an error. Empty content may produce no text block. The adapter must preserve native handling of numeric edge cases and concurrent file changes; it must not invent pagination state or add a second truncation pass.

Edit must preserve native LF normalization, UTF-8 BOM handling, and detected line-ending restoration. Matching tries exact text first, then native fuzzy normalization (NFKC, trailing whitespace, quotes, dashes, and special spaces). Uniqueness is checked in normalized space, even when an exact occurrence exists. Fuzzy edits may normalize touched lines while preserving unchanged line blocks. These semantics must not be described as strictly byte-exact replacement.

All replacements target the same original content, rather than the result of earlier replacements in the call. Empty edits, empty `oldText`, missing or ambiguous matches, overlapping/nested matches, and an overall unchanged result must fail before writing. If any replacement fails validation, none of that call's replacements may be written. A missing edit target or directory target must fail. Users can recover from a matching failure by reading again and providing unique context.

Native edit/write mutations of the same canonical file are serialized within the process, including symlink aliases. This does not lock against bash or another process. Validation atomicity is not filesystem atomicity: NodeExecutionEnv uses a direct filesystem write, not a transactional rename. Cancellation or I/O failure during writing may leave a partial or completed mutation; parent directories may already exist. The application must not promise rollback, crash safety, or protection from concurrent external changes.

### Images

Use native `createReadTool()` without an image processor for this increment. It recognizes images from content and passes through in-limit JPEG, PNG, GIF, and WebP. Formats requiring conversion (including BMP), unreadable dimensions, and oversized images must return native error diagnostics. No new image-processing dependency or silent conversion is required.

Native read obtains vision capability from the configured model's `input` and image bounds from its `inputLimits.images.resize`, falling back to native defaults (2,000 by 2,000 pixels and 4.5 MiB of base64). A valid image result remains an image in the Durable transcript. For a model without image input, native read adds a diagnostic and Pi AI's provider transformation supplies an omitted-image placeholder; the application must not claim that the model saw the pixels or fail the whole prompt solely because it lacks vision.

EventBridge must preserve supported native text and image result blocks as ACP tool content, wrapping each in ACP's `content` variant, and preserve the native result content in `rawOutput`. This uses existing ACP content types and requires no image-specific UI. Native diagnostics appended to tool-result text must remain visible. Reading a local image via a model tool is distinct from accepting image prompts: `promptCapabilities.image` must remain false and nontext ACP prompts must still be rejected.

### ACP identity, progress, and settlement

| Durable tool name | ACP title | ACP kind |
| --- | --- | --- |
| `bash` | `bash` | `execute` |
| `read` | `read` | `read` |
| `edit` | `edit` | `edit` |
| `write` | `write` | `edit` |
| Any other name encountered | Native name | `other` |

Titles need no path suffix. Diffs and locations are optional and must not require rereading files or constructing synthetic before/after contents; native edit already supplies diff/patch details. Text/image results, diagnostics, identity, and status are the required presentation.

Use Durable's `toolCallId` verbatim as ACP `toolCallId`; do not parse or replace it with task IDs or generated IDs. A call must produce one initial `tool_call` with `in_progress`, followed by progress as available and exactly one terminal `tool_call_update` (`completed` or `failed`). All terminal updates must be delivered before the prompt response. A failed tool may be followed by a successful model answer and `end_turn`.

Live `tool_execution_start` supplies `toolName` and `args`. Use these directly for ACP identity and `rawInput`. Live args reflect native preparation/coercion. Later updates and settlement must retain this metadata, never reset input to `{}` merely because an event lacks args.

Tool presentation uses only live `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events. Do not index historical arguments, reconstruct tools from snapshots or committed messages, or correct metadata from later transcript entries. Preserve the initial baseline and snapshot handling for assistant text/thought deduplication only.

Live progress must preserve bash output trim/append/set behavior. A live end's native result `isError` determines terminal status, and its actual content supplies text/images and `rawOutput`. An end without a result settles as failed, retaining streamed output. Durable can emit an end without a start for an unoffered or unstarted call; present that live end under its native name/ID, omitting unavailable input. Duplicate starts/ends and late progress must not duplicate terminal updates or revive a completed call.

Durable 1.4.0 derives event batches from commits, emitting starts from running slots with prepared arguments and ends when slots become done or disappear. The subscriber is installed before prompt submission. A consumer more than 100 batches behind receives a replacement snapshot. Tool resynchronization after that bounded subscription overflow is deferred: snapshots must not invent tool success, replay tools, or reexecute them. Tool lifecycle completeness is guaranteed only for delivered live events; after event loss a client may retain incomplete tool presentation. Assistant text/thought snapshot catch-up remains supported. This deliberately supersedes the earlier historical tool/snapshot recovery requirements.

### Errors, cancellation, and recovery

Schema failures, missing files, inaccessible paths, invalid edit targets, and matching/image errors must appear as failed tool results with native diagnostics, not protocol errors that prevent the model from recovering. Provider/runtime/transport failures retain the existing ACP prompt error behavior. Diagnostics on stderr must not expose file bodies, transcripts, image base64, or credentials; stdout remains ACP-only.

`session/cancel` must continue to abort via Durable, settle the pending ACP prompt as `cancelled`, and permit a subsequent prompt in the same session. The bridge must deliver available tool settlements without reexecuting a call. File tools may finish before cancellation arrives; their settled status must reflect the native result. Cancellation makes no claim to undo filesystem effects. Subsequent reads must observe the actual file state. Bash child cleanup and bounded shutdown remain required.

## Verification

Use real native tools and temporary directories. Deterministic provider fixtures must request calls, inspect tool results, and issue subsequent calls/answers through the existing provider seam; replacing file execution with mocks is insufficient.

1. **Registration and cwd:** verify all four native schemas are offered, including in the credential-free HTTP production-entrypoint test that currently expects only bash. Through ACP stdio, read a relative fixture from a session cwd different from process cwd, read an absolute fixture, and exercise parent traversal/symlink paths inside a temporary fixture tree.
2. **File round trip:** script write of a nested new file, overwrite it, read a page, perform multiple disjoint edits, and reread. Assert actual file contents and provider-visible results as well as ACP title/kind/rawInput, stable IDs, terminal uniqueness, and ordering before `end_turn`. Retain a real bash `pwd`/failure/streaming regression.
3. **Read bounds:** exercise line and byte truncation, continuation offsets, a multibyte oversized first line, empty text, and offset past EOF. Assert native diagnostic text reaches both provider and client without double truncation.
4. **Edit semantics:** cover missing/ambiguous/empty/overlapping/no-op edits and a mixed valid/invalid batch with an unchanged file on validation failure; verify original-file rather than sequential matching, fuzzy matching with unchanged lines preserved, BOM/CRLF preservation, and native argument repair. Check create/overwrite and directory/missing-path errors using actual files, avoiding permission tests that depend on running as an unprivileged user.
5. **Images:** use small valid fixtures with a vision-capable scripted model and a text-only model. Assert native image content and diagnostic delivery over ACP, provider-bound vision image versus text-only placeholder using a native provider transformation or scripted HTTP endpoint, and failed tool results for unsupported/oversized images. Assert ACP image prompts remain rejected and image capability remains false.
6. **Live presentation:** unit-test typed native starts/updates/ends for all tool names, including write's `edit` kind. Assert prepared live input, native text/image results and errors, stable IDs, one initial call and one terminal status, output trim/append/set behavior, missing-result failure, and native end-only unstarted failures. Repeated starts/ends, late progress, snapshots and committed messages must not duplicate or correct tool presentation. Assert snapshots and historical/result-only entries do not reconstruct tools. Preserve assistant text/thought snapshot and deduplication coverage.
7. **Cancellation:** use deterministic provider synchronization over ACP stdio to cancel an active run around real file work, then read actual state and successfully use a file tool in a subsequent prompt. Do not depend on racing a tiny write or promise no mutation. Retain existing blocked model/bash cancellation and shutdown tests; controlled cancellation must still settle within five seconds.
8. **Repository checks:** build with `npm ci && npm run build`, then run `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm test`. Add focused cases in `tests/test_runtime.unit.ts` and `tests/test_events.unit.ts`; group ACP file scenarios as `test_file_tools.integration.ts` / `test_file_tools.e2e.ts` and include any new e2e file explicitly in the default suite. Tests import built `dist` and declarations. Live tests remain opt-in. Record results and timings in the combined MR, not repository documents.
