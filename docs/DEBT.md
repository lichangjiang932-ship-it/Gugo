# Engineering debt register

This is the canonical register for known engineering debt. Legacy labels such
as `A3`, `S4`, or `M3.5` found in old comments describe delivery milestones and
must not be reused as debt identifiers. New entries use `DEBT-<AREA>-NNN`, link
to reproducible evidence, and define an observable exit condition.

## DEBT-ARCH-001 — Turn execution compatibility shell

**Status:** Closed
**Priority:** P1  
**Area:** Runtime architecture

**Evidence / reproduction:** `server/services/TurnEngine.js` is now a 544-line
lifecycle and composition shell. Prompt and recovery preparation live in
`turnExecutionRuntime.js`, model-loop/checkpoint projection lives in
`turnLoopExecutionRuntime.js`, and execution lease scheduling lives in
`turnSchedulingRuntime.js`.

**Exit criteria:** Met. The class is below 600 lines and the extracted runtimes
retain atomic checkpoint commits, recovery environment fencing, terminal
evidence settlement, and lease cleanup.

**Verification:** `tests/turnEngine.test.js`,
`tests/turnPersistenceTransactions.test.js`, and `tests/turnEngineHost.test.js`.

## DEBT-ARCH-002 — Host compatibility transition surfaces

**Status:** Open
**Priority:** P1
**Area:** Runtime architecture

**Evidence / reproduction:** The `Current transition debt` table in
`docs/KERNEL_BOUNDARY.md` still lists five host compatibility and composition
surfaces outside the target minimal kernel. The former `TurnEngine.js` row was
retired after `DEBT-ARCH-001` recorded its focused execution runtimes and stable
runtime-port rules. The `turnEngineHost.js` row was retired after its transitive
boundary test enforced fail-closed persistence composition and prohibited both
SQLite/database selection and route imports. The `server/db.js` row was retired
after user accounts, tool permissions, auth sessions, login codes, rate limits,
and legacy JSON import moved behind focused stores injected with the facade's
connection provider. Static boundary tests now reject business-table SQL in the
bootstrap facade and reverse imports from those stores. Those settled boundaries
are no longer transition debt. The remaining rows still describe responsibilities
that have not fully crossed their required boundaries, so every one references
this open canonical record instead of appearing as undocumented debt beside an
all-closed register.

Job crash recovery now lives in `jobRuntimeRecovery.js`, including approval
resolution, running-step reset, durable recovery events, and execution-lease
fencing. `jobRuntime.js` only supplies its runtime port callbacks and no longer
owns the recovery transaction.

**Exit criteria:** Close only after every linked transition row is either
removed with evidence that its required boundary has been reached or moved to
a narrower open debt record with its own observable exit criteria. Completion
must preserve the dependency and host-ownership rules in
`docs/KERNEL_BOUNDARY.md`; deleting a row or relabeling a compatibility host
without extracting its remaining responsibility does not repay the debt.

**Verification:** `tests/codeDebt.test.js` requires every kernel transition row
to reference exactly one canonical Open debt record. `tests/dbStoreBoundary.test.js`
and `tests/dbStoreFacadeContracts.test.js` lock the settled database facade/store
boundary, while `tests/jobRuntimeRecoveryBoundary.test.js` prevents recovery
persistence from returning to the Job facade. Boundary-specific changes also run the Turn, persistence, model proxy,
artifact, Job, runtime-plugin, migration, and managed-attachment contract suites
named by the affected row.

## DEBT-DATA-001 — Legacy schema bootstrap paths

**Status:** Closed
**Priority:** P1  
**Area:** Storage

**Evidence / reproduction:** The primary registry now owns the complete v1-v108
path. `v1InitialSchema.js` supplies the idempotent empty-database contract,
`legacyCompatibility.js` isolates the exact v2-v30 upgrade sequence, and
`v108UnifiedBootstrapSchema.js` folds the former Reasonix and defensive
bootstrap paths into the main version chain while retiring
`reasonix_schema_version`. `server/db.js` only composes and runs the registry.

