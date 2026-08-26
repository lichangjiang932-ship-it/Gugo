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

**Status:** Open  
**Priority:** P1  
**Area:** Network security

**Evidence / reproduction:** Most user-influenced requests use
`server/utils/outboundNetworkGuard.js`, but `server/services/visionAssist.js`
and `server/services/mcpOAuth.js` still require a complete guard audit. Search
production sources for direct `fetch`/`fetchImpl` calls and verify every dynamic
URL has DNS pinning and redirect revalidation.

**Exit criteria:** Every user- or upstream-influenced HTTP(S) destination crosses
the central outbound guard, with explicit exceptions only for compile-time fixed
vendor endpoints.

**Verification:** `tests/outboundNetworkGuard.test.js` plus service-specific
loopback, private-address, DNS-rebinding, and redirect tests.

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

**Status:** Open  
**Priority:** P1  
**Area:** Distribution

**Evidence / reproduction:** Windows packaging and updater verification exist,
but the repository does not define a required production code-signing job or a
verifiable release provenance statement.

**Exit criteria:** Production desktop artifacts are signed, CI fails closed when
credentials or signature verification are unavailable, and published checksums
and provenance are independently verifiable.

**Verification:** `tests/desktopPackaging.test.js`, release-pipeline tests, and a
signature verification smoke test against the produced installer.

## DEBT-PLUGIN-001 — Public plugin compatibility contract

**Status:** Open  
**Priority:** P2  
**Area:** Extensibility

**Evidence / reproduction:** Runtime plugins have versioned local manifests and
capability boundaries, but distribution, compatibility discovery, and ecosystem
interoperability remain project-specific.

**Exit criteria:** Publish a versioned compatibility specification, conformance
fixtures, discovery metadata, and upgrade/deprecation policy without allowing
plugins to bypass host authorization or artifact validation.

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

## Maintenance rules

- Add an entry before intentionally accepting a known defect or architectural
  exception; do not hide it behind an unexplained suppression.
- Every entry must keep the four fields used above: status, priority,
  evidence/reproduction, exit criteria, and verification.
- Close an entry only in the same change that supplies its exit evidence. Keep
  the closed section for release history or link to the replacing design record.
- Update this register when a review proves an item obsolete; static-review line
  counts and filenames are evidence, not permanent truth.
