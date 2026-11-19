+++
status = "draft"
created = 2026-11-13
last_update = 2026-11-19
+++

# Multiple conversations in one shared Harness

## At a glance

**One always-on server, one execution engine, many independent conversations.**
Instead of launching a Pi process for every chat, pid-acp routes each ACP session
ID to a conversation inside the same Durable Harness.

```text
                 ONE pid-acp process
            ┌───────────────────────────────┐
ACP client ─┼─ session A → conversation A    │
            │                cwd: project-a │
ACP client ─┼─ session B → conversation B    │
            │                cwd: project-b │
            │                               │
            │ ONE shared Durable Harness    │
            │ ONE shared persistent store   │
            └───────────────────────────────┘
```

- **Independent chats:** each keeps its own history, instructions, skills and cwd.
- **Concurrent work:** A and B can run together; cancelling A leaves B running.
- **Always-on execution:** disconnecting a client does not cancel its work.
- **Restart recovery:** the server resumes unfinished work without waiting for clients.
- **Not a sandbox:** different working directories do not prevent access to shared files.

### High-level code sketch

Illustrative pseudocode, not a copy-paste implementation. `sessions`, `metadata`
and the routing helpers represent application code; Durable owns execution.

```ts
// Startup: open ONE store and ONE Harness for the whole server.
const harness = await openSharedHarness({
  env: ({ conversationId }) => environmentFor(metadata[conversationId]),
});
await restoreConversationMetadata(harness);
harness.resume(); // Recover unfinished work, even with no client attached.

// New ACP session: create a conversation, NOT another Harness/process.
const chat = await harness.createConversation({
  ownership: { kind: "ownerless" },
  agent: { cwd, instructions },
  init: saveConversationMetadata({ skills }),
}, context);
sessions.set(acpSessionId, chat);

// Requests route by session ID; A and B can execute concurrently.
await sessions.get(id).submit({ type: "input", content: prompt }, context);
await sessions.get(id).abort(context); // Explicit cancel affects this chat only.

// Client disconnect: release delivery/attachment state, NOT the conversation.
// Server shutdown: close the shared Harness/store; recover work next startup.
```

**What changes:** replace per-session Harnesses/stores with one shared runtime,
conversation-aware resource lookup, and a session router. One active prompt per
conversation remains the rule; steering and queued follow-ups are separate work. Automatic client
reattachment after restart is deferred.

The sections below define the detailed contracts and acceptance tests.

## Purpose

Run pid-acp as an **always-on agent server**: independent conversations execute
concurrently in one process, with one Durable Harness owning execution and storage.
Execution lifetime is independent of ACP client attachment. This extends
[003](003-instructions-and-skills.md) and supersedes the single-attached-session,
per-session Harness/storage topology and client-gated recovery in
[004](004-persistent-sessions.md), retaining history replay, native recovery and
private-storage requirements except where revised below.

## Context

This design targets ACP SDK 2.0.1 and Chord, pi-ai and pi-durable 1.5.2.
In the per-session design, `Session` owns a Harness, registry and environments;
each persistent UUID directory contains a separate Durable store and reserved
root conversation. The session-scoped `pid-acp.session` document
contains one skills catalog, and the skills prompt callback closes over it.
Neither that document nor that callback can represent independent catalogs in a
shared Harness unchanged.

Upstream [example 29][example] creates independent ownerless conversations with
`harness.createConversation({ ownership: { kind: "ownerless" }, agent, init }, context)`.
Its `init(tx, id)` writes a conversation-scoped application document; the shared
`env({ conversationId, read }, context)` reads it to select a directory-backed
`NodeExecutionEnv`. These APIs exist in the published 1.5.2 package. The example
submits sequentially; it demonstrates routing, not concurrent admission,
persistent migration or a security boundary.

Durable 1.5.2 opens scheduling paused and reconciles live tasks across the store.
Runtime must explicitly call `harness.resume()` after opening and
resource routing are ready, without waiting for a client. Conversation `submit`,
`abort` and `waitForIdle` also enable the shared scheduler. Harness-wide automatic
recovery is desired behavior, not an implementation blocker. Selective recovery
and dormancy until client attachment were agent-added assumptions, not user
requirements; the user has explicitly approved always-on recovery.

## Goals

- Route multiple attached ACP sessions to independent native conversations.
- Run prompts concurrently across conversations, with independent context,
  workspace, resources, agent configuration, events and cancellation.
