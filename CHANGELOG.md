# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Added a shared immutable plugin manifest envelope for runtime and trusted build-time UI plugins, with exact UI contribution declarations and dependency-aware unload protection.
- Enforced runtime plugin contribution declarations as a fail-closed permission boundary for tools, loop events, services, and model providers.
- Added a local-owner-only, versioned runtime plugin inventory exposing pure JSON manifests and lifecycle metadata across the server/renderer boundary.
- Added sandbox-preflighted transformer reloads that atomically switch source for new calls while preserving the active tool and old source on validation failure.
- Added a user-scoped, append-only self-evolution evidence corpus for explicit feedback and whitelisted structured Reviewer verdicts, without any automatic mutation path.
- Added deterministic self-evolution dataset curation with secret/path redaction, content deduplication, rule-versioned failure clusters, stable fingerprints, and reversible user-scoped exclusions.
- Added no-tool self-evolution candidate generation that stores inert, user-scoped prompt/plugin/config proposals with curated provenance and no apply or install path.
- Added immutable prompt replay suites that run baseline and candidate instructions against identical sanitized cases, fixed models, and fixed parameters without tools or evaluation authority.
- Added independent replay evaluation with host-computed quality, safety, latency, and cost gates that cannot pass with missing evidence and grants no approval authority.
- Added immutable local-owner human decisions bound to candidate, replay, evaluation, and rollback fingerprints, without applying or installing candidates.
- Added local-owner-only prompt canaries for approved workspace-instruction candidates, restricted to explicit chat sessions and deterministic 1–10% traffic, with per-turn baseline revalidation and append-only assignments/outcomes.
- Added immutable pre-start canary rollback policies and deterministic automatic rollback on predeclared reliability, latency, or fully measured provider-cost regressions, without rewriting workspace instructions or exposing a manual rollback endpoint.
- Added manifest-gated trusted runtime prompt-context contributions with fixed additive ordering, frozen metadata-only scope, strict count/byte budgets, fail-open auditing, reversible lifecycle, and no disk-transformer access.
- Added lifecycle-aware runtime service invocation and a trusted veto-only task review guard that can downgrade but never upgrade core Reviewer verdicts, preserves host evidence, and fails closed when an active guard malfunctions.
- Added a trusted task plan guard that can only require the existing durable human approval gate, cannot rewrite plans or cancel stricter host policy, and closes retry/manual-completion approval bypasses.
- Restricted tool events so `event:pre-tool` can replace only args on an isolated call copy and `event:post-tool` receives only an immutable outcome snapshot, preserving host-owned identity, checkpoint, registration, idempotency, validation, approval, audit, and result boundaries.
- Converted pre-step, compaction, and turn-stopping events to fail-open immutable observers with metadata-only context, preventing event declarations from bypassing exact prompt/tool contributions or rewriting host terminal and recovery state.
- Replaced raw runtime service lookup with lifecycle-aware invocation, declared provider dependencies, own-method dispatch, and bounded immutable data snapshots so stale consumers and service results cannot leak process capabilities.
- Fenced runtime model-provider adapters behind own synchronous methods and plugin callback accounting, preventing stale request/stream snapshots from executing plugin code after unload.
- Isolated runtime model-provider arguments and results as bounded plain data, with wrapper-owned opaque stream state tokens that reject capability leakage and forged state.
- Isolated runtime plugin tool invocations behind frozen plain-data arguments/results, metadata-only execution context, and callback-scoped cancellation signals without exposing raw Job, Step, budget, or approval objects.
- Kept runtime plugin tool result traversal and thrown-value sanitization inside lifecycle callback accounting, exporting only detached non-retryable errors without accessor, cause, stack, or object identity leakage.
- Snapshotted runtime service methods at registration and fenced service result/error completion inside provider callback accounting, preventing method swaps, Proxy traps, raw causes, and retry control from escaping the lifecycle boundary.
- Isolated runtime event inputs/results/errors inside lifecycle accounting, hid and restored model-request capabilities, projected request failures as metadata only, and discarded observer return capabilities.
- Kept runtime model-provider thenable checks, result/state snapshots, shape validation, and thrown-value sanitization inside synchronous lifecycle accounting, exporting only detached non-retryable errors.
- Fenced runtime prompt thenable checks, text normalization, block-size validation, and thrown-value sanitization inside synchronous lifecycle accounting while preserving fail-open auditing.
- Added lifecycle cleanup scoping so uninstall and setup-rollback disposers fail fast instead of deadlocking when they await self-unregister or registry shutdown.
- Snapshotted disposer own methods at registration and detached cleanup failures inside lifecycle accounting, preventing accessor, prototype, method-swap, cause, retry, and error-identity leakage.
- Scoped plugin setup completion and returned-effect registration inside installation accounting, failing fast on self-waits and exporting only detached non-retryable setup errors.
- Snapshotted runtime tool and prompt contribution definitions from own data properties, rejecting getter/prototype callbacks and registration-time method or schema swaps.
- Hardened the shared runtime/UI plugin manifest envelope to own data properties and dense string arrays, preventing getter, prototype, sparse-array, and post-registration mutation influence.
- Isolated runtime plugin context config and audit payloads as bounded deeply frozen plain data, preventing host-reference, accessor, capability, and post-emission mutation leakage.
- Removed the unused Job/Step loop-binding context channel and snapshotted loop event-bus own methods, preventing getter, prototype, method-swap, and host-reference leakage.
- Froze detached runtime plugin inventory snapshots and stopped registry query identifiers from executing object coercion callbacks.
- Snapshotted runtime prompt render scope from own string data properties and dense skill ID arrays, rejecting getter, prototype, sparse-array, and coercion callbacks before renderer execution.
- Snapshotted runtime registry host adapters from constructor option own data properties, preventing getter, prototype, and post-construction method-swap influence.
- Snapshotted trusted UI contribution definitions and dense input/tool-name arrays once before manifest validation and installation, preventing accessor, prototype, method-swap, sparse-array, and TOCTOU influence.
- Hardened trusted UI registry queries to accept only real strings and return frozen plugin lists, preventing object-coercion callbacks and caller-side list mutation.
- Snapshotted runtime plugin plain-data and tool-schema array lengths from own descriptors, preventing Proxy property-read execution and post-descriptor length TOCTOU.
- Hardened setup/disposer effect collections to dense own-data arrays and intrinsic Set traversal, rejecting accessor, prototype, sparse, iterator-override, and cyclic collection influence.
- Made runtime service argument lists fail closed when they are not real arrays, preventing silent empty-argument execution and object coercion/iterator callbacks.
- Made plugin effect-batch registration validate fully before committing, preventing caught definition failures from leaving partial cleanup prefixes.
- Bounded plugin effect collections to 32 levels, 8192 traversal nodes, and 4096 disposers, failing closed before cleanup registration on oversized input.
- Moved runtime model-provider required-method and stream-group validation into the wrapper, preventing custom host adapters from registering incomplete or accessor/prototype-backed definitions.
- Hardened runtime plugin tool cancellation bridging with AbortSignal/EventTarget intrinsics and Proxy fail-safe rejection, preventing host-signal traps or overridden methods from executing before callbacks.
- Replaced sync callback thenable assimilation with own-descriptor detection and native-Promise-only rejection handling, preventing custom `then()` code from escaping lifecycle accounting.