**Exit criteria:** Met. Fresh, v1, legacy, and current databases reach the same
contract through one contiguous registry; upgraded Reasonix rows are preserved,
the old version key is removed, and v108 rejects bootstrap tables whose columns,
indexes, cascading foreign keys, or declared primary/conflict keys are incomplete.

**Verification:** `tests/legacySchemaCompatibility.test.js`,
`tests/dbMigrationRegistry.test.js`, `tests/dbMigration.test.js`,
`tests/dbSchemaPreflight.test.js`, and `tests/dbConflictKeyContract.test.js`.

## DEBT-NET-001 — Remaining outbound HTTP call sites

**Status:** Closed
**Priority:** P2
**Area:** Network security

**Evidence / reproduction:** Vision Assist, MCP OAuth, integration OAuth, all
four social bridges, Google Drive bearer downloads, and GitHub skill downloads
now cross `server/utils/outboundNetworkGuard.js`. Physical requests are DNS
pinned, redirects are revalidated, private and metadata addresses are denied,
and credential-bearing cross-origin redirects fail closed. Telegram attachment
messages persist only opaque file references; bot-token URLs are materialized
as bounded in-memory data URLs only after the inbound contact is authorized.

**Exit criteria:** Every user- or upstream-influenced HTTP(S) destination crosses
the central outbound guard, with explicit exceptions only for compile-time fixed
vendor endpoints.

**Verification:** `tests/outboundNetworkGuard.test.js`,
`tests/integrationOAuth.test.js`, `tests/mcpOAuth.test.js`,
`tests/socialBridgeOutbound.test.js`, `tests/connectorTools.test.js`, and
`tests/skillGithubInstall.test.js`, plus service-specific loopback,
private-address, DNS-rebinding, redirect, response-size, and secret-persistence
tests.

## DEBT-REALTIME-001 — WebSocket resource and trust boundaries

**Status:** Closed
**Priority:** P1
**Area:** Realtime transport

**Evidence / reproduction:** `server/services/turnWebSocket.js` now enforces a
1 MiB client-frame limit, rejects binary frames, accepts authentication only in
the `bearer.*` WebSocket subprotocol, validates browser Origin, rate-limits each
connection, serializes inbound handlers, caps subscriptions at 32, and closes
slow consumers above a 1 MiB send high-water mark. Replay notifications use one
O(1) dirty marker instead of an event array and drain from the durable log.

**Exit criteria:** Realtime clients cannot use URL credentials, cross-site
origins, oversized frames, message floods, unbounded subscription fan-out, or
unbounded send/replay buffers to consume server resources or reorder decisions.

**Verification:** `tests/turnWebSocket.test.js`,
`tests/turnWebSocketProtocol.test.js`, `tests/turnClient.test.js`, and
`tests/approvalDecisionWebSocket.test.js`.

## DEBT-UI-001 — Deep-history rendering cost

**Status:** Closed
**Priority:** P2  
**Area:** Chat UI performance

**Evidence / reproduction:** Before closure, jumping to a message outside the
recent 80-message tail expanded the mounted suffix through that target.

**Resolution:** Chat rendering uses a fixed 80-message sliding window. Timeline
and deep-link navigation center a bounded window on the requested message,
manual backward paging preserves a visible DOM anchor, and returning to the
bottom restores the latest bounded window without mounting the intervening
history.

**Exit criteria:** Deep-history navigation keeps mounted row count bounded and
preserves variable-height scroll anchoring, keyboard navigation, attachment
previews, and streaming updates.

**Verification:** `tests/chatHistoryWindow.test.js`,
`tests/chatMessageViewport.test.jsx`, and `tests/unit/ChatMiniTimeline.test.jsx`.

## DEBT-TYPE-001 — Runtime contract type coverage

**Status:** Closed
**Priority:** P2  
**Area:** Type safety

**Evidence / reproduction:** Runtime ports and event contracts are primarily
JavaScript. Zod protects serialized boundaries, but internal adapter and service
composition still relies on runtime failures for many shape mismatches.

**Exit criteria:** Stable kernel ports, shared event payloads, and persistence
adapter contracts have generated or native static types checked in CI; migration
must be incremental and must not create a second event schema.

