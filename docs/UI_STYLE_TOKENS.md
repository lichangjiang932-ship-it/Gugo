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

## Compatibility

`ember` variables remain temporarily for presentation/export compatibility. New host UI utility classes must not use `text-ember`, `bg-ember`, `border-ember`, or related variants. `tests/codeDebt.test.js` enforces a zero-utility rule and non-increasing legacy/tiny-text baselines.

## Verification

- `tests/uiVisual.test.js` checks WCAG contrast across light, dark, and white themes.
- `tests/components/themeAccent.test.js` checks every selectable accent and extreme black/white inputs.
- `tests/codeDebt.test.js` prevents legacy naming and small-type regressions.