## [0.11.31] - 2026-08-20

### Added

- Added a model-isolated terminal Reviewer with auditable verdicts and strict fail-closed enforcement when independent review cannot be proven.
- Added semantic UI roles for accent contrast, focus, danger, warning, running, and success, with WCAG contrast and text-size regression gates.
- Added an explicit, fail-closed HTTPS image-origin allowlist for managed and local HTML side previews without enabling remote scripts, styles, frames, forms, or network APIs.

### Changed

- Moved host focus and status styling away from the customizable brand accent and automatically select a WCAG-compliant foreground for accent backgrounds.
- Preflight capability-scoped HTML preview tickets with same-origin HEAD requests before mounting iframe content.
- Bundled a version-locked, platform-specific ripgrep executable for code search instead of depending on host package managers.

### Fixed

- Automatically revoke and reissue one expired, evicted, or failed HTML preview ticket while preventing late results from a previous tab from replacing the current preview.
- Prevented iframe `load` events from treating 401, 403, 404, or 5xx server error documents as successful artifact or local-file previews.

## [0.11.29] - 2026-08-19

### Changed

- Replaced account credentials in channel and notification event streams with short-lived, one-time, stream-scoped tickets and safe reconnect reconciliation.
- Made right-sidebar file tabs preserve and upgrade retained or verified local outputs across cancellation, restart, and session snapshot races.
- Loaded managed and local HTML through scoped preview sessions so relative images, styles, fonts, media, and nested pages render without exposing account tokens.