- Preserve session identity and history across restart and automatically recover
  previously loaded/running conversations without client reload or a fresh prompt.
- Keep lifecycle ownership explicit and failure scope observable.

## Non-goals

- Separate Harnesses, processes or execution engines per ACP session.
- Steering, queued follow-ups or overlapping prompts within one conversation.
- Multi-user tenancy, filesystem isolation, permissions or container provisioning.
- Conversation listing, deletion, forking, new background-agent workflows, session
  switching, automatic last-session selection or a new ACP detach/close extension.
- Automatic client reattachment after server restart is a future goal; transport,
  reconnect and resumable-delivery protocol design are deferred.
- Implementing MCP or codemode here, importing Pi settings, or runtime changes in
  this documentation milestone.

## Specification

### Ownership and logical flow

The diagram has eight components; per-session adapters and environments are
instances within one process, not additional Harnesses.

```text
ACP client -> AcpServer session router -> per-session Adapter
                      |                         |
                      v                         v
               Runtime owner ------------> shared Durable Harness
                      |                         |        |
                      v                         v        v
            conversation environments <--- tool calls   shared Storage
                                                |
                                                v
                                         attachment EventBridge -> ACP client
```

Runtime must own exactly one Harness, one shared registry, one storage backend
and its process lock for the process lifetime. AcpServer must own a map from
opaque ACP session ID to a session-bound Adapter and an opening reservation per
ID. Adapter must own request/attachment lifetime, protocol mapping and the ordering
of admission/native abort calls, not execution state. Durable must own atomic busy
policy, submission outcomes, transcripts, tasks and tool execution. EventBridge
must own attachment presentation across fresh, recovered and out-of-band work. The presentation path is optional: unattached
execution needs no EventBridge or ACP sink. Runtime must also own environments
and recovered execution with no attached Adapter. Releasing client attachment must
never abort durable work, dispose resources it still uses, or close the shared
Harness or storage.

Every new session must use native `createConversation`, with ownerless ownership
and no shared reserved-root conversation. The creating transaction must commit
its agent, a versioned conversation-scoped application document and the durable
ACP-ID mapping together. The document must contain the external UUID and saved
skills catalog; native agent configuration alone carries the canonical cwd,
instructions, provider/model and thinking choice. Mapping records must be unique
in both directions. An external UUID must remain distinct from Durable's internal
conversation ID; clients must treat the UUID as opaque. Transient sessions must
also have distinct IDs, valid only in their creating process.

Runtime must resolve execution environments by conversation ID, committed native
agent cwd and application metadata, following example 29. Missing or invalid
metadata must fail that conversation's operation with sanitized guidance, never fall back to the
process cwd. Cache environments by conversation ID, not cwd: two conversations
may deliberately share a directory but must have distinct cleanup ownership.
Concurrent environment construction for one ID must not leak duplicate resources.

### Conversation configuration and resources

Each new conversation must independently snapshot instructions and skill metadata
using 003's canonical-cwd discovery and launch overrides. The shared registry's
skills section must select the requesting conversation's saved catalog rather
than capture a session's string or mutate a global catalog during requests.
Load must retain saved snapshots; ordinary skill-body reads remain live reads.

Each conversation must retain its own agent choices. New conversations may use
the same immutable launch defaults; loading one must neither reconfigure existing
conversations nor require changing their models. An unavailable saved model or
incompatible agent configuration must fail that conversation's recovery or load
with repair guidance, without preventing unrelated recovery.
Credentials and provider implementations remain process-owned and must not be
stored in conversation metadata. New client-facing agent-selection controls are
outside this milestone; the configuration surface is an open question.

Proposed specification 005 (MCP) and 006 (codemode) are integration seams, not
prerequisites or linked files assumed present on main. Future MCP connections,
server configuration and tool visibility must be selected by conversation ID.
Codemode globals, execution state and nested tool calls must retain the originating
conversation's environment and cancellation scope. Their resources must have
explicit conversation owners and cleanup hooks; process-shared pools require
leases so cancelling one conversation cannot dispose another's resources. Those
proposals define protocol/execution details. Until implemented, existing MCP and
additional-directory rejection and capability advertisements remain unchanged.

### ACP admission, replay and routing

- `session/new` must validate cwd/resources before publication, reserve a fresh
  ID, commit the conversation, then publish its Adapter and return the ID. Failure
  must release its reservation without disturbing attached sessions. Failed
  publication must not expose a half-initialized mapping as loadable.