**Verification:** type-check CI plus the existing event, adapter, and persistence
contract suites.

## DEBT-RELEASE-001 — Desktop signing and provenance

**Status:** Closed
**Priority:** P1  
**Area:** Distribution

**Evidence / reproduction:** The Windows release job now requires code-signing
secrets before packaging, enables electron-builder `forceCodeSigning`, verifies
timestamped signatures from one certificate on both the installer and packaged
application, pins that signer to the configured production publisher identity,
and requires the same certificate-derived updater publisher identity. Direct
publishing is blocked and published tag assets cannot be overwritten.
It also publishes a deterministic `SHA256SUMS.txt` and creates GitHub build
provenance for every published release asset. Missing credentials, invalid
signatures, checksum generation failures, or attestation failures stop the
release before upload.

**Exit criteria:** Production desktop artifacts are signed, CI fails closed when
credentials or signature verification are unavailable, and published checksums
and provenance are independently verifiable.

**Verification:** `tests/desktopPackaging.test.js`, release-pipeline tests, and a
signature verification smoke test against the produced installer.

## DEBT-EXEC-001 — Code-mode reachability and authorization parity

**Status:** Closed
**Priority:** P1
**Area:** Agent code execution

**Evidence / reproduction:** `run_code` already had a bounded worker, canonical
schema, high-risk approval policy, and executor routing, but the real turn
projection did not classify it as code execution. Its visibility could
therefore follow unrelated file grants, while the dispatcher did not re-check
deployment trust, user tool permissions, identity, or worker-creation rate.
Older client snapshots also omitted the tool from normal turn configuration.

**Exit criteria:** Model visibility and the dispatcher share the same
fail-closed execution policy; neither direct calls nor an earlier approval can
bypass a revoked deployment or user switch. New and migrated clients expose
the tool, every call still requires one-time high-risk approval, worker creation
is rate-limited, and direct success, denial, failure, or cancellation leaves a
bounded audit record without persisting model-authored source code. Runtime
plugins cannot replace the host-bound `run_code` implementation and bypass its
worker containment or execution-time policy checks.

**Verification:** `tests/turnToolContextPolicy.test.js`,
`tests/runCodeRuntime.test.js`, `tests/toolAuditLifecycle.test.js`,
`tests/serverTurnFlow.test.js`, `tests/appStatePersistence.test.js`,
`tests/approvalPolicy.test.js`, `tests/toolRiskMetadata.test.js`, and
`tests/runtimePluginCapabilityBinding.test.js`.

## DEBT-EXEC-002 — Gate-before-start Windows process-tree ownership

**Status:** Closed
**Priority:** P1
**Area:** Execution isolation

**Evidence / reproduction:** `runProcessWithGroup` on Windows now starts only the
trusted `windowsProcessGateChild.js` gate, binds that live process identity to a
private Job Object, and waits for both the gate handshake and the worker lease
before sending the target command. The target and its descendants therefore
inherit Job membership before user code can run. A failed worker startup or
bind never sends the start request and is projected as the stable
`PROCESS_ISOLATION_FAILED` tool result instead of falling back to a bare PID or
`taskkill` cleanup path.

**Exit criteria:** The gate-before-start path uses
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; cancellation, timeout, and normal root
exit terminate the complete job, and cleanup succeeds only after
`QueryInformationJobObject` reports zero active processes. Lease disposal
closes the job and retained root-process handles, so worker failure also invokes
the kill-on-close boundary. Startup or ownership failure keeps the user target
gated and returns a stable failure result.

Legacy callers that pass an already-running process to `terminateProcessTree`
use a hybrid late-bind path: it identity-checks the observable descendant tree,
binds the root to a Job Object, and refuses to report success until the job and
all retained identities are empty across stable snapshots. That path cannot
retroactively recover a descendant whose complete parent chain disappeared
before its first snapshot, so this closed item does not claim atomic ownership
for arbitrary pre-existing trees.

