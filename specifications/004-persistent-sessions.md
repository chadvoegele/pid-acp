+++
status = "final"
created = 2026-10-22
last_update = 2026-11-19
+++

# Persistent sessions with load replay and native Durable recovery

## Purpose

Let a trusted local ACP client reconnect after restarting pid-acp, retaining model
context and letting Durable continue unfinished work. Reconnect uses ACP
`session/load`, with historical user/assistant/thought/tool updates before its
response. Clients that already display the saved history can suppress updates
until the load response. Use published Durable JSONL storage and lifecycle APIs
rather than a second transcript or recovery engine.

This supersedes the memory-only restriction in [001](001-durable-skateboard.md)
and the earlier resume-only interface and blanket interrupted-session rejection
requirements. [003](003-instructions-and-skills.md)'s resource
snapshot semantics remain intact. [007](007-multiple-conversations.md) supersedes
the original per-session storage topology, ownership and recovery timing with
one process-owned Harness and `db/` backend; native agent state alone owns cwd.

## Goals

- Reattach a saved UUID with ACP load replay and restored model context.
- Keep restoration, unfinished work and unsafe tool replay policy owned by Durable.
- Preserve compatibility with clients that suppress all updates during loading.

## Non-goals

Session discovery, switching, migration, full raw-transcript archival, task repair,
custom tool recovery and cross-crash shell supervision are outside this interface.

## Specification

### Durable boundary