- Persistent mode must advertise `loadSession: true`. `session/load` must resolve
  only an existing mapping and conversation, validate its schema, canonical cwd
  and available configuration, then replay native active history before responding,
  as in 004. Load must not create a root, resubmit input, rediscover resources or
  trigger execution; native recovery may already be executing concurrently.
  Transient mode must reject load with configuration guidance.
- Loading an attached ID or an ID already opening must fail with a busy error;
  it must not replay again, replace the Adapter or cancel its prompt. Different
  IDs may open/replay while other conversations execute. A prompt for an opening
  ID must fail as not ready. Unrelated opening failures must release only their
  own reservation.
- Invalid, unknown, stale, missing or incompatible IDs must fail with sanitized
  repair/create guidance, without allocating replacement conversations. A UUID
  from another storage root has no meaning here. Prompt/cancel must route only
  to an attached ID, never implicitly load a saved conversation. Invalid cancel
  notifications must have no execution side effects; diagnostics must stay off stdout.
- Durable decides admission; notification backlog must never make execution busy.
  Recovered work can be busy without an Adapter; a new prompt must fail busy while that
  conversation's native work remains active, rather than queue behind it.
  Same-conversation overlap must fail promptly without insertion into Durable's
  inbox; submissions must use `whenBusy: "reject"`. Different conversations'
  provider/tool executions must be able to overlap; neither a
  global prompt mutex nor a global recovery wait is permitted.

Presentation must use Durable 1.5.2 `Conversation.watch()` and typed live state,
not removed `watchEvents`/AgentEvent APIs. Every history snapshot, watcher,
submission wait and update must be scoped to the mapped conversation. Load must
establish a history/live boundary while work continues: replay the snapshot before
the load response, then deliver subsequent attached updates without duplicating
replayed entries. Recovery must not wait for replay or a presentation subscriber.
Unattached progress must be represented by native live state and persisted
history under Durable's persistence policy; it must not be
sent to another session or accumulated in an unbounded per-client event queue.
Watches may coalesce changes; use native entries to fill history windows/gaps,
not a promise to replay every transient delta. Deferred partial progress can lose
about one second on crash under default 1.5.2 settings. Automatic transport
reattachment and cross-restart exactly-once update delivery are not promised.

Prompt responses must map their own submission.wait terminal result without
waiting for conversation idle, transcript tails or notification delivery. The
attachment watch must continue across responses and later requests. Native input
entries reset presentation, not ACP request boundaries. All visible native user
entries, including local echoes and queued/out-of-band input, must be presented.
Updates must carry the mapped ACP session ID; baselines and tool-call correlation
remain attachment-local. A blocked task in one conversation must not reject a
sibling. Native inspection supplies direct conversation blocked-definition guidance,
not a parallel ownership/dependency scheduler.

### Always-on recovery and cancellation

On process restart, Runtime must open the shared store, restore conversation-based
resource routing and resume the shared Harness automatically. Previously
loaded/running conversations and their unfinished submissions, tasks and due
sleeps must recover under native policy without `session/load`, client attachment
or a new prompt. Idle conversations need no synthetic input. Recovery must neither
drop saved work nor require a selective scheduler, per-session Harness or
client-owned execution context. Attachment controls request routing and
presentation, not execution eligibility.

Recovery means native continuation or settlement, not guaranteed successful
completion or blind retry. In 1.5.2 a crashed in-flight model request consumes the
retry policy; with retries disabled it ends `interrupted`, rather than being
resent. Recovery after a tool round can still generate an answer. Restart-limited
tasks end natively instead of parking; missing/incompatible task definitions can
remain blocked. Surface these outcomes for the affected conversation, including
on later load. Process restart must not be translated into user cancellation or
submission of replacement input.

Cancellation must target only the mapped conversation's native abort scope and
its owned execution resources. Ownerless conversations must have no cross-session
task ownership edges. A cancel racing admission must be remembered and applied
once admission permits it; it must not abort a later prompt. An attached client
must be able to cancel its conversation's recovered work even without a new
prompt in this process. An idle cancel must be a no-op. Cancel A must not close
the Harness, abort B, clean B's environment, or prevent B from completing its
current prompt and accepting another.
Native done must remain end_turn even when cancellation races with its response;
unanswered/aborted maps to cancelled. At cancel receipt, capture the already-invoked
notification send promise. The handler and an aborted original prompt may join
that fixed boundary; future watch updates must never extend it. No idle/tail/drain
inference or adapter cancellation flag may override native outcomes.
A cancel notification creates no response of its own. This authorized model
intentionally limits stable ACP v1's stricter cancelled-turn ordering and blanket
cancelled-stop-reason compatibility: future updates can follow a cancelled response.
Normal prompt completion must remain independent of slow sinks.

