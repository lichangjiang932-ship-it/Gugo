# Gugo kernel boundary

This document defines the target boundary of Gugo's minimal runtime kernel. It
is a contract for new code and refactoring, not a claim that every current host
file has already crossed the boundary.

## Stable kernel surface

The kernel owns only three things:

1. **Agent loop contract** — bind one complete loop implementation for a run,
   execute it, and release its lease.
2. **Agent event vocabulary** — describe observable runtime facts without UI,
   transport, database, or plugin-specific payloads.
3. **Tool pipeline contract** — validate a proposed call, authorize it, execute
   it through the side-effect boundary, and record a terminal outcome.

The stable host-facing files are:

| Surface | Authoritative file | Boundary |
|---|---|---|
| Loop adapter | `server/core/toolLoopAdapter.js` | Versioned all-or-nothing `run(context)` implementation lease |
| Turn persistence adapter | `server/core/turnPersistenceAdapter.js` | Complete TurnEngine session/event/model-recovery boundary with atomic start, checkpoint, and boundary commits |
| Generic Turn persistence bootstrap | `server/core/turnPersistenceBootstrap.js` | Host-only, fail-closed selection contract for one complete trusted local adapter before DB preflight and ordinary plugin restore; it cannot mint distribution-owned provenance |
| Bundled SQLite bootstrap | `server/adapters/builtinSqliteTurnPersistenceBootstrap.js` | Distribution-owned composition boundary that lazily loads the SQLite fallback only when selected and exclusively mints bundled-SQLite provenance |
| Bundled SQLite persistence | `server/adapters/sqliteTurnPersistenceAdapter.js` | Distribution-owned concrete adapter, selected only by an explicit composition root |
| Session administration port | `server/core/sessionAdminPort.js` | Versioned, MaybePromise management surface selected with the active persistence backend |
| Session administration DTOs | `server/core/sessionAdminDtos.js` | Pure public DTO projection and cross-backend result invariants for SessionAdmin v2 |
| Managed attachment runtime port | `server/core/managedAttachmentRuntimePort.js` | Versioned, revocable host capability for Turn attachment validation, binding, and model materialization without exposing host paths |
| Turn start runtime | `server/services/turnStartRuntime.js` | Narrow-port staging and atomic commit of Session, Messages, attachment binding, and `turn.started`; ends before execution-lease acquisition |
| Event vocabulary | `shared/turnEvents.js` | Shared event names and envelope validation |
| Built-in loop entry | `server/services/loop/runtime.js` | Bundled implementation behind the loop adapter, not a host contract |
| Tool execution gate | `server/services/loop/runtime-executeToolCalls.js` | Final authorization, recovery, and side-effect execution ordering |

Code outside this table must not become a prerequisite for implementing a
replacement loop. A replacement receives normalized dependencies through its
context; it does not import routes, React, SQLite stores, the plugin registry,
or process bootstrap code.

## Host-owned capabilities

The host, not the kernel, owns model providers, storage backends, HTTP/SSE/WS,
authentication, plugin discovery and installation, jobs and cron, subagents,
browser/MCP connections, UI contributions, self-evolution, and OS sandbox
selection. These capabilities may consume kernel events or provide adapters,
but the kernel must not select or initialize them.

Artifact authorization, generation validation, persistence, publication, and
final receipts are also host-owned. Runtime plugins cannot replace the public
`create_*` artifact tools or mint completed artifact receipts. A future plugin
seam may contribute a candidate generator or buffer, but every candidate must
still cross the host Artifact Harness before it becomes visible.

`server/core/builtinLifecycleAssembly.js` is the bundled host composition root.
It may wire built-ins, but it is not part of the kernel. New process resources
must enter through lifecycle capabilities rather than direct imports in the
loop.

`server/services/turnEngineHost.js` is the process-local Turn host. It acquires
one already-active persistence-adapter lease and one managed-attachment runtime
lease, constructs the shared
`TurnEngine`, coalesces concurrent shutdown callers onto one drain barrier, and
releases both leases after shutdown even when draining fails. Dependency flow is
strictly `turnEngineHost -> TurnEngine`; the class module must never import or
re-export its host.

