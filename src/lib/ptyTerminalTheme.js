/**
 * xterm paints into a canvas, so it cannot be handed `var(--color-ink)` — it needs
 * numbers. Reading them back off the rendered surface keeps the shell on whichever
 * theme is active instead of freezing a palette that would drift from the tokens
 * the rest of the app uses.
 */

const CHANNEL_PATTERN = /^(?:rgba?|hsla?)\(([^)]*)\)$/i

function clampChannel(value) {
  if (!Number.isFinite(value)) return null
  return Math.min(Math.max(Math.round(value), 0), 255)
}

/** `rgb(31, 41, 55)`, `rgb(31 41 55 / 1)` and a bare `31 41 55` all mean the same. */
export function parseColorChannels(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const functional = text.match(CHANNEL_PATTERN)
  const body = functional ? functional[1] : text
  const parts = body.split(/[,\s/]+/).filter(Boolean)
  if (parts.length < 3) return null
  // A fully transparent colour is not a colour: an element with no background of
  // its own computes to rgba(0, 0, 0, 0), and reading that as black would paint the
  // terminal black on a light theme.
  if (parts.length > 3 && Number.parseFloat(parts[3]) === 0) return null
  const channels = parts.slice(0, 3).map((part) => clampChannel(Number.parseFloat(part)))
  if (channels.some((channel) => channel === null)) return null
  return { r: channels[0], g: channels[1], b: channels[2] }
}

export function toRgbString({ r, g, b }) {
  return `rgb(${r}, ${g}, ${b})`
}

/**
 * A theme, or nothing at all: if the surface has no resolvable colour (a detached
 * element, a style-less test render) xterm's own defaults are better than a
 * half-derived palette that would paint black on black.
 */
export function resolveTerminalTheme({ background, foreground, cursor } = {}) {
  const backgroundChannels = parseColorChannels(background)
  const foregroundChannels = parseColorChannels(foreground)
  if (!backgroundChannels || !foregroundChannels) return undefined
  const cursorChannels = parseColorChannels(cursor) || foregroundChannels
  return {
    background: toRgbString(backgroundChannels),
    foreground: toRgbString(foregroundChannels),
    cursor: toRgbString(cursorChannels),
    // Selection is the text colour at low opacity, so it reads on any surface the
    // user's theme picked without a second token to keep in sync.
    selectionBackground: `rgba(${foregroundChannels.r}, ${foregroundChannels.g}, ${foregroundChannels.b}, 0.28)`,
  }
}

/** The theme of a live element, read from what is actually painted. */
export function terminalThemeForElement(element, scope = typeof window === 'undefined' ? undefined : window) {
  if (!element || typeof scope?.getComputedStyle !== 'function') return undefined
  const styles = scope.getComputedStyle(element)
  return resolveTerminalTheme({
    background: styles.backgroundColor,
    foreground: styles.color,
    cursor: styles.getPropertyValue('--color-accent-rgb'),
  })
}

export const TERMINAL_FALLBACK_FONT_SIZE = 12
const MINIMUM_FONT_SIZE = 10

/**
 * The terminal should read like the panel it sits in, so the type comes from the
 * surface's own computed style rather than a stack written down a second time.
 */
export function terminalTypographyForElement(element, scope = typeof window === 'undefined' ? undefined : window) {
  const styles = typeof scope?.getComputedStyle === 'function' ? scope.getComputedStyle(element) : null
  const measured = Number.parseFloat(styles?.fontSize)
  return {
    fontFamily: styles?.fontFamily || 'monospace',
    fontSize: Number.isFinite(measured) && measured >= MINIMUM_FONT_SIZE
      ? measured
      : TERMINAL_FALLBACK_FONT_SIZE,
  }
}