Durable 1.5.2 owns storage recovery, saved agent configuration, conversation
context, submissions, task scheduling, tool replay policy, cancellation and
settlement. Follow its [Persist and Resume documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#persist-and-resume),
[recovery example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/13-recovery.ts),
and [reload/restart example](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/31-reload-and-restart.ts),
checking behavior against the pinned published package. Those recovery examples
use SQLite; pid-acp selects the published Node JSONL backend instead. Presentation
follows [late join](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/21-late-join.ts),
[JSON](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/19-json.ts),
and [context](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/09-context.ts).

The application owns launch configuration, private directory selection, exclusive
ownership and ACP admission/presentation. Do not add a parallel session database,
manifest, transcript schema, task status machine, raw JSONL recovery algorithm,
Pi settings loader, or tool execution layer. History-to-ACP translation stays in
`events.ts` and uses public Durable context APIs.

### Configuration and storage

Unset `PID_ACP_SESSIONS_DIR` keeps transient `MemoryStorage` behavior. A nonempty
absolute path enables persistence; empty or relative values fail startup.
Provider code and credentials come only from the explicit launch environment,
never from stored executable configuration.

```text
<sessions-dir>/
  owner.lock
  db/
    main.jsonl
    <SDK-managed document/task sidecars>
```

Allocate a random external UUID for each ACP persistent session and map it to a
native ownerless conversation. UUIDs are lookup keys, not filesystem paths.

Use `openNodeJsonlStorage(directory, context, { fsync: true })` and
`Harness.open(storage, options, context)`. JSONL recovers torn final lines and
rejects committed corruption; it rebuilds its own indexes. pid-acp must not parse
or repair storage files. Promise process-restart persistence, not unconditional
power-loss durability: the backend does not always flush the main commit marker
before acknowledgement.

Saved agent configuration is authoritative for canonical cwd, model/provider,
thinking level and instructions. A versioned conversation document stores UUID and
skills; a session document maps external UUIDs to native conversation IDs.
Initialize them with the agent in one creating transaction and read them with
`harness.snapshot`. Delegate native document migration to Durable; do not persist
or gate reopen on the SDK version. Read agent state with `conversation.agent` and
live presentation through `Conversation.watch()`; do not reconstruct native recovery
from document reads or preflight storage task/submission scans.

### Creation, ownership and validation

Open one process-owned Harness at startup and resume native work without a client.
Resolve cwd and resources before transactional conversation creation. Guard opening
and attachment publication per session ID without blocking unrelated conversations.
Backend-specific file validation, locking and JSONL recovery stay in the backend;
Runtime depends only on its storage lifecycle contract.

`runtime.ts` holds immutable launch configuration, owns execution resources and
creates non-owning Sessions. `conversation-resources.ts` validates saved state at
environment allocation and load, without retaining permanently invalid IDs.
Session never imports Runtime. `acp-server.ts` defines AcpServer; `stdio-server.ts` owns stdin/stdout
transport, signals and process shutdown. These are responsibilities in one process,
not separate deployed servers. AcpServer owns initialize/new/load, routing and the
optional attached Adapter.
It claims opening admission synchronously through validation, native opening,
history replay and complete rollback. The opening operation owns the candidate
Session and its Adapter until native open and every replay send succeed. Only
then does AcpServer publish ACP readiness.
Adapter requires a readonly ready Session and owns prompt/cancel/close; it has no
Runtime reference, optional Session, opening state, initialize or create/load API.
Runtime owns the process failure signal; Session exposes it and AcpServer guards
process-level admission.

The sessions root must be trusted, private, owned by the server user and free of
symlinks. Create directories as 0700 and files as 0600, including SDK sidecars,
using a restrictive process umask. This also restricts newly created native tool
files. Reject public, symlinked or hardlinked storage files. These controls do not
sandbox native shell or file operations.

Acquire an OS advisory lock before storage open and hold it until storage close.
Use pinned `fs-native-extensions` on Linux. Keep the stable lock inode on release;
never delete it to bypass ownership. A second process fails before opening or
recovering storage; a crash releases ownership without stale PID cleanup. Trusted
single-user deployment needs no heartbeat, lease or live-file tamper monitoring.

On load, require an existing mapped conversation rather than silently creating it.
Validate application document version, skills schema, saved configuration and
canonical workspace. Validate backend file properties at backend opening. Reject
unknown application document versions, corrupt/missing state, absent workspaces, relocation, or
unavailable provider/model or invalid thinking levels with sanitized repair guidance.
Saved choices need not match launch defaults. No memory fallback is allowed.

### ACP reconnect and native progress

In persistent mode advertise `loadSession: true` and handle `session/load`.
In transient mode advertise `loadSession: false` and reject load with configuration
guidance. Remove the unused `session/resume` extension. The client retains the UUID.
Multiple independent attachments are supported. No list/delete/fork or automatic
last-session selection API is provided.

Require an absolute existing cwd resolving to the saved canonical path. MCP and
additional workspace roots remain unsupported; reject nonempty lists. ACP load
requests include an empty MCP servers list.

Read the mapped conversation's saved metadata, agent and skills. Do not rediscover
resources or call resume/wait/submit/abort during load. Unattached native work may
already be running independently of presentation. Before returning, translate a
public `conversation.context()` snapshot into historical ACP updates. Use `entries` only to select native `UserEntry`,
`AssistantEntry`, `ToolResultEntry` and `ResetEntry` contributions; let Durable's
`contributions` interpret heads, edits, replacements, omissions and excluded stop
reasons. Preserve stored order, thoughts, tool IDs/inputs/results and images in
tool results. Use SDK-derived missing tool results from `messages` for visible
calls lacking a result, scoped to their assistant message even when providers
reuse tool-call IDs across turns. Hide system, provider-error and internal entry content;
never traverse raw edit/head chains or parse JSONL. Replay is active history, not
all immutable stored entries; partial uncommitted generation is not replayed.

The late-join and JSON examples show initial snapshot followed by later changes;
the context example supplies native history interpretation. They are not ACP
replay examples. AcpServer's only extra behavior is ACP rendering of that snapshot.
Replay is awaited before the load response. An attachment watch serializes recovered
and fresh delivery; native entry scans fill folded snapshot/watch gaps without
repeating history as live output.

Releasing an attached but dormant session must close it without calling abort
or disposing process-owned execution resources.

Durable's `whenBusy: "followUp"` admission queues fresh input during native
work for the next turn. An Adapter orders admission and explicit
native abort calls only to protect concurrent cancellation. A prompt response maps
its submission.wait terminal result, independently of delivery and later work.
One attachment watch continues after responses; clients wait for particular output
when needed. Delivery backlog alone never makes execution busy. The original input
is never resubmitted.

With the fixed built-in registry, `harness.inspect()` identifies this conversation's
tasks blocked by missing/incompatible definitions before submission. It does not
reconstruct ownership/dependency graphs to infer execution state. Durable 1.5.2 ends restart-limited
tasks instead of parking them, and interrupted in-flight model requests exhaust
the disabled retry policy instead of being resent. Reject
the prompt promptly with guidance to restore compatible code or use Durable
repair tooling; leave the session attached and do not insert fresh input. Do not
invent task repair, retry or orphaning policy. Native tasks and their dependencies
remain owned by Durable. Arbitrary extensions, user task migrations, background
work and custom task recovery are outside this interface.

Explicit cancellation can abort recovered work without a fresh prompt through the
conversation-scoped public API. Cancellation and admission calls are ordered so an
in-flight admission cannot escape cancellation or cause a delayed abort of the next
input. Native done remains end_turn; unanswered/aborted maps to cancelled.
At cancel receipt, capture only the already-invoked send promise. The handler and
an aborted original prompt may join that fixed boundary, never future watch updates.
This deliberately limits strict stable ACP v1 cancelled-turn ordering compatibility;
late updates remain possible and session/cancel has no response of its own.
EventBridge owns attachment presentation state, not prompt execution.

### Native tools and interrupted effects

Keep published `bash`, `read`, `edit` and `write` tools unchanged. All four omit
`replay`, whose native default is `unsafe`. After a crash during committed execute
intent, Durable supplies an interrupted tool error, retaining committed output,
instead of invoking that tool again. Completed tool results remain committed and
feed the next generation. Pending work before execute intent follows Durable's
native scheduling. Progress settles interrupted work natively. With retries
disabled, a crashed in-flight model request ends `interrupted` rather than being
resent; a recovered tool round can still request its answer. Never mark an unsafe
tool replay-safe to obtain automatic retries.

This is not exactly-once external execution. Effects may precede their result
commit, and a model may choose a new tool call after seeing an interrupted error.
Hard crashes do not supervise surviving shell children; storage cannot reattach
or kill them. Tests must safely own and clean their process groups. Detached or
daemonized processes and crash-proof process supervision are not supported.

### Failure and shutdown

New-session and successful prompt responses follow committed SDK operations.
Storage failure stops admission, rejects pending work, closes the process and
releases ownership after cleanup; never report a saved success or fall back to
memory. Diagnostics must omit keys, transcript content and provider/parser bodies.

`AcpServer.close()` during validation/opening/replay/rollback rejects with the
specific `AdapterBusyError` before changing state or starting cleanup. Opening
continues normally and can publish; callers must retry. Accepted close stops
admission synchronously and idempotently cleans attached resources.

EOF/signals/storage failure stop transport admission before attempting close.
`stdio-server.ts` retries only busy rejection every 25 ms, at most 161 attempts under
the existing four-second shutdown deadline; other cleanup failures surface without
retry. Once accepted, close stops attachment delivery, joins native Harness
invocations, cleans every environment even after failures, and releases the backend
lock last. It never records user cancellation. Unfinished opening or cleanup at the
deadline forces failure exit, not a reported graceful close. Native unfinished work
can recover on startup without load. Neither restart nor ACP load resubmits the
original transport request.

Stored files may include prompts, thinking, source code, tool/file output and
incidental secrets. Keep them out of version control and protect backups. Back
up a closed store or a consistent snapshot of the entire directory with sidecars.
Never deliberately store credentials, environment variables or provider code.

## Verification

- Full build, strict source/test typechecking, lint, formatting and deterministic
  unit/integration/e2e suites. Unit filenames mirror source modules.
- Production fresh-process load replays user/assistant/thought/tool updates before
  its response and preserves identity and model context exactly once. Opening the
  process resumes eligible native work without requiring attachment. A client can
  suppress historical updates during load and still receive updates from a fresh prompt.
- Real native file/bash tools and HTTP-provider context survive restart; replay
  respects Durable heads, replacement/omission edits and provider/internal filters.
- Crash during generation, native bash execute and after committed effect: startup
  resumes or settles natively before load; attachment observes the saved outcome
  and context without duplicating the interrupted effect.
- Slow sinks must not gate normal submission completion or later admission. Late
  queued/passive output must reach the same attachment after responses. Cancellation
  must join only its captured send, preserve native done in late races, and release
  hung presentation waiters on detach without native abort.
- Cancellation during native recovery, overlapping prompts, blocked tasks,
  cancellation/provider failures, EOF/signals, hard shutdown and disk failures.
- Invalid IDs, missing/incompatible documents, configuration/cwd mismatch,
  permissions/symlinks, torn lines/corruption/sidecars, lock races and crash release.
- External acpx 0.20.0 stateful create/restart/load: assert actual wire
  `session/load`, no `session/resume` or `session/new` fallback, historical replay
  before the response, context once, interrupted native outcome, cancellation and
  ownership.
- Opt-in live provider acceptance when credentials are available. Record commands,
  versions, timings, failures and evidence in the merge request.
