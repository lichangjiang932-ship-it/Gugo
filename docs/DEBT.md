# Engineering debt register

This is the canonical register for known engineering debt. Legacy labels such
as `A3`, `S4`, or `M3.5` found in old comments describe delivery milestones and
must not be reused as debt identifiers. New entries use `DEBT-<AREA>-NNN`, link
to reproducible evidence, and define an observable exit condition.

## DEBT-ARCH-001 — Turn execution compatibility shell

**Status:** Open  
**Priority:** P1  
**Area:** Runtime architecture

**Evidence / reproduction:** `server/services/TurnEngine.js` remains well over
the repository's 600-line preference, and its execution method still coordinates
prompt preparation, recovery, tool-loop outcomes, terminal evidence, and optional
post-processing. Run `npm run debt:check` to verify that the file can shrink but
cannot grow beyond its recorded ceiling.

**Exit criteria:** Extract cohesive lifecycle and outcome services until the
class is a narrow orchestration shell below 600 lines, without weakening atomic
turn boundaries or recovery fencing.

**Verification:** `tests/turnEngine.test.js`,
`tests/turnPersistenceTransactions.test.js`, and `tests/turnEngineHost.test.js`.

## DEBT-DATA-001 — Legacy schema bootstrap paths

**Status:** Open  
**Priority:** P1  
**Area:** Storage

**Evidence / reproduction:** `server/migrations/` is authoritative from v31
onward, while `server/db.js` still owns the v2-v30 compatibility bootstrap and
inline `CREATE TABLE IF NOT EXISTS` statements. Reasonix also retains a separate
schema version for its legacy boundary.

**Exit criteria:** Fresh and upgraded databases reach the same schema through a
single registry; `server/db.js` contains composition only, and legacy import is
isolated behind one tested compatibility adapter.

**Verification:** `tests/dbMigrationRegistry.test.js`,
`tests/dbMigration.test.js`, and `tests/dbSchemaPreflight.test.js`.

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

**Status:** Open  
**Priority:** P2  
**Area:** Chat UI performance

**Evidence / reproduction:** Normal chat rendering is bounded to an 80-message
window, but locating a very old message may expand a large portion of history.
Profile a multi-hundred-message session while jumping to its earliest result.

**Exit criteria:** Deep-history navigation keeps mounted row count bounded and
preserves variable-height scroll anchoring, keyboard navigation, attachment
previews, and streaming updates.

**Verification:** `tests/chatHistoryWindow.test.js`,
`tests/chatMessageViewport.test.jsx`, and a checked-in performance fixture.

## DEBT-TYPE-001 — Runtime contract type coverage

**Status:** Open  
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

**Status:** Open
**Priority:** P2
**Area:** Agent code intelligence

**Evidence / reproduction:** `server/adapters/lspStdioProvider.js` currently
spawns, initializes, opens one document, queries, shuts down, and reaps a new
server process for every operation. This keeps cancellation and isolation
simple, but repeated navigation cannot reuse a language server's workspace
index and pays cold-start latency each time.

**Exit criteria:** Reuse a bounded process by canonical provider and workspace
without weakening authorization. The pool must synchronize document versions,
isolate cancellation, evict idle workspaces, back off after crashes, cap total
processes, and fully reap children during runtime shutdown.

**Verification:** Extend `tests/lspStdioProvider.test.js` and
`tests/lspRuntime.test.js` with same-workspace reuse, cross-workspace isolation,
crash recovery, cancellation isolation, idle eviction, and shutdown cleanup.

## DEBT-LSP-003 — Configuration and readiness diagnostics

**Status:** Open
**Priority:** P2
**Area:** Operability

**Evidence / reproduction:** `getLspRuntimeStatus()` distinguishes not
configured, invalid configuration, and provider initialization failure, but the
status is not yet projected into authenticated runtime diagnostics or the
settings UI. Operators otherwise observe only that the model-facing tool is
absent; executable or protocol errors first appear on a query.

**Exit criteria:** Authenticated diagnostics expose only bounded status fields
(`enabled`, `providerCount`, `reason`, and stable `code`) without command, args,
environment, cwd, or source paths. Settings and lifecycle diagnostics clearly
separate not configured, invalid, initialization failure, and first-query
execution/protocol failure.

**Verification:** `tests/lspRuntime.test.js`,
`tests/runtimeHostDiagnostics.test.js`, and settings diagnostics component tests.

## DEBT-PLUGIN-001 — Public plugin compatibility contract

**Status:** Open  
**Priority:** P2  
**Area:** Extensibility