**Verification:** `tests/processGroup.test.js` covers worker startup and runtime
failure, cancellation while preparing, bind ordering and bind failure, target
execution after a successful bind, gated descendant cleanup after the root
exits, and identity-checked late-bind cleanup of a real three-level process tree.
`tests/processGroupCancellation.test.js` verifies that cancellation waits for
the Windows child tree to release its working directory.

## DEBT-LSP-001 — Native language-server navigation

**Status:** Closed
**Priority:** P1
**Area:** Agent code intelligence

**Evidence / reproduction:** The runtime previously exposed text and heuristic
code search but no Language Server Protocol boundary. It now has an optional,
provider-neutral read-only service and a byte-accurate stdio adapter for
definition, reference, implementation, and hover queries. Provider commands
require an exact absolute-file allowlist; malformed or conflicting configuration
fails closed and leaves the model-facing tool undiscoverable.

**Exit criteria:** Main turns, planning explorers, and subagents can use the same
authorized LSP tool without acquiring write capability. Source, workspace, and
returned locations are re-authorized; cancellation, timeout, shutdown, protocol
limits, concurrency, result bounds, host sensitive-environment filtering,
runtime-injection-key rejection, and process-tree cleanup remain enforced.

**Verification:** `tests/lspService.test.js`,
`tests/lspStdioProvider.test.js`, `tests/lspRuntime.test.js`,
`tests/lspTool.test.js`, `tests/builtinLifecycleAssembly.test.js`,
`tests/headlessLifecycleAssembly.test.js`, and
`tests/serverToolCapabilities.test.js`.

## DEBT-LSP-002 — Per-query language-server cold starts

**Status:** Closed
**Priority:** P2
**Area:** Agent code intelligence

**Evidence / reproduction:** The stdio provider now keeps one reusable language
server session per canonical provider/workspace key. Open documents remain
scoped to that session and changed source is synchronized through monotonic
`didChange` versions; a single request cancellation sends `$/cancelRequest`
without terminating sibling queries.

**Exit criteria:** Met. The bounded pool isolates canonical workspaces, evicts
idle sessions, applies exponential crash backoff, refuses new work when every
process slot is leased, and tracks both active and already-evicting cleanup so
runtime shutdown cannot resolve before every child process is reaped. Existing
source/workspace authorization, environment filtering, protocol bounds, and
read-only server-request policy remain enforced.

**Verification:** Extend `tests/lspStdioProvider.test.js` and
`tests/lspRuntime.test.js` with same-workspace reuse, cross-workspace isolation,
crash recovery, cancellation isolation, idle eviction, and shutdown cleanup.

## DEBT-LSP-003 — Configuration and readiness diagnostics

**Status:** Closed
**Priority:** P2
**Area:** Operability

**Evidence / reproduction:** Authenticated system diagnostics now project the
LSP runtime through exactly four bounded fields (`enabled`, `providerCount`,
`reason`, and stable `code`). Unauthenticated callers are rejected before the
runtime is inspected, and the projection never includes command, args,
environment, cwd, or source paths. Settings distinguishes not configured,
invalid configuration, initialization failure, first-query execution failure,
and first-query protocol failure in all supported locales.

**Exit criteria:** Authenticated diagnostics expose only bounded status fields
(`enabled`, `providerCount`, `reason`, and stable `code`) without command, args,
environment, cwd, or source paths. Settings and lifecycle diagnostics clearly
separate not configured, invalid, initialization failure, and first-query
execution/protocol failure.

**Verification:** `tests/lspRuntime.test.js`,
`tests/runtimeHostDiagnostics.test.js`, `tests/builtinHttpDiagnostics.test.js`,
and `tests/unit/SettingsDiagnosticsPanel.test.jsx`.

## DEBT-PLUGIN-001 — Public plugin compatibility contract

**Status:** Closed
**Priority:** P2
**Area:** Extensibility