### Fixed

- Kept delivered local files available after interrupted turns and runtime restarts while deduplicating repeated receipts and cross-turn tool-call identifiers.
- Made the sidebar reliably open images, audio, video, PDF, Office, text, Markdown, data, code, and HTML files with retry and original-file fallbacks.
- Prevented query-authenticated HTML attachment previews from executing scripts, submitting forms, or exfiltrating credentials.

## [0.11.28] - 2026-08-19

### Added

- Added owner-scoped local runtime plugin lifecycle controls with persisted enablement, startup restoration, serialized state changes, and sandboxed transformer tool registration.
- Added unified right-side previews for current attachments and delivered files across images, audio, video, PDF, text, code, Markdown, and Office formats.

### Changed

- Added authenticated HEAD and byte-range attachment responses so local audio and video previews support normal browser seeking while remaining user-isolated.
- Kept HTML and SVG attachments download-only by default, with explicit sandboxed inline preview responses protected by restrictive content headers.

### Fixed

- Hardened Windows credential-key ACL replacement so stale explicit grants are removed before access is limited to the current OS user.
- Required differential-update blockmaps before publishing a Windows release, preventing incomplete updater asset sets.
- Made fetch-backed file preview failures recoverable in place with a real retry and an original-file fallback.

## [0.11.27] - 2026-08-19

### Added

- Added supervised MCP reconnection with bounded backoff, user-scoped live tool registration, and connection-state events.
- Added resumable desktop updates with verified range downloads, differential blockmaps, retained partial progress, and safe full-download fallback.
- Added reusable persistent Shell sessions with isolated working directories, serialized commands, interruption recovery, and idle cleanup.
- Added user-scoped session forks with durable lineage, fresh message identities, a depth-five limit, and a compact context-menu action.
- Added exact scheduled-task grants and durable job provenance for approved Shell and external targets.
- Added extensible model-provider and preview-renderer registries plus an immutable outbound-message privacy boundary.

### Changed

- Buffered high-frequency turn events behind durability barriers and recorded exhausted writes for later diagnosis.
- Made managed HTML previews owner-scoped, time-limited, same-origin, read-only, and restricted to declared assets.
- Cached workspace instructions safely and kept the responsive chat and workbench layout usable on narrower windows.
- Kept the composer free of shortcut hints and the conversation history flat, with session forks available only from the context menu.

### Fixed

- Prevented local HTML repair turns and existing media transformations from being redirected to unrelated image generation.
- Kept custom provider response adapters bound to in-flight requests even after plugin unload.
- Kept verified local file edits available after later managed-artifact failures without exposing drafts.
- Restricted task grants to explicit supported tools and exact safe targets while preserving approval requirements for local writes.

## [0.11.26] - 2026-08-19

### Added

- Added a reversible runtime plugin lifecycle for tools, events, and services, including dependency checks, failed-install rollback, asynchronous cancellation, and graceful shutdown.
- Added automatic, user-scoped runtime plugin discovery to interactive turns and background jobs.

### Fixed

- Bound dynamic tool schemas, approvals, checkpoints, and execution to one immutable plugin registration so a same-name hot swap cannot execute the replacement plugin for an older call.
- Prevented runtime plugins from shadowing reserved server tools, forging tenant scope, or inheriting name-only approval grants and risk overrides.

## [0.11.25] - 2026-08-19

### Changed

- Restored the left conversation history to a compact one-line list while preserving pinned/recent ordering, search, collapse, and session actions.

### Fixed

- Removed the input-history and Enter/Shift+Enter shortcut hint from the chat composer without changing keyboard navigation or send behavior.

## [0.11.24] - 2026-08-19

### Added

- Added a headless `gugo run` entry point with piped prompts, resumable turns, durable lease recovery, JSONL output, and fail-closed non-interactive approvals.
- Added project trust management, declared tool-risk metadata, full-stage redacted tool auditing, and durable inbox approval for permission escalation.
- Added a shared extensible tool-loop entry point with waterfall events, atomic pre-side-effect checkpoints, and benchmarked recovery paths.

### Changed

