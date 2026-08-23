# Lifecycle capabilities

The process lifecycle is split into three layers:

- `server/core/lifecycleCapabilityGraph.js` is the business-free registry and execution graph.
- `server/core/builtinLifecycleAssembly.js` adapts process-owned services into capability definitions.
- `server/core/lifecycle.js` is the compatibility facade used by server bootstrap and signal handlers.

## Capability contract

A capability declares a stable `id`, integer `priority`, optional `dependsOn` IDs, optional `start` and `stop` hooks, independent hook timeouts, a `dependencyFailure` policy (`skip` or `continue`), and a `stopFailure` policy (`fail` or `ignore`). IDs are at most 128 characters and use lowercase letters, digits, `.`, `_`, `:`, or `-`.

`dependsOn` is a readiness dependency, not only an ordering hint. Dependency-free hooks can start concurrently. A dependent hook starts only after every declared dependency has settled. The default `dependencyFailure: 'skip'` prevents it from running after a dependency failure, timeout, or dependency skip; that skip propagates to strict descendants and is audited. `dependencyFailure: 'continue'` is an explicit fail-soft opt-in. Built-in process assembly uses `continue` to preserve its legacy best-effort startup behavior while still waiting for upstream settlement. None of this delays creation of the HTTP listener because readiness remains asynchronous.

Once startup or shutdown execution begins, the registry is locked. Missing dependencies and dependency cycles are rejected before any hook runs.

## Replacement and ownership

Built-in behavior can only be replaced explicitly:

```js
{
  id: 'vendor.runtime-plugins',
  owner: 'vendor-plugin',
  priority: 100,
  replaces: 'builtin.resource.runtime-plugins',
  stop: async ({ signal }) => {},
}
```

The replacement must have strictly higher priority. It keeps the target's logical slot and inherits its dependencies unless `dependsOn` is explicitly supplied. Removing it restores the previous capability. Batch registration is atomic: a later validation failure reverses all earlier registrations and restorations in that batch.

## Host runtime adapters

Lifecycle capability replacement controls process resources. Two narrower host contracts control stateful runtime implementation boundaries:

- `turnPersistenceAdapter` owns the complete `TurnEngine`-facing Session Store, Session management port, append-only Turn Event Log, aggregate Turn commit boundary, and model-request recovery facade. Missing functions are never filled from SQLite.
- `toolLoopAdapter` owns the shared Agent Loop implementation used by Turn, Job, CLI, and Subagent execution. The host keeps event/plugin/hook attachment around the adapter, while the adapter receives one normalized loop context contract.

Both contracts require an explicit version and a complete set of own function data properties. They are snapshotted before activation, cannot be replaced while an engine/run lease is active, and are released in lifecycle shutdown after their consumers stop. There is no default persistence adapter in the kernel. Production `appServer`, Vite, and the CLI Headless host explicitly register `server/adapters/sqliteTurnPersistenceAdapter.js`, resolve the runtime capability snapshot, and pass the selected complete adapter into lifecycle or Headless assembly. Embedded hosts may instead supply their own adapter through `startAppServer({ turnPersistenceAdapter, toolLoopAdapter })` or `bootstrap()`. Direct `TurnEngine`, SessionAdmin, recovery, and generic Headless use fails closed rather than borrowing any SQLite function.

For the browser production host, runtime plugin discovery and enabled-plugin restore finish before the capability snapshot is resolved. A plugin Loop declared as `loop:<adapter-id>` therefore participates in the same startup selection and is active before any Turn, Job, recovery, or subagent work is admitted. Lifecycle shutdown reverses that ownership order: consumers stop first, then the Loop controller releases its run boundary, then runtime plugins unload. Reload or uninstall of the currently active plugin Loop fails closed until that controller has stopped.

The current Turn persistence contract is version 6. Its aggregate boundary, introduced in version 3, requires three commands:

- `commitTurnStart` commits the Session row, imported history, user message, managed-attachment bindings, and `turn.started` as one unit;
- `commitTurnCheckpoint` commits one checkpoint event and its mutable checkpoint projection as one unit;
- `commitTurnBoundary` commits a completed, failed, cancelled, paused, interrupted, or blocked event together with its assistant evidence message.

The built-in SQLite implementation publishes events and lifecycle notifications only after the owning transaction commits. Exact retries must preserve the full event identity, including `createdAt`; checkpoint state is compared in canonical JSON form, and attachment bindings are part of the start-operation identity. Sequence zero belongs only to `turn.started`. A caller-owned transaction helper fails closed when invoked outside an active transaction.

Checkpoint and boundary commits also require the exact execution-lease proof captured when the Turn was acquired: `{ ownerId, fencingToken }`. The token is a durable, monotonically increasing counter that survives lease release. Takeover advances it even when a worker ID is reused, and renew/release/commit operations compare both fields. Missing, expired, or superseded proofs fail with `TURN_EXECUTION_LEASE_STALE` before any event, checkpoint, or evidence message is written.

Version 5 retained version 4's asynchronous-backend contract and added a required `modelRequestRecovery` section with three functions:

- `getPendingModelRequestRecovery` reads the durable pending request descriptor;
- `readModelRequestRecoveryResolution` reads a verified terminal resolution for loop reconciliation;
- `resolvePendingModelRequest` commits the operator-verified resolution.