### Storage, failures and shutdown

Persistent mode must use one shared Durable store in `db/` under the configured
sessions root, plus native durable mapping metadata. A directory of independent JSONL stores is not one storage
namespace: every store has its own root, IDs, tasks, documents and commit history.
Concatenating their logs or pointing several Harnesses at them is unsupported.
New-session publication must be transactional within the live shared store;
staging with close/rename/reopen would interrupt all conversations.

Before opening shared storage, Runtime must acquire one OS advisory lock covering
the entire shared namespace. Hold its stable inode until Harness
and storage close; never unlink it to bypass ownership. A second process using
that namespace must fail before opening/recovery, even for another session ID.
Crash release must use OS lock semantics rather than PID guessing. Retain 004's
private ownership/modes, symlink/hardlink rejection, fsync and whole-store backup
rules, including JSONL sidecars. Keep keys and transcripts out of diagnostics and
stdout ACP-only. Memory mode must use one MemoryStorage with equivalent routing.

Invalid resources, a provider/tool failure, incompatible saved metadata or a
blocked conversation must affect only that conversation unless storage integrity
is compromised. Validate saved configuration at environment allocation and load
through one validation function; retain no permanent invalid-conversation set.
Failed environment allocation must be retryable after workspace repair. In Durable
1.5.2 generation catches environment errors and may still call the model; native
tools fail before execution when environment construction fails. A startup sweep
cannot prevent generation through that callback and is unnecessary for tool safety.
Unrelated conversations must remain recoverable. Shared storage
failure (`onReport` kind `storage_failed` in 1.5.2) or an
unrecoverable scheduler invariant must stop global admission, fail affected
pending requests honestly and initiate process shutdown without memory fallback.
A broken ACP transport stops delivery/admission for that transport, not durable
execution by itself. Client disconnection must not act as user cancellation.
The current stdio host may still use EOF as a process-shutdown trigger; that is
server lifecycle policy, not a conversation abort or a reconnect protocol.

`AcpServer.close()` must preserve the existing busy-close contract: while any
new/load validation, transaction, replay or rollback is opening, reject with
`AdapterBusyError` before changing state. Accepted close must synchronously stop
all new/load/prompt admission and be idempotent. EOF, signals and fatal failure
must stop transport admission first and retain the bounded busy retry/deadline
policy in 004. Accepted process shutdown must await active prompt admission,
stop delivery watchers and close the shared Harness/storage exactly once using
native close semantics, joining stopped invocations before disposing execution
resources and releasing the process lock. Include recovered work without an
Adapter; do not call conversation abort merely to shut down. Native close leaves
unfinished work recoverable for the next startup; it does not record user cancel
intent. Pending ACP requests must not report success or user cancellation solely
because the server stops. Cleanup must attempt every owner even if one fails and
handle resources allocated during close. A missed deadline must produce failure
exit, leaving native unfinished work for later recovery, not a claimed graceful
close.

ExecutionEnv supplies execution operations and cwd, **not a security sandbox**.
Native tools can access absolute paths, inherited permissions, shared files and
host resources. Conversations using the same files may race; pid-acp must not
promise conflict resolution or rollback of external effects. Unsafe native tool
replay, surviving shell children after hard crashes and lack of exactly-once
effects remain as described in 004. Shared provider quotas, CPU, memory, disk and
transport backpressure may affect all conversations. Limits must reject excess
admission explicitly rather than silently queue same-conversation prompts; they
must permit at least two concurrent conversations. Exact limits remain open.

## Compatibility

Single-conversation clients must retain the new/prompt/cancel and persistent
load/replay behavior; they need no awareness of other attached sessions. This
proposal changes storage topology, lock granularity and execution lifetime, not
the ACP wire protocol. Load remains an explicit presentation attachment; it no
longer gates recovery. This supersedes 004's first-prompt recovery/cancellation
ownership and shutdown-aborts-work expectations.