- Centralized tool schemas and runtime execution primitives so Chat, Jobs, Turns, CLI, and nested agents share the same validation and lifecycle behavior.
- Split loop responsibilities into focused modules for context, guards, steering, checkpoints, events, runtime state, and tool execution.
- Refined the conversation workspace with neutral colors, clearer Chinese typography, calmer code and tool labels, roomier navigation, and consistent depth and rounding.

### Fixed

- Distinguished artifact edits from new artifact generation, preventing repair prompts from forcing unrelated generators or entering retry loops.
- Made composer history navigation respect multiline editing boundaries and clearly expose its active state and preference.
- Hardened read-only Shell detection with exact argument prefixes and unconditional metacharacter rejection.
- Added scheduler catch-up and overlap protection, balanced compaction boundaries, atomic checkpoint persistence, and resumable post-compaction tool rounds.
- Versioned and validated WebSocket frames while rejecting malformed input without logging raw payloads.
- Kept permission widening pending until durable approval, rejected editable or stale escalation requests, and applied tightening immediately.

## [0.11.18] - 2026-08-17

### Changed

- Made verified local HTML previews load their adjacent images, stylesheets, scripts, fonts, media, and nested resources through a short-lived, owner-scoped preview session.
- Made Agents reopen and validate final local HTML files, automatically repair broken or undecodable dependencies, and continue the same tool loop before claiming completion.

### Fixed

- Matched right-sidebar website rendering with opening the same file directly, including relative background images and linked assets.
- Prevented historical HTML files from being mistaken for the current turn's deliverable and triggering unnecessary recovery calls.
- Kept preview capability tickets out of account-auth URLs and request logs while blocking traversal, symlink escape, cross-user access, and revoked grants.

## [0.11.17] - 2026-08-17

### Changed

- Restored the settings page to separate, directly navigable modules on desktop and narrow screens.
- Made file-producing Agents diagnose failed calls, force the correct generator, resume from checkpoints, and retry within a bounded recovery loop instead of ending with code snippets or internal errors.
- Made subagents preserve paused, interrupted, incomplete, and budget-exhausted terminal states, with durable same-run checkpoint recovery that does not replay completed tools.

### Fixed

- Prevented failed, interrupted, or unverified artifacts from appearing as deliverable links or right-sidebar files.
- Added real pixel, PDF page-tree, and Office package validation before publication, including HTML gallery checks that require every requested image to be visible and decodable.
- Made multi-page PDF rendering transactional so a later invalid page rolls back the entire batch and a retry cannot leave duplicate files.
- Replaced internal model/tool failure text with safe progress summaries while preserving verified work for continuation.

## [0.11.16] - 2026-08-17

### Added

- Added owner-scoped media bundles for managed HTML artifacts so existing local images, audio, and video render in previews and export as a self-contained offline HTML file without exposing disk paths.

### Changed

- Unified Agent artifact routing across HTML, images, PDF, PowerPoint, Word, and Excel for create, in-place replacement, copy, conversion, and input-only intents.
- Required file tasks to complete through the matching tool and verified file delivery instead of returning code snippets or instructions that ask the user to open, edit, save, or convert files manually.

### Fixed

- Prevented existing image and document inputs from incorrectly triggering same-format generation tools such as `generate_image`.
- Preserved delivered files and clickable links when a later model step fails, and removed duplicate failure notices.
- Restored ordinary workspace HTML previews while keeping managed HTML media private, authenticated, sandboxed, and safely released after use.
- Made HTML media staging and rollback best-effort, added bounded offline expansion, and switched asset hashing to fixed-size chunks.

## [0.11.12] - 2026-08-16

### Added

- Added an in-app directory browser to chat, tasks, workspace permissions, and settings, replacing the blocking native folder picker.
- Added a configurable default output directory for generated HTML, image, PDF, PowerPoint, Word, and Excel files.

### Changed

- Made output placement follow the user's explicit path first, then the configured default directory, then the active project directory; edits keep the original file path.
- Made “Bypass all” skip file, directory, Shell, Git, and external-action approval prompts while keeping path validation and workspace safety checks.
- Kept long-running tool activity visible and preserved lightweight clickable file receipts without loading entire large files into model context.

### Fixed