**Evidence / reproduction:** Runtime plugins have versioned local manifests,
capability boundaries, and a CAS-protected transactional local package store with
receipts and crash recovery. The shared manifest envelope is only the first
internal unification step: disk-plugin loading, process-local runtime contribution
setup, package-state projection, and their discovery/restore reconciliation still
use separate host paths. Marketplace discovery, publisher identity, and ecosystem
interoperability remain project-specific or absent.

**Exit criteria:** Complete one internal plugin-definition and reconciliation
contract across disk packages and runtime contributions, then publish a versioned
compatibility specification, conformance fixtures, discovery metadata, and
upgrade/deprecation policy without allowing plugins to bypass host authorization
or artifact validation.

**Verification:** plugin manifest, sandbox, lifecycle, permission, and package
conformance suites.

## DEBT-I18N-001 — Legacy server failure copy

**Status:** Open (user-visible leak mitigated)  
**Priority:** P2  
**Area:** Internationalization

**Evidence / reproduction:** Stable failure codes now drive localized client
presentation and server fallback copy is no longer inserted as model-authored
assistant text. Some event fields still retain Chinese compatibility strings for
older clients and stored diagnostics.

**Exit criteria:** Event schemas carry stable presentation keys or codes only;
all supported clients render the five language variants, and compatibility copy
can be removed with an explicit protocol version transition.

**Verification:** `tests/turnEngine.test.js`, `tests/turnClient.test.js`,
`tests/chatFlowGuards.test.js`, and `tests/i18n.test.js`.

## DEBT-SIZE-001 — Oversized backend implementation inventory

**Status:** Open
**Priority:** P1
**Area:** Architecture

**Evidence / reproduction:** `tests/codeDebt.test.js` recursively measures all
JavaScript and TypeScript implementation files under `server/`. Every
pre-existing file above the 600-line preference has an exact frozen ceiling; an
unknown oversized file, growth above a ceiling, a stale exception, or failure
to ratchet a reduced ceiling fails the gate. The former 1,303-line Codex
app-server runtime has been split into runtime, process, and contract modules
below the limit, so it has no frozen exception; every extracted module remains
covered by the same scan.

The machine-readable inventory below is the sole source of frozen backend
ceilings. A file record inherits the architectural reason and exit criteria of
its `group`; this keeps related decomposition work governed together instead of
creating dozens of copy-pasted debt entries. The test rejects duplicate paths
or groups, missing or unused groups, unactionable group text, stale files,
unregistered oversized files, growth, and shrinkage that was not ratcheted.