**Evidence / reproduction:** Runtime plugins have versioned local manifests,
capability boundaries, and a CAS-protected transactional local package store with
receipts and crash recovery. The public v1 compatibility contract now includes
offline local Marketplace metadata, deterministic conformance fixtures, Ed25519
publisher-key verification, explicit-only installation, and upgrade/deprecation
policy. Remote sources and automatic installation fail closed. Direct-local
development packages remain available but are explicitly marked publisher
unverified. `pluginDistributionContract.js` now owns the bounded distribution
snapshot, public v1/v2 receipt projection, publisher trust identity, and stored
Release reconciliation used by disk discovery, plugin definitions, package-state
projection, and runtime restore. Only a Release that genuinely predates the
distribution field receives legacy compatibility; an explicit `null`, changed
source/trust flags, receipt schema, publisher ID, or publisher key fails closed.

**Exit criteria:** Met. Disk packages and runtime transformer Releases share one
internal definition/reconciliation contract, and the public versioned specification,
conformance fixtures, discovery metadata, and upgrade/deprecation policy are
executable without weakening host authorization or artifact validation. Network
Marketplace discovery, publisher CA/revocation, and transparency services remain
explicit v1 non-goals rather than implied trust claims.

**Verification:** `docs/PLUGIN_COMPATIBILITY_V1.md`,
`tests/fixtures/plugin-compatibility-v1/`, `tests/localPluginMarketplace.test.js`,
`tests/pluginDistributionContract.test.js`, `tests/pluginDefinition.test.js`,
`tests/pluginDistribution.test.js`, `tests/runtimePluginControl.test.js`, and plugin
manifest, sandbox, lifecycle, permission, and package conformance suites.

## DEBT-I18N-001 — Legacy server failure copy

**Status:** Closed
**Priority:** P2
**Area:** Internationalization

**Evidence / reproduction:** New failed, interrupted, blocked, and cancelled Turn
events require stable uppercase codes and reject `message`, `hint`, and `reason`
presentation copy at both the top level and nested error boundary. Paused events
likewise reject the legacy free-text `reason`. The emitter removes compatibility
copy before persistence, all cancellation paths emit `TURN_CANCELLED`, and the
client renders localized copy from stable codes in both supported languages.
Existing rows remain readable only through the explicit
`parsePersistedTurnEvent()` compatibility boundary; replay projects those rows
to the same code-only public shape before any new write.

**Exit criteria:** Met. Current event writes are code-only, localized presentation
is client-owned, and pre-transition persisted/raw SSE events have a named,
read-only legacy parser rather than weakening the current write schema.

**Verification:** `tests/turnEvents.test.js`, `tests/turnEventEmitter.test.js`,
`tests/turnEventProjection.test.js`, `tests/turnEventRoutes.test.js`,
`tests/turnPersistenceTransactions.test.js`, `tests/turnCancellationRuntime.test.js`,
`tests/turnEngine.test.js`, `tests/turnClient.test.js`,
`tests/chatFlowGuards.test.js`, and `tests/i18n.test.js`.

## DEBT-I18N-002 — Monolithic translation catalog

**Status:** Closed
**Priority:** P2
**Area:** Internationalization

**Evidence / reproduction:** The UI intentionally supports only `zh` and `en`,
and legacy `ja`, `ko`, and `zh-TW` preferences normalize to English. The public
catalog API now stays in the 43-line `src/i18n/translations.js` entry point,
while translation data is split across 57 cohesive modules under
`src/i18n/domains/`; the largest domain module is 564 lines.

**Exit criteria:** Met. The public lookup API is unchanged, Chinese and English
keys remain symmetric, and `tests/codeDebt.test.js` enforces a 600-line limit
for both the entry point and every domain module.

**Verification:** `tests/codeDebt.test.js`, `tests/i18n.test.js`, and
`npm run i18n:check`.

## DEBT-EVOLUTION-001 — Runtime config automatic review orchestration

**Status:** Closed
**Priority:** P2
**Area:** Self-evolution safety

**Evidence / reproduction:** The `config:runtime` safety primitives already
provided deterministic no-side-effect replay, host-policy evaluation, explicit
local-owner approval, a second apply confirmation, CAS publication, and durable
rollback. The remaining gap was orchestration: callers had to invoke replay,
evaluation, and approval-review discovery separately. The dedicated automatic
review service and local-owner-only API now perform those audit phases together
and stop in `awaiting_explicit_approval` or `not_eligible`.