- Prevented generated files from overwriting unrelated same-named files and preserved the first delivery path across revisions.
- Prevented artifact-generation tests from leaking HTML, DOCX, PPTX, and other sample files into the repository checkout.
- Removed stale system-picker and per-command-approval wording that contradicted the inline browser and active approval mode.

## [0.11.11] - 2026-08-15

### Fixed

- Preserved every prepared skill, including trusted inline definitions and quality contracts, across top-level, batched, and recursively nested Agent execution.
- Rejected model-supplied inline skill definitions during Agent delegation while keeping registered skills authoritative when identifiers overlap.

## [0.11.10] - 2026-08-15

### Changed

- Expanded the runtime quality layer across every existing built-in, imported, plugin, inline, Job, and nested-Agent skill with category-specific delivery and verification contracts while preserving each skill's specialist workflow and bundled resources.
- Updated every bundled cloud model preset to use exact-model context metadata and current provider model identifiers instead of provider-wide estimates.
- Simplified generated-file viewing to one right-side preview slot and made final delivery filenames real links that open in that slot on a normal click.

### Fixed

- Preserved selected skills through top-level and recursively nested Agent calls, including Job execution and explicit child overrides.
- Sent and retried a real turn cancellation request even when the initial `/api/turns/run` response is still pending.
- Kept intermediate execution files out of the delivery area and non-interactive while allowing only explicitly selected final deliverables to open.
- Prevented the onboarding reminder from covering the composer and send button.

## [0.11.9] - 2026-08-15

### Added

- Added an exact-model capability catalog with verified context windows, output limits, provenance, and conservative fallback for unknown model IDs.
- Added a runtime quality contract for every built-in, imported, seeded, and plugin skill so execution, inspection, repair, verification, and final-file delivery are enforced consistently.

### Changed

- Rebuilt tool execution rows as a stable single-open accordion with inline details, copy controls, live output, and clickable persisted-file links that open in the single right preview area.
- Made the skills library open on a compact 25-item featured set while retaining the complete deterministic catalog under All, including a clear built-in fallback when the server catalog is unavailable.
- Removed the ACCESS eyebrow and replaced the large connector capability legend with a compact, keyboard-accessible popover beside the filters.
- Removed provider-wide context-window assumptions and updated current Gemini and Moonshot model identifiers while preserving labeled legacy choices.

### Fixed

- Prevented execution details from changing height on hover, flashing under the pointer, or overlapping following steps.
- Prevented generated-file previews from mounting alongside another right workbench panel.

## [0.11.0] - 2026-08-13

### Added

- Live interleaved activity stream in chat that shows running tools, streamed
  output tails, and provider fallback notices as text instead of spinner-only
  status, while reasoning text stays compact and private.
- Provider failover and retry visibility through a new `model.failover` turn
  event, surfaced in the chat activity stream.
- Advisory repeat-call guard: consecutive identical tool calls (same tool and
  arguments) inject a gentle system reminder at thresholds 3/5/8 instead of
  letting the loop burn tokens silently.
- Request correlation ids (`X-Request-Id`, userId/sessionId/turnId/jobId) in
  structured server logs via an AsyncLocalStorage log context.

### Changed

- Simplified the model settings page into a compact status strip and focused
  the provider editor on service + API key + detected model count.
- Replaced the handwriting display font (Caveat/Kalam) across the UI with the
  standard semibold typeface for cleaner, more readable headings and buttons.
- Centralized job prompt blocks (artifact rules, code workflow, citation
  guidance, delayed follow-up) into a dedicated module.
- Split the tool-loop heuristics out of the monolithic runtime into a
  dedicated module and extracted provider-failover adapters into their own
  module.

## [0.10.24] - 2026-08-13

### Changed

- Made the chat composer visibly interactive with a persistent boundary,
  clearer placeholder treatment, and a stronger accessible focus state.
- Smoothed execution progress with automatic expansion for new running steps,
  stable animated rows, and batched live output updates.
- Moved approval actions to the right edge of inline permission prompts.

### Fixed

- Made persisted files in execution steps open in the existing preview pane
  only when the displayed path can be matched to the exact artifact.
- Preserved tool arguments across start events and flushed buffered output
  before completion, cancellation, pause, interruption, or failure states.

## [0.10.23] - 2026-08-13

### Changed

- Enabled application permissions and coding tools by default for new installs
  while preserving each user's explicit disabled settings and approval gates.