This format has never been deployed. No earlier storage-format detection, import,
or compatibility shim is provided. Back up complete stores with the server stopped.
Backend-specific validation, JSONL recovery and locking belong in the filesystem
backend, behind the small open-storage/close lifecycle boundary. A future SQLite
backend need not expose JSONL files; no SQLite implementation or framework is needed.
Trusted single-user operation requires no lease, heartbeat or live-file monitoring.

## Verification

Implementation acceptance must include deterministic unit, integration and
production ACP tests, with provider injection and real native bash/file tools:

1. Assert one Harness open/close and one backend across two new sessions; distinct
   UUIDs map to distinct native conversations with no reserved-root reuse.
2. Use barriers to prove A and B run providers/tools concurrently. Reject a second
   A prompt without queuing it while B completes. Test concurrent new/load,
   duplicate load, opening-ID requests, stale IDs and failed-publication rollback.
3. Give A/B distinct cwd, instructions, skill catalogs and agent choices; verify
   model requests, relative file effects and history contain only their own data.
   Repeat with equal cwd and reused tool-call IDs to expose cwd-keyed ownership
   and global event-correlation bugs. Check all update session IDs.
4. Attach to recovering A and cancel without a fresh prompt; also cancel during
   submission and real long-running bash. B must finish and accept another prompt.
   Reject fresh input while A is recovering without inserting it; a late cancel
   must not affect its next prompt. Idle/unknown cancel must have no abort effects.
5. Restart with unfinished A/B/C and no ACP load or prompt. Assert automatic shared
   recovery, including B/C remaining unattached. Load A while recovery runs: replay
   its snapshot before the load response and deliver subsequent attached updates
   without replay duplicates or cross-session routing. A's attachment, prompt and
   cancel must not gate B/C execution. Cover queued input, due sleeps, unsafe tool
   intent, interrupted generation with retries disabled, recovery after a tool
   round, restart-limit terminal outcomes and blocked definitions. Do not assert
   blind request resend, exactly-once effects or delivery of every transient delta.
6. Reopen the shared store and verify stable mappings, snapshots and native task
   outcomes. Test workspace repair without restart, corrupt mapping/document,
   missing cwd, unavailable model, sidecars,
   permissions, second-process lock contention and crash lock release.
7. Isolate provider, environment and blocked-task failures to A; inject shared
   storage failure and assert global admission stops with no false saved success.
   Exercise busy close during parallel opens/replay/rollback, accepted close
   during A/B execution, EOF/signals, cleanup failure and deadline exhaustion;
   verify resource ownership, single close and lock-release ordering. Include
   unattached recovered work; clean shutdown/restart must continue eligible work,
   while explicit user cancellation remains cancelled. Simulate delivery loss
   without aborting work; distinguish stdio EOF shutdown from client cancellation.
8. Hold a sink behind controlled barriers. Submission completion and later native
   admission must proceed; release delivers terminal tools/text once in order.
   Queue native input and passive output: the first response must not wait for
   later work, and the attachment must deliver all visible inputs and outputs.
   Cancel joins only the send captured at receipt, never later watch output.
   Late/repeated cancel must preserve native done and leave the next input intact.
   Detach must release hung presentation/request waiters without native abort.
9. Run build, strict typecheck, lint, formatting and default deterministic suites.
   Keep live tests opt-in and evidence in the implementation MR, not this spec.

## Open questions

- **Configuration and limits:** should trusted launch configuration offer named
  agent profiles per new conversation, and what attached-session, active-prompt,
  environment and output-buffer limits should ship? No new wire selection API or
  numerical defaults are assumed here.

## References

- [003: instructions and skills](003-instructions-and-skills.md).
- [004: persistent sessions](004-persistent-sessions.md).
- [Example 29][example], reviewed at upstream commit
  `482c1381a00d8d00bc81697e4a980c593db6803e`.
- [Conversation creation and rollback tests][conversations];
  [paused viewers and progress-call scheduling tests][lifecycle];
  [per-call environment tests][tools]. These upstream tests explain intent;
  published [Durable 1.5.2][package] declarations, CHANGELOG and
  `dist/harness/{harness,scheduler,view,live}.js` establish the target API,
  shared scheduling, watch and native recovery behavior.

[package]: https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.5.2.tgz
[example]: https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/test/examples/29-sandbox-per-conversation.ts
[conversations]: https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/test/harness-conversations.test.ts
[lifecycle]: https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/test/harness-lifecycle.test.ts
[tools]: https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/test/harness-tools.test.ts