**Exit criteria:** Met. Automatic review cannot create an approval, apply a
configuration, enter canary, or expand permissions. A passing review still
requires an explicit local-owner decision and the existing second apply
confirmation; an explicitly applied change retains the existing rollback and
crash-recovery protocol.

**Verification:** `tests/evolutionConfigReview.test.js`,
`tests/evolutionConfig.test.js`, and `tests/evolutionConfigStartupRecovery.test.js`.

## DEBT-SIZE-001 — Oversized runtime implementation inventory

**Status:** Closed
**Priority:** P1
**Area:** Architecture

**Evidence / reproduction:** `tests/codeDebt.test.js` recursively measures all
JavaScript and TypeScript implementation files under `server/`, `shared/`,
`desktop/`, and `bin/`. Every pre-existing file above the 600-line preference
has an exact frozen ceiling; an unknown oversized file, growth above a ceiling,
a stale exception, or failure to ratchet a reduced ceiling fails the gate. The
former 1,303-line Codex app-server runtime has been split into runtime, process,
and contract modules below the limit, so it has no frozen exception; every
extracted module remains covered by the same scan.

The machine-readable inventory below is the sole source of frozen runtime
ceilings. A file record inherits the architectural reason and exit criteria of
its `group`; this keeps related decomposition work governed together instead of
creating dozens of copy-pasted debt entries. The test rejects duplicate paths
or groups, missing or unused groups, unactionable group text, stale files,
unregistered oversized files, growth, and shrinkage that was not ratcheted.

`artifactGen.js` is now a 253-line compatibility facade and
`evolutionOperationService.js` is a 30-line facade. Their extracted publication,
lease, lifecycle, terminal, recovery, and query modules are all below 600 lines,
so both former frozen exceptions have been removed from the inventory.

`pdfTools.js` is now a 17-line compatibility facade. PDF input/output policy,
read/render operations, transformations, and tool schemas live in focused
modules of 505 lines or fewer, so its former frozen exception is also removed.

`batchFileTools.js` is now a 21-line compatibility facade. ZIP creation,
archive catalog validation, extraction/publication, hashing, and tool schemas
live in focused modules of 467 lines or fewer, so its former frozen exception
is also removed.

`subagentRuntime.js` is now a 566-line stable facade and single-run
orchestrator. Runtime policy, tool-loop execution, durable run state, and batch
coordination live in focused modules of 327 lines or fewer, so its former
frozen exception is also removed.

`managedAttachmentRuntimeBoundary.js` now delegates its public capacity
contract to a focused limits module, `promptCompiler.js` delegates deterministic
LRU fingerprinting and cache telemetry to `promptCompilerCache.js`, and
`codeSearch.js` delegates its declarative tool schemas to
`codeSearchToolSpecs.js`. Each implementation is now below 600 lines, so their
former frozen exceptions have been removed.

`codexPluginSkills.js` now delegates discovery limits and defensive public-view
projection to focused modules, while `browserAutomation.js` delegates its CDP
transport, cancellation, and request timeout lifecycle to `browserCdpClient.js`.
Both former frozen exceptions have been removed.

`subagentRunPersistencePort.js` now delegates hostile-boundary validation and
immutable data projection to `subagentRunPersistenceBoundary.js`, leaving the
port focused on adapter preparation and lifecycle binding. Its former frozen
exception has been removed.

`evolutionRollbackService.js` now delegates outcome aggregation, breach
classification, and decision-safe telemetry projection to the pure
`evolutionRollbackMetrics.js` module. Its former frozen exception has been
removed.

`authAccount.js` now delegates SMTP diagnostics, DNS pinning, protocol flow,
and development-code response projection to `authMailTransport.js`. The
outbound-host hardening remains intact and its former frozen exception has been
removed.

`mediaTools.js` is now a 239-line compatibility facade. Binary discovery,
bounded child-process execution, path policy, and atomic commits live in
`mediaToolRuntime.js`; pure transform validation and FFmpeg command planning
live in `mediaTransformPlan.js`; declarative schemas live in
`mediaToolSpecs.js`. All extracted modules are below 600 lines, so the former
frozen exception has been removed.