The browser production server, Vite development host, and CLI Headless host
all enter through the distribution-owned SQLite bootstrap before database preflight,
register the selected complete adapter as the host persistence capability,
resolve one runtime snapshot, and pass that exact adapter into lifecycle or
Headless assembly. The distribution default remains bundled SQLite; an
explicit local module never silently falls back to it. Importing the
`TurnEngine` class or `turnEngineHost` does not activate a persistence adapter.
The distribution bootstrap delegates trusted-module validation to the generic
core selector, but it owns the lazy bundled fallback and its unforgeable
provenance. Production composition roots must not call the generic selector or
import the SQLite adapter directly.
Without host activation, acquiring the shared engine fails closed with
`TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED`. A generic Headless resume without an
explicit Session id consumes the selected adapter's optional
`eventLog.resolveTurnSession({ userId, turnId })` capability; an adapter that
does not expose it fails with `TURN_SESSION_LOOKUP_UNSUPPORTED`. The Headless
host must not query a concrete event table or authorize lookup by backend
provenance.

## Current transition debt

The following files are compatibility hosts and are explicitly outside the
target kernel:

| File | Current role | Required direction | Canonical debt |
|---|---|---|---|
| `server/services/jobRuntime.js` | Job planning, policy, scheduling, and loop hosting; crash recovery is delegated to `jobRuntimeRecovery.js`, while owner-aware event delivery and terminal-evicted owner caching are delegated to `jobRuntimeEventHub.js` | Keep extracting independent services and capability providers without moving recovery persistence or event routing back into the facade | `DEBT-ARCH-002` |
| `server/plugins/runtimePluginRegistry.js` | Inventory, capability wiring, config, and release control; installation settlement/rollback, record construction, bounded audit storage, contribution transactions, Prompt, Tool, Loop-hook, and read-only Agent Event hosting are delegated to focused modules | Finish splitting inventory/loading from activation/execution, add a durable replay/cursor feed behind the separate Agent Event consumer seam, and keep installation and contribution transactions behind their focused controllers | `DEBT-ARCH-002` |
| Managed attachment HTTP/governance, artifacts, verified-file projections, and data governance | Turn validation and model materialization now cross `ManagedAttachmentRuntimePort v1`; routes, upload/deletion governance, and the atomic SQLite turn-start binding still assume host-owned identities or file layouts | Move the remaining aggregate operations behind backend-neutral governance/storage capabilities without weakening ownership checks or splitting the existing atomic turn-start commit | `DEBT-ARCH-002` |

The repository's 600-line preference applies to implementation files under
`server/`, `shared/`, `desktop/`, and `bin/`. `DEBT-SIZE-001` is the executable
inventory; a file above that threshold is transition debt, not permission to
add another concern.

## Dependency rules

- Kernel modules may depend on pure utilities and shared contracts.
- Kernel modules must not import `routes/`, React, or concrete plugin loaders.
- Trusted persistence selection must finish before database preflight and ordinary runtime plugin restoration. Explicit module failures are fatal; the host must not substitute SQLite after selection fails.
- `server/core/turnPersistenceAdapter.js` and `runtimeCapabilityHost.js` must not import the bundled SQLite adapter or storage services. Generic Headless and recovery runtimes must not import `db.js` or SQLite stores; concrete SQL lookup belongs in a host adapter.
- `TurnEngine` and `turnStartRuntime` receive managed-attachment operations only as narrow ports. They must not import the managed attachment store/content implementation, SQLite, or host filesystem modules; public attachment DTOs must never contain a host path.
- Turn persistence and public Session management are reached only through the active persistence adapter and its `sessionAdmin` port; partial custom backends fail closed instead of borrowing SQLite methods.
- A Turn state transition that spans multiple projections crosses one aggregate
  command (`commitTurnStart`, `commitTurnCheckpoint`, or `commitTurnBoundary`);
  orchestration code must not reconstruct these transactions with separate
  Session/Event calls.
- `turnStartRuntime` owns input normalization and the durable start aggregate
  through sequence-zero `turn.started`. It receives only narrow function ports,
  must not import a concrete store/adapter/database, and returns a normalized
  execution DTO to TurnEngine before any execution lease is acquired.
- Checkpoint and boundary aggregate commands carry the immutable execution
  lease proof captured at acquisition. The storage backend, not only the
  in-memory orchestrator, rejects expired or superseded fencing tokens before
  writing any projection.