- Opened the chat workspace directly at startup and removed the retired 3D
  cover page together with its Three.js runtime dependencies.

### Fixed

- Kept write and command-execution tools available when a request asks to
  preserve source content while creating or modifying separate output files.
- Made short continuation messages inherit only the immediately preceding
  explicit execution request, including under concurrent turn processing.
- Preserved `write_file`, `bash_exec`, and `run_command` for long document
  workflows that require real file generation and verification.

## [0.10.22] - 2026-08-13

### Added

- Fed image-producing tool results back to vision-capable models and streamed
  live tool output into active chat turns.
- Added durable pre-mutation file snapshots, the `rewind_files` recovery tool,
  and managed background-process launch, inspection, and termination.
- Expanded lifecycle hooks with `pre_compact`, `subagent_stop`, `notification`,
  and permission events, plus structured argument matchers and
  `allow`/`deny`/`ask` decisions.

### Changed

- Applied hook-supplied pre-compaction prompts to semantic summaries, dispatched
  completion notifications, and combined permission decisions conservatively.

### Fixed

- Preserved the backward-compatible `tool_call_ready` activity shape while
  streaming richer tool progress.
- Cancelled pending approval records when interrupted work disconnects instead
  of leaving stale approval requests behind.

## [0.10.21] - 2026-08-13

### Added

- Added model-aware context-window profiles with catalog defaults, native
  Ollama metadata discovery, and per-provider overrides.

### Changed

- Routed each active model's context window through usage reporting,
  compaction, jobs, subagents, and tool loops instead of relying on one global
  default.

## [0.10.20] - 2026-08-13

### Added

- Added persistent multi-preview tabs for generated files and images, with
  per-tab close controls, keyboard navigation, overflow scrolling, stable
  deduplication, and predictable adjacent-tab handoff.

### Changed

- Adopted pi-inspired live steering at tool boundaries so newer user direction
  supersedes unstarted calls, including the first pending write or command,
  while preserving durable checkpoint, lease, and recovery semantics.

### Fixed

- Removed the retired browser-side tool catalog from context fallback so every
  configurable server tool remains represented without unknown-tool warnings.
- Made HTML and SVG preview helper scripts compatible with the preview CSP so
  switching or closing previews no longer emits blocked inline-script errors.
- Replaced React preview `unsafe-eval` execution with nonce-authorized compiled
  scripts while keeping user source inert until it enters the isolated sandbox.

## [0.10.19] - 2026-08-12

### Added

- Added first-class `run_command`, `patch_file`, `run_test`, `docker_exec`,
  `file_download`, and `git_write` tools, including real Python and Node.js
  execution, structured test results, atomic downloads, and complete Git write
  workflows.
- Added browser navigation, click, type, select, and key-press tools backed by
  the existing snapshot references for interactive E2E testing and debugging.

### Changed

- Enabled the complete coding-agent tool loop by default while preserving
  explicit user disables, directory grants, approval modes, and deployment
  locks.
- Made command execution durable across context compaction, task checkpoints,
  retries, cancellation, output truncation, directory authorization, and
  post-write verification.

### Security

- Isolated permissions for every public tool alias, required explicit approval
  for downloads and Git mutations, and prevented hidden legacy switches from
  silently granting write access.
- Added allowlisted credential injection by environment-variable name with
  permanent blocking of Gugo model/auth secrets, exact output redaction, and
  log minimization for credential-bearing commands.
- Hardened Docker command quoting and missing-runtime errors, download atomicity,
  process-tree termination, and approval-card secret handling.

## [0.10.18] - 2026-08-11

### Added

- Added path-based image inspection and transforms, FFmpeg-powered audio/video
  probing and editing, positioned PDF text extraction with CJK-safe transforms,
  and large-file archive workflows for ZIP plus RAR4/RAR5 listing/extraction.
- Added ZIP creation, archive previews, directory-aware batch renaming, exact
  duplicate manifests, and first-run workspace onboarding for file, Shell, and
  Git execution capabilities.

### Changed

- Strengthened the execution harness to call exposed `write_file`, `bash_exec`,
  `pdf_transform`, and related tools directly, recover from structured errors,
  and verify written outputs instead of returning copy-paste instructions.
- Long user messages now collapse into an accessible preview and can be expanded
  or folded again without hiding attachments or skill-command context.

### Fixed