`toolCallHarness.js` is now a 41-line compatibility facade. Argument parsing,
error normalization and retry, result projection, reusable primitives, and
loop guards live in five focused modules of 425 lines or fewer. Its former
frozen exception has been removed with the public import surface unchanged.

`fsShellTools.js` is now an 84-line compatibility facade. Path and grant
support, file operations, shell execution, output verification, and declarative
tool schemas live in five focused modules of 403 lines or fewer. Its former
frozen exception has been removed without changing the authorization or public
tool contract.

`nativeModelProviders.js` is now a 444-line registry, response, and streaming
facade. Anthropic and Gemini message conversion and request construction live
in the 243-line `nativeModelProviderRequests.js` module. Both are below 600
lines, so the former frozen exception has been removed with plugin override and
provider failover behavior unchanged.

`evolutionConfigJournalService.js` is now a 508-line persistence and recovery
service. Strict event and journal validation, document hashing, and fingerprint
verification live in the 167-line `evolutionConfigJournalValidation.js`
module. Both are below 600 lines, so the former frozen exception has been
removed with atomic claim, restore, and reconciliation behavior unchanged.

`codingAgentTools.js` is now a 447-line command, patch, test, and Docker
orchestrator. Streaming download and atomic commit, shared permission and
redaction support, and declarative schemas live in focused modules of 187 lines
or fewer. Its former frozen exception has been removed with the legacy exports
and download security contract preserved.

`shared/turnEvents.js` now delegates the non-durable activity schema and
constructors to `shared/turnActivity.js` while preserving the original public
exports. Both modules are below 600 lines, so the former frozen exception has
been removed without changing persisted event or transport compatibility.

`bin/cli/runOutput.js` now delegates serialized writable-stream handling to
`bin/cli/runOutputStream.js` while preserving the original public error export
and ordered output contract. Both modules are below 600 lines, so the former
frozen exception has been removed without changing text or JSONL semantics.

`desktop/main.js` now delegates main-window security and updater setup to
`desktop/mainWindowSecurity.js` and `desktop/updateSetup.js`. All three modules
are below 600 lines, so the former frozen exception has been removed while
preserving trusted navigation, permission, update, and window contracts.

`shared/artifactIntent.js` now delegates skill alias resolution, file-target
parsing, and standalone format checks to `shared/artifactIntentSupport.js`.
Both modules are below 600 lines, so its former frozen exception has been
removed without changing the shared public intent API or delivery semantics.

All previously frozen runtime implementations are now at or below 600 lines.
`bin/yma-cli.js` is a 500-line executable facade and local headless-run boundary;
server command parsing, scoped credential storage, API transport, and remote
command handlers live in `bin/cli/serverCommands.js`, while shared CLI errors
live in `bin/cli/errors.js`. All three files are below the limit, the original
entrypoint exports remain stable, and the final frozen exception is removed.

<!-- debt-size-inventory:start -->
```json
{
  "schemaVersion": 1,
  "debtId": "DEBT-SIZE-001",
  "lineLimit": 600,
  "groups": [],
  "files": []
}
```
<!-- debt-size-inventory:end -->

**Exit criteria:** Close only after every frozen runtime implementation is split
into cohesive files at or below 600 lines and the inventory is empty. Do not add
new inventory entries merely to admit newly created oversized files; an
intentional temporary exception requires a separately reviewed debt record.

**Verification:** `npm run debt:check` discovers JavaScript and TypeScript
implementation files under `server/`, `shared/`, `desktop/`, and `bin/`; rejects
new oversized files and requires the closed inventory to remain empty.

## Maintenance rules

- Add an entry before intentionally accepting a known defect or architectural
  exception; do not hide it behind an unexplained suppression.
- Every entry must keep the four fields used above: status, priority,
  evidence/reproduction, exit criteria, and verification.
- Close an entry only in the same change that supplies its exit evidence. Keep
  the closed section for release history or link to the replacing design record.
- Update this register when a review proves an item obsolete; static-review line
  counts and filenames are evidence, not permanent truth.