<!-- debt-size-inventory:start -->
```json
{
  "schemaVersion": 1,
  "debtId": "DEBT-SIZE-001",
  "lineLimit": 600,
  "groups": [
    {
      "id": "adapter-capabilities",
      "reason": "Capability adapters still combine operation catalogs, input normalization, policy checks, execution plumbing, and result projection across many related tools.",
      "exitCriteria": "Extract cohesive operation modules and shared policy or result boundaries until every listed adapter is at or below 600 lines without weakening authorization or tool contracts."
    },
    {
      "id": "artifact-delivery",
      "reason": "Artifact and managed-file services still combine format-specific generation, validation, filesystem policy, and delivery or governance workflows.",
      "exitCriteria": "Separate format handlers, validation policies, governed file access, and delivery orchestration until every listed service is at or below 600 lines with the existing artifact and security suites passing."
    },
    {
      "id": "evolution-control-plane",
      "reason": "Evolution services each coordinate multiple state-machine phases such as grading, canary decisions, promotion, rollback, journaling, and durable operation recovery.",
      "exitCriteria": "Extract transition policies, persistence adapters, and phase-specific executors until every listed evolution service is at or below 600 lines while preserving idempotency and recovery tests."
    },
    {
      "id": "host-protocol-process",
      "reason": "Host protocol and process modules still combine protocol state machines, platform-specific spawning, cancellation, cleanup, and failure recovery.",
      "exitCriteria": "Separate protocol parsing or command handling from reusable process lifecycle primitives until every listed module is at or below 600 lines with cancellation and process-tree cleanup behavior preserved."
    },
    {
      "id": "kernel-runtime-ports",
      "reason": "Kernel-facing ports still aggregate compatibility normalization, lifecycle graph traversal, persistence translation, attachment boundaries, and tool-loop bridging.",
      "exitCriteria": "Narrow each port to one runtime contract and move compatibility or traversal helpers behind focused modules until every listed core file is at or below 600 lines with contract suites unchanged."
    },
    {
      "id": "persistence-state",
      "reason": "Database and store modules still combine schema compatibility, query construction, transaction coordination, concurrency fencing, and domain projection.",
      "exitCriteria": "Extract schema or query repositories, transactional coordinators, and domain mappers until every listed persistence file is at or below 600 lines while migration, atomicity, and recovery tests remain green."
    },
    {
      "id": "plugin-lifecycle",
      "reason": "Plugin modules still combine package persistence, manifest resolution, registry projection, lifecycle control, revocation, recovery, and release garbage collection.",
      "exitCriteria": "Separate transactional package storage, definition resolution, runtime lifecycle, and release cleanup until every listed plugin file is at or below 600 lines without weakening install rollback or revocation guarantees."
    },
    {
      "id": "route-composition",
      "reason": "HTTP composition modules still combine route registration, authentication and validation middleware, request handlers, response projection, and service assembly.",
      "exitCriteria": "Extract bounded route maps, handlers, and presenters until every listed composition file is at or below 600 lines while preserving middleware order, authorization, and API compatibility."
    },
    {
      "id": "tool-infrastructure",
      "reason": "Shared tool infrastructure still combines large schema catalogs, invocation harness behavior, search strategies, compatibility aliases, and output normalization.",
      "exitCriteria": "Move declarative tool specifications and independent harness or search strategies into focused modules until every listed utility is at or below 600 lines with schema snapshots and execution contracts passing."
    },
    {
      "id": "turn-agent-orchestration",
      "reason": "Turn and agent services still coordinate multiple execution phases including context preparation, approval, model loops, jobs, subagents, environment policy, and terminal outcomes.",
      "exitCriteria": "Extract phase-specific services behind explicit ports until every listed orchestrator is at or below 600 lines while preserving turn atomicity, cancellation, authorization, and completion evidence."
    }
  ],
  "files": [
    { "path": "server/adapters/authAccount.js", "ceiling": 649, "group": "adapter-capabilities" },
    { "path": "server/adapters/batchFileTools.js", "ceiling": 1367, "group": "adapter-capabilities" },
    { "path": "server/adapters/browserAutomation.js", "ceiling": 633, "group": "adapter-capabilities" },
    { "path": "server/adapters/codexPluginSkills.js", "ceiling": 637, "group": "adapter-capabilities" },
    { "path": "server/adapters/codingAgentTools.js", "ceiling": 796, "group": "adapter-capabilities" },
    { "path": "server/adapters/fsShellTools.js", "ceiling": 1383, "group": "adapter-capabilities" },
    { "path": "server/adapters/gitWorkbench.js", "ceiling": 628, "group": "adapter-capabilities" },
    { "path": "server/adapters/mediaTools.js", "ceiling": 1175, "group": "adapter-capabilities" },
    { "path": "server/adapters/nativeModelProviders.js", "ceiling": 687, "group": "adapter-capabilities" },
    { "path": "server/adapters/pdfTools.js", "ceiling": 1428, "group": "adapter-capabilities" },
    { "path": "server/adapters/toolProxy.js", "ceiling": 653, "group": "adapter-capabilities" },
    { "path": "server/appServer.js", "ceiling": 817, "group": "route-composition" },
    { "path": "server/core/compactionArchivePort.js", "ceiling": 958, "group": "kernel-runtime-ports" },
    { "path": "server/core/lifecycleCapabilityGraph.js", "ceiling": 733, "group": "kernel-runtime-ports" },
    { "path": "server/core/managedAttachmentRuntimeBoundary.js", "ceiling": 605, "group": "kernel-runtime-ports" },
    { "path": "server/core/subagentRunPersistencePort.js", "ceiling": 633, "group": "kernel-runtime-ports" },
    { "path": "server/core/toolLoopAdapter.js", "ceiling": 736, "group": "kernel-runtime-ports" },
    { "path": "server/db.js", "ceiling": 1653, "group": "persistence-state" },
    { "path": "server/plugins/localPluginPackageStore.js", "ceiling": 1317, "group": "plugin-lifecycle" },
    { "path": "server/plugins/runtimePluginRegistry.js", "ceiling": 968, "group": "plugin-lifecycle" },
    { "path": "server/routes/evolutionRoutes.js", "ceiling": 882, "group": "route-composition" },
    { "path": "server/routes/pluginRoutes.js", "ceiling": 827, "group": "route-composition" },
    { "path": "server/services/TurnEngine.js", "ceiling": 1258, "group": "turn-agent-orchestration" },
    { "path": "server/services/approvalGate.js", "ceiling": 899, "group": "turn-agent-orchestration" },
    { "path": "server/services/artifactGen.js", "ceiling": 1329, "group": "artifact-delivery" },
    { "path": "server/services/contextCompactionRuntime.js", "ceiling": 1037, "group": "turn-agent-orchestration" },
    { "path": "server/services/evolutionAutoLoopService.js", "ceiling": 1027, "group": "evolution-control-plane" },
    { "path": "server/services/evolutionCanaryService.js", "ceiling": 708, "group": "evolution-control-plane" },
    { "path": "server/services/evolutionConfigJournalService.js", "ceiling": 645, "group": "evolution-control-plane" },
    { "path": "server/services/evolutionOnlineGraderService.js", "ceiling": 887, "group": "evolution-control-plane" },
    { "path": "server/services/evolutionOperationService.js", "ceiling": 1330, "group": "evolution-control-plane" },
    { "path": "server/services/evolutionPromotionOnlineGraderService.js", "ceiling": 691, "group": "evolution-control-plane" },
    { "path": "server/services/evolutionPromotionService.js", "ceiling": 942, "group": "evolution-control-plane" },
    { "path": "server/services/evolutionRollbackService.js", "ceiling": 658, "group": "evolution-control-plane" },
    { "path": "server/services/generatedArtifactFormatValidation.js", "ceiling": 893, "group": "artifact-delivery" },
    { "path": "server/services/integrationsStore.js", "ceiling": 1003, "group": "persistence-state" },
    { "path": "server/services/jobRuntime.js", "ceiling": 1140, "group": "turn-agent-orchestration" },
    { "path": "server/services/jobStore.js", "ceiling": 722, "group": "persistence-state" },
    { "path": "server/services/localFileAccessService.js", "ceiling": 969, "group": "artifact-delivery" },
    { "path": "server/services/localHtmlDeliveryValidation.js", "ceiling": 959, "group": "artifact-delivery" },
    { "path": "server/services/localPluginPackageService.js", "ceiling": 1003, "group": "plugin-lifecycle" },
    { "path": "server/services/mailProtocolClient.js", "ceiling": 917, "group": "host-protocol-process" },
    { "path": "server/services/managedAttachmentStore.js", "ceiling": 704, "group": "persistence-state" },
    { "path": "server/services/modelProviderStore.js", "ceiling": 925, "group": "persistence-state" },
    { "path": "server/services/pptxArtifactFormat.js", "ceiling": 764, "group": "artifact-delivery" },
    { "path": "server/services/promptCompiler.js", "ceiling": 653, "group": "turn-agent-orchestration" },
    { "path": "server/services/runtimePluginControlService.js", "ceiling": 1082, "group": "plugin-lifecycle" },
    { "path": "server/services/runtimePluginReleaseGc.js", "ceiling": 797, "group": "plugin-lifecycle" },
    { "path": "server/services/sessionStore.js", "ceiling": 1153, "group": "persistence-state" },
    { "path": "server/services/shellSessionStore.js", "ceiling": 676, "group": "persistence-state" },
    { "path": "server/services/sideEffectExecutionLedger.js", "ceiling": 776, "group": "persistence-state" },
    { "path": "server/services/sqliteFileCompactionArchiveGovernanceStorage.js", "ceiling": 813, "group": "persistence-state" },
    { "path": "server/services/subagentRuntime.js", "ceiling": 1427, "group": "turn-agent-orchestration" },
    { "path": "server/services/turnEventStore.js", "ceiling": 798, "group": "persistence-state" },
    { "path": "server/services/turnExecutionEnvironment.js", "ceiling": 873, "group": "turn-agent-orchestration" },
    { "path": "server/services/turnMessageContext.js", "ceiling": 1048, "group": "turn-agent-orchestration" },
    { "path": "server/services/userDataManagedFileCatalog.js", "ceiling": 1213, "group": "artifact-delivery" },
    { "path": "server/utils/codeSearch.js", "ceiling": 650, "group": "tool-infrastructure" },
    { "path": "server/utils/toolCallHarness.js", "ceiling": 1307, "group": "tool-infrastructure" },
    { "path": "server/utils/toolSchemaCatalog.js", "ceiling": 1077, "group": "tool-infrastructure" }
  ]
}
```
<!-- debt-size-inventory:end -->

**Exit criteria:** Split every frozen backend implementation into cohesive files
at or below 600 lines, removing each frozen entry as it crosses the boundary.
Do not add new inventory entries merely to admit newly created oversized files;
an intentional temporary exception requires a separately reviewed debt record.

**Verification:** `npm run debt:check` discovers every backend JavaScript file,
rejects new oversized files, rejects growth, requires shrinkage to ratchet the
frozen ceiling, and rejects resolved or deleted inventory entries.

## Maintenance rules

- Add an entry before intentionally accepting a known defect or architectural
  exception; do not hide it behind an unexplained suppression.
- Every entry must keep the four fields used above: status, priority,
  evidence/reproduction, exit criteria, and verification.
- Close an entry only in the same change that supplies its exit evidence. Keep
  the closed section for release history or link to the replacing design record.
- Update this register when a review proves an item obsolete; static-review line
  counts and filenames are evidence, not permanent truth.