- Prevented length-truncated tool calls from reaching approval or execution while
  preserving protocol pairing and retry checkpoints for safe regeneration.
- Hardened media parameter validation, PDF Unicode font embedding, archive path
  and expansion checks, atomic writes, cancellation rollback, and approval risk
  classification for destructive transforms.

## [0.10.17] - 2026-08-10

### Added

- Added ordered multi-API web search profiles with per-provider enable controls,
  presets, and automatic failover while keeping credentials server-side.

### Changed

- Reworked execution activity into a compact numbered timeline with structured
  progress and independently collapsible arguments and results.

### Fixed

- Generated file names now open directly in the right workbench, and every
  emitted artifact stays synchronized with the Related Files sidebar.

## [0.10.16] - 2026-08-10

### Fixed

- Restored `write_file`, `edit_file`, and `bash_exec` after read-write directory
  authorization, including across suspended background Job checkpoints.
- Bound Job directory resumes to the active verified grant so authorization
  continues the same task without repeated prompts or stale wait recovery.
- Preserved execution intent when a source PDF must remain unchanged while a
  filled copy and PNG previews are created and verified.

## [0.10.15] - 2026-08-10

### Added

- Added guarded local code execution for explicitly authorized read-write
  directories, including Python runtime discovery and real PDF/image workflows.
- Added managed chat attachments plus durable turn leases, checkpoints, recovery,
  steering, cancellation, and structured tool progress events.

### Changed

- Tool loops now repair safe truncated JSON, validate schemas, retry eligible
  read-only failures, schedule parallel reads, reflect on repeated failures, and
  require real execution and verification evidence before claiming completion.
- Chat activity now separates narrative, tool calls, results, and measured file
  progress while keeping send and stop on one primary composer button.

### Fixed

- Inline directory authorization now opens reliably and resumes the same turn
  automatically with the authorized read, write, listing, and execution tools.
- Hardened Windows absolute-path parsing, authorization propagation, turn replay,
  provider streaming compatibility, and final mutation-verification guards.

## [0.10.14] - 2026-08-08

### Added

- Added pinned conversations and six configurable web-search provider templates
  with connection testing and server-side secret handling.

### Changed

- Generated files are now linked directly in assistant narration, open in the
  right workbench, and suppress duplicate artifact cards below the response.
- Session snapshots now restore persisted artifacts so HTML, Office, and other
  supported files remain available after streaming completes or a chat reloads.

### Fixed

- Hardened HTML and Office preview routing while preserving the selected file
  across turn updates and session recovery.
- Stabilized desktop-pet dragging by ignoring synthetic stationary movement,
  preserving fixed transparent-window bounds, and releasing pointer capture.

## [0.10.13] - 2026-08-08

### Added

- Added branded Gugo icons to the desktop app, floating pet window, Windows
  executable, NSIS installer, and uninstaller.
- Added a complete Web release archive with the server, runtime data, locked
  production dependencies, setup instructions, and an isolated health check.

### Changed

- Release builds now wait for the full Linux/Windows test, coverage, dependency,
  secret-scan, and Docker CI matrix before publishing.
- GitHub Release publishing is now safely repeatable and replaces partial or
  stale assets when a workflow is rerun.
- Desktop updates accept stable releases only and explicitly disallow downgrades.

### Security

- Moved build-only Tailwind typography packages out of the production runtime
  dependency graph and pinned the fixed Nano ID release.
- Added a strict production audit gate for the two currently unpatched,
  unreachable `image-size` advisories inherited from PPTXGenJS; exceptions are
  version-locked and expire automatically on 2026-11-06.

## [0.10.12] - 2026-08-08

### Added

- Added unified right-pane previews for PDF, images and SVG, HTML, Markdown,
  text and code, JSON, XML, CSV/TSV, DOCX, XLS/XLSX/ODS, PPTX, audio, and
  video files, with an independent download fallback.

### Changed

- Generated artifacts now use readable semantic filenames with safe numeric
  suffixes for duplicates.
- Generated-file links in assistant narration now open the persisted file in
  the right pane without repeating the same file card below the response.
- Simplified conversation history rows to retain titles and time groups without
  per-session timestamps, message counts, or aggregate totals.

### Fixed

- Made the full composer surface focus the text input while preserving model,
  permission, attachment, voice, and send controls.
- Kept fast desktop-pet drags alive across Electron window movement and reliably
  released pointer input after dragging, hiding, or losing focus.
