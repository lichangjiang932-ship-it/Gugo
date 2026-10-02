/**
 * The three workbench tools and the keys that open them: the workspace's files,
 * the browser and the terminal. (Files took the side chat's place: a second chat
 * beside the conversation duplicated the composer, while the files the session
 * produced had no home outside the task card.)
 *
 * One definition, used by both the tool rail (for the tooltip and the hint) and
 * the key handler, so a shortcut shown on a button is always the shortcut that
 * actually works — a tooltip that promises a key nobody bound is worse than no
 * tooltip.
 *
 * Note on Ctrl+T: a real browser owns that combination for "new tab" and cannot
 * be overridden from the page, so it only reaches the app in the desktop shell.
 * The other two are free everywhere. This is the same reason the app's own
 * global shortcuts use Alt (see lib/shortcuts.js) rather than pretending every
 * Ctrl combination is available.
 */
export const WORKBENCH_TOOLS = Object.freeze([
  Object.freeze({ id: 'files', labelKey: 'workbench.workspaceFiles', ctrl: true, alt: true, key: 'f' }),
  Object.freeze({ id: 'browser', labelKey: 'workbench.browser', ctrl: true, alt: false, key: 't' }),
  Object.freeze({ id: 'terminal', labelKey: 'workbench.terminal', ctrl: true, alt: false, key: '\\' }),
])

export const WORKBENCH_TOOL_IDS = Object.freeze(WORKBENCH_TOOLS.map((tool) => tool.id))

function isMac(platform = globalThis.navigator?.platform || '') {
  return /Mac|iPhone|iPad/.test(platform)
}

/**
 * The keys as they are written on this machine. On macOS the app's own search
 * hint already writes ⌘ instead of Ctrl, so the tool hints follow it rather than
 * telling a Mac reader to press a key their keyboard does not have.
 */
export function shortcutLabelFor(tool, { platform } = {}) {
  if (!tool) return ''
  const parts = []
  if (isMac(platform)) {
    if (tool.ctrl) parts.push('⌘')
    if (tool.alt) parts.push('⌥')
    if (tool.shift) parts.push('⇧')
  } else {
    if (tool.ctrl) parts.push('Ctrl')
    if (tool.alt) parts.push('Alt')
    if (tool.shift) parts.push('Shift')
  }
  parts.push(tool.key === '\\' ? '\\' : tool.key.toUpperCase())
  // macOS writes shortcuts without separators (⌘⌥S); other platforms use "+".
  return parts.join(isMac(platform) ? '' : '+')
}

/**
 * Just the key itself, for the small hint printed under each rail button. The
 * modifier is left to the tooltip so the strip stays readable at 44px wide.
 */
export function shortcutKeyHint(tool) {
  if (!tool) return ''
  return tool.key === '\\' ? '\\' : tool.key.toUpperCase()
}

/**
 * Which tool, if any, this key event opens. Returns null for anything that is
 * not exactly one of the three combinations, so a stray Ctrl+T with a modifier
 * held is not mistaken for the tool shortcut.
 */
export function matchWorkbenchShortcut(event) {
  if (!event || typeof event.key !== 'string') return null
  if (event.metaKey || event.shiftKey) return null
  if (!event.ctrlKey) return null
  const key = event.key.toLowerCase()
  // An absent modifier is read as "not held": a synthetic or partially built
  // event leaves the flag undefined, and `undefined === false` would silently
  // stop every Ctrl-only tool from matching.
  const alt = Boolean(event.altKey)
  const tool = WORKBENCH_TOOLS.find((candidate) => candidate.key === key && candidate.alt === alt)
  return tool ? tool.id : null
}
