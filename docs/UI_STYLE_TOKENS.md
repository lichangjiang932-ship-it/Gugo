# UI semantic tokens

Gugo host UI uses semantic color roles instead of coupling product state to the historical `ember` brand name.

## Roles

| Token | Purpose |
| --- | --- |
| `accent` | User-selectable control background, selection border, and non-text emphasis |
| `accent-contrast` | Text/icons rendered on `accent`; computed as black or white for WCAG AA contrast |
| `accent-ink` | Readable accent-colored text on `paper` surfaces; does not follow arbitrary user colors |
| `danger` | Errors, failed operations, and destructive state |
| `warning` | Incomplete delivery, approval waits, and caution state |
| `running` | Active execution, loading, and user-input waits |
| `success` | Completed and ready state |
| `focus` | Keyboard focus rings and focused control borders |

Use opacity modifiers for subtle surfaces, for example `border-danger/40 bg-danger/5`. Do not use `accent` to represent an error, running state, or success state.

## Accent contrast

`applyAccent()` sets `--color-accent-contrast-rgb` by comparing the selected accent against black and white. Controls with `bg-accent` must use `text-accent-contrast`, not a fixed `text-paper` or `text-white` foreground.

Authored artifacts are a separate design domain. `[data-artifact-surface]` maps accent roles back to neutral document tokens so a user theme cannot recolor generated output.

## Typography

Readable host UI metadata is at least 12px (`text-xs`). Bare 9–11px declarations are debt-controlled and may only shrink. A smaller value is permitted only for genuinely compact numeric badges and must carry `data-compact-numeric-badge` where covered by the chat readability gate.

Presentation export styles are authored output rather than host UI and are migrated separately.

The five `--type-*` roles use rem; ThemeWrapper changes the root size once. Do not multiply rem by `--font-size-scale` again. Legacy 9–11px equivalents remain debt-counted even after unit migration. Fixed `text-[Npx]` host JSX utilities are forbidden by the boundary test.

## Interaction preferences and shared primitives

- Density is independent from font size. `--space-row`, `--space-section`, and `--control-height` select compact/comfortable/loose spacing; current consumers are settings rows, shared controls and sidebar rows. Legacy surfaces join in audited batches.
- Host animation must route through `src/lib/hostMotion.js`. Both user disable and live OS reduced-motion changes stop ongoing host animation and select its final state. CSS remains governed by the effective root data attribute.
- `Segmented` owns single-choice geometry and keyboard movement. Use group/pressed for settings and tablist only for actual view tabs. File tabs with close controls are not segmented choices.
- Composer popovers use `PopoverPortal`, retain owner/context and close on external pointer or a non-composition Escape. Their anchor, portal node and focus rules must be checked together.
- `Spinner`, `ProgressDots` and `Skeleton` express loading, public ongoing activity and shape placeholders respectively; their owner supplies accessible localized status text.
- `ApprovalDecisionNotice` displays only correlated host approval receipts. Pending/submitting belongs to the request card; confirmed/failed/unknown belongs to the non-actionable receipt. Approval is not execution success, denial is not execution failure, and unknown outcomes must not offer blind resubmission. Its visibility is scoped to backend/user/session and retired for a new accepted task.
- Shared ActionButton size metadata owns vertical padding and density-aware minimum heights; do not retain conflicting fixed vertical utility padding. Neutral/outline variants preserve existing Gugo decision-control colors.
- Keep the current semantic focus color, existing global focus/active rules and low-specificity native disabled fallback. No brand recoloring or Surface/radius redesign is authorized in this phase.

Implementation status, measured scope and remaining work: [UI_REFINEMENT.md](UI_REFINEMENT.md).

## Compatibility

`ember` variables remain temporarily for presentation/export compatibility. New host UI utility classes must not use `text-ember`, `bg-ember`, `border-ember`, or related variants. `tests/codeDebt.test.js` enforces a zero-utility rule and non-increasing legacy/tiny-text baselines.

## Verification

- `tests/uiVisual.test.js` checks WCAG contrast across light, dark, and white themes.
- `tests/components/themeAccent.test.js` checks every selectable accent and extreme black/white inputs.
- `tests/codeDebt.test.js` prevents legacy naming and small-type regressions.