- Added inline, range-aware, Unicode-safe artifact responses and explicit MIME
  types for current browser and media formats.

## [0.10.11] - 2026-08-08

### Fixed

- Removed the remaining top-right affordance from skill cards while preserving
  full-card keyboard and pointer access to skill details.

## [0.10.10] - 2026-08-07

### Changed

- Redesigned the skill library with consistent semantic icons, concise localized
  descriptions, uniform cards, and a single unobtrusive details action.
- Reworked the left sidebar around a compact Codex-style hierarchy with a
  persistent collapsed mode, grouped conversation history, clearer active
  states, and improved session metadata.
- Refined generated-file references and the right workbench so file output keeps
  its narrative context and opens consistently without preview-state resets.

### Fixed

- Restored conversation history immediately on the first desktop launch.
- Improved session context-menu dismissal and keyboard interaction.
- Fixed desktop-pet pointer capture, dragging, interaction, and right-click close
  behavior outside the main application window.
- Reduced visual noise in reasoning metadata and ordinary HTML previews.

## [0.10.9] - 2026-08-07

### Added

- Added a compact transparent desktop-pet window that stays visible outside the
  main application, follows task status, supports custom pets, and reacts to
  clicks and dragging.
- Added inline generated-file references that open supported files directly in
  the right workbench.

### Changed

- Simplified and organized the built-in skill library while preserving user
  installed and user-created skills.
- Improved right-workbench resizing, scrolling, and artifact-specific actions.

### Fixed

- Fixed desktop-pet white space and animation flicker.
- Fixed session action menus remaining open after clicking elsewhere.
- Removed presentation-only export actions from ordinary HTML previews.

## [0.10.2] - 2026-08-06

### Fixed

- Made the connector skill frontmatter test accept both LF and CRLF checkouts on Windows runners.

## [0.10.1] - 2026-08-06

### Changed

- Renamed the public project, repository, package, and desktop update source to Gugo.
- Published the Windows desktop installer through the public GitHub Releases channel.

### Added

- Access 中心新增 4 个官方 MCP 一键安装预设（Fetch / Sequential Thinking / Memory / Playwright），与既有 Chrome DevTools 预设并列，装完即可在对话中调用其工具。
- 新增系统内置技能 `connector-operator`（连接器操作员），指导 Agent 正确使用 Notion / GitHub / Slack / Google Drive / QQ 邮箱 / 受管浏览器等已连接服务，含未连接引导与写操作确认纪律。
- 恢复被误删的 `skill-packs/guizang-ppt` 技能包（歸藏网页 PPT，含 316KB 规范快照），并放宽技能导入单文件/系统提示词上限（96KB → 512KB）使其可正常导入。
- Access 连接弹窗在 OAuth 未配置时展示可折叠的"如何启用 OAuth"引导（环境变量 + 配置文档链接）。

### Changed

- Removed trademark-bearing and customer-specific presentation templates from
  the open-source distribution.
- Added an actionable welcome state for new conversations.
- Added automated production dependency license checks and third-party notices.
- Consolidated release documentation and tagged GitHub Release automation.

## [0.10.0] - 2026-07-31

### Added

- Server-owned chat turns with recovery, approvals, cancellation, and artifacts.
- Provider, MCP, memory, job, subagent, connector, and workspace tool support.
- Local-first single-user mode with optional multi-user authentication.

[Unreleased]: https://github.com/lichangjiang932-ship-it/Gugo/compare/v0.10.24...HEAD
[0.10.24]: https://github.com/lichangjiang932-ship-it/Gugo/compare/v0.10.23...v0.10.24
[0.10.23]: https://github.com/lichangjiang932-ship-it/Gugo/compare/v0.10.22...v0.10.23
[0.10.22]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.22
[0.10.21]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.21
[0.10.20]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.20
[0.10.19]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.19
[0.10.18]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.18
[0.10.17]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.17
[0.10.16]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.16
[0.10.15]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.15
[0.10.14]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.14
[0.10.13]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.13
[0.10.12]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.12
[0.10.11]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.11
[0.10.10]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.10
[0.10.9]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.9
[0.10.2]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.2
[0.10.1]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.1
[0.10.0]: https://github.com/lichangjiang932-ship-it/Gugo/releases/tag/v0.10.0