Version 6 adds the required `sessionAdmin` port. Its current contract is version 2; version 1 remains accepted for existing embedding hosts without applying the v2 wrappers. It owns message search, Session listing and snapshots, branch inspection and creation, CAS message replacement and deletion, archive/unarchive, and pin/unpin. `server/routes/sessionRoutes.js` resolves this port from the active persistence adapter and awaits every call. Read-only Session routes do not acquire a `TurnEngine`; only fork, message replacement, and deletion resolve it for the active-turn conflict check. A custom backend missing any management method is rejected during adapter preparation; the route never fills the gap from SQLite when a custom adapter is active.

SessionAdmin v2 normalizes all inputs before backend invocation. User and Session IDs are required bounded strings; search/list/snapshot pagination becomes bounded safe integers; archive filters use `false | true | all`; fork labels are trimmed and bounded; replacement and deletion require a non-negative CAS revision. Integer fields accept only safe integers or decimal integer strings and never invoke caller-provided coercion hooks. Direct and promised results use the same fail-closed schemas: lists are arrays, Session values expose `id` and `revision`, snapshots and branch trees expose their pagination/shape metadata, and mutations expose structured revision/count results.

The v2 result boundary does not return adapter objects directly. `server/core/sessionAdminDtos.js` reads only own data properties, rejects accessors and inherited required fields, projects the documented public Session/search/message/artifact fields, recursively snapshots plain model-context data, and freezes the resulting DTOs. Adapter-private top-level fields are dropped. It also verifies exact replacement revision increments and counts, deletion's previous revision, snapshot/Session revision equality, message ownership and uniqueness, advancing snapshot pagination, and branch parent/depth structure. Invalid caller input uses `SESSION_ADMIN_INPUT_INVALID`; an invalid backend result uses `SESSION_ADMIN_RESULT_INVALID`. The HTTP boundary maps the former to 400, preserves request-body overflow as `413 REQUEST_BODY_TOO_LARGE`, and emits a sanitized 500 for the latter. Successful mutation responses set the transport-owned `ok: true` after spreading backend fields, so an adapter cannot overwrite that invariant.

Every persistence-adapter method is `MaybePromise`: it may return either a direct value or a Promise. All consumers must await every Session, Event Log/checkpoint, aggregate transaction, execution, steering, recovery, and model-request recovery call before making authorization, existence, terminal-state, recovery, or commit-verification decisions. The built-in SQLite adapter may return direct values while file, worker, or network-backed adapters perform asynchronous I/O. This does not weaken aggregate atomicity: a configured adapter still owns each complete `commitTurnStart`, `commitTurnCheckpoint`, and `commitTurnBoundary` operation and must not expose a partially committed result.

`MaybePromise` applies only at the adapter boundary. The built-in SQLite transaction callback and `appendTurnEventsInTransaction` are permanently synchronous and must never return a Promise or be made `async`; otherwise the SQLite transaction could finish before its writes and checks complete. Asynchronous adapters must implement atomicity in their own backend rather than introducing asynchronous work inside these SQLite callbacks.

This boundary now covers Turn execution and the public Session management routes. It is still not a claim that every user-owned datum is backend-neutral: managed attachments, artifacts, verified-file projections, emergency journals, and data-governance export/erase flows retain separate host storage dependencies.

## Execution and failure policy

Startup hooks are invoked in topological order and their bounded results are exposed through `ready`. Shutdown waits for startup observation, then invokes stop hooks sequentially in exact reverse order. Each hook receives `{ capability, phase, signal }`. Timeout aborts the signal, but adapters must cooperate with cancellation to stop underlying work.

Failures are isolated so remaining cleanup still runs. A failed stop yields exit code `1` only for `stopFailure: 'fail'`. HTTP, SSE, and WebSocket draining always precedes capability shutdown.

Read-only inspection before `bootstrap()` and shutdown of a process that never
bootstrapped use inert host-adapter controllers. They build the same capability
inventory and run process cleanup hooks without selecting or activating
persistence or loop implementations. Runnable lifecycle construction and
`bootstrap()` remain strict and require an explicit complete persistence
adapter. The production host also fences the asynchronous capability-snapshot
continuation after SIGTERM/SIGINT so a completed shutdown cannot be followed by
a late bootstrap. Vite coalesces development shutdown into one Promise and its
`closeBundle` hook awaits that Promise; build mode, where no runtime was
bootstrapped, is a no-op.

The process-level shutdown watchdog includes a bounded HTTP drain allowance plus the sum of every registered stop-hook timeout because stop hooks run serially. Start-only capabilities do not consume that budget. The automatically derived watchdog is capped at ten minutes; an explicit `gracefulShutdown(..., { timeoutMs })` override must be an integer from 1 to 600000 milliseconds.

## Audit and inspection

Registration, replacement, restoration, hook start, success, failure, and timeout events are retained in a bounded in-memory audit log. `listLifecycleCapabilities()` is side-effect free before `bootstrap()` and does not commit default runtime options. `listLifecycleAuditEvents()` returns an empty list before bootstrap and the singleton runtime audit afterwards.

Audit callbacks are observability-only: callback failures cannot alter lifecycle behavior. Audit entries contain capability metadata and normalized error codes, not credentials or arbitrary error payloads.