- Side effects are reached only through the tool execution boundary.
- Host-managed Artifact tools always execute before runtime-tool dispatch.
  Generated files are staged in an exclusive same-directory temporary file,
  flushed and closed before atomic publication, and never expose an empty or
  partial final pathname. Office deliverables are restricted to a fail-closed
  OOXML subset: external relationships, macros, OLE/ActiveX, connections,
  custom UI, Web Extensions, formulas/DDE, and unvalidated embedded packages
  are rejected before publication.
- SSE, WebSocket, audit, and plugins consume normalized Agent Events; they must
  not invent a second lifecycle vocabulary for the same fact.
- Runtime plugin Prompt, Tool, and process-local Loop-hook contributions are
  hosted by `runtimePluginPromptRegistry.js`, `runtimePluginToolRegistry.js`,
  and `runtimePluginEventRegistry.js`. Despite its compatibility name, the
  latter hosts mutable interception/observer hooks such as `request`,
  `pre-tool`, and `post-tool`; these are not the normalized Agent Events in
  `shared/turnEvents.js`. The top-level registry composes these hosts but must
  not regain their validation, ordering, binding, execution, or revocation
  logic. The plugin-facing Agent Event v1 stream is a separate, read-only,
  versioned adapter over the shared vocabulary. It is a post-commit,
  process-local best-effort observer, not a durable subscription: replay,
  global cursors, retention watermarks, retries, and DLQ/ACK state require a
  future host-owned outbox contract rather than coupling consumers to
  retention-pruned `turn_events` rows.
- `runtimePluginContributionCoordinator.js` is the sole transaction owner for
  contribution activation, rollback, revocation, and retirement. Leaf
  registries must never decide plugin record state or discard retained or
  indeterminate revocation handles.
- Replacement adapters are complete and versioned. Missing methods fail closed;
  the host never fills a partial third-party implementation with built-ins.
- The version-6 persistence adapter requires the complete Session, Event
  Log/checkpoint, transaction, execution, steering, recovery,
  `modelRequestRecovery`, and `sessionAdmin` sections. SessionAdmin v2 is the
  current contract; v1 remains accepted only for embedding compatibility. The recovery section must provide
  `getPendingModelRequestRecovery`, `readModelRequestRecoveryResolution`, and
  `resolvePendingModelRequest`; the administration port owns search, list,
  snapshot, branch, mutation, deletion, archive, and pin operations. None may
  be filled from SQLite when a custom adapter is active.
- SessionAdmin v2 normalizes bounded pagination, archive filters, identifiers,
  labels, and CAS revisions before invoking a backend. It validates every
  direct or promised result before the HTTP layer consumes it. Invalid calls
  fail with `SESSION_ADMIN_INPUT_INVALID`; backend contract violations fail
  closed with `SESSION_ADMIN_RESULT_INVALID`.
- SessionAdmin v2 accepts pagination and revision values only as safe integers
  or decimal integer strings; it never coerces arrays, booleans, or objects.
  Results are rebuilt as frozen public DTOs from own data properties, so
  inherited fields, accessors, adapter-private fields, and arbitrary thenables
  cannot cross the port. Replacement/deletion CAS results, snapshot revision
  and pagination, message ownership, and branch-tree structure are checked at
  this boundary rather than deferred to one concrete backend or the UI.
- Every persistence method is `MaybePromise`: direct and Promise results are
  both valid, and every consumer must await them before using the result. Each
  backend remains responsible for atomic start, checkpoint, and terminal
  boundary commits.
- `MaybePromise` stops at the built-in adapter boundary. SQLite transaction
  callbacks and `appendTurnEventsInTransaction` are permanently synchronous
  and must never return a Promise or become `async`; asynchronous backends must
  provide atomicity without moving asynchronous work into those callbacks.

## Completion criteria

The minimal-kernel milestone is complete only when:

1. a small embedding can run the loop by providing adapters without importing
   the application server or SQLite;
2. Turn, Job, CLI, and Subagent use the same loop contract;
3. one Agent Event envelope feeds persistence, SSE/WS, audit, and plugin hooks;
4. all side effects cross one enforceable broker/gate; and
5. the compatibility hosts above are thin composition shells rather than
   business-logic owners.
