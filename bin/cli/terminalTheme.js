/**
 * Zero-dependency ANSI styling and light Markdown rendering for the terminal CLI.
 *
 * The CLI currently prints plain text: there is no colour dependency and no escape
 * sequence anywhere under `bin/`. That is a deliberate constraint worth keeping — this
 * module adds readability without adding a package.
 *
 * Two hard rules, both enforced by tests:
 *
 *   1. **Disabled means byte-identical.** When colour is off (a pipe, CI, `NO_COLOR`) every
 *      function is the identity function: no SGR, no substitution, no re-wrapping. Logs and
 *      pipes always see exactly the raw string.
 *   2. **Colour is opt-out through the standard switches.** `NO_COLOR` (set and non-empty)
 *      disables it, `FORCE_COLOR` (set, non-empty, not `0`) enables it, otherwise it follows
 *      `stream.isTTY`.
 *
 * While colour is ON, decorative Markdown punctuation is consumed rather than echoed —
 * `**bold**` renders as bold text, not as asterisks — because that is what rendering
 * means. Markers that carry real structure in a terminal (list bullets, quote marks, fence
 * lines) are kept. Line count and line order are always preserved either way.
 */

const ESC = '\u001b['

/** SGR codes this module knows about. */
const CODES = Object.freeze({
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
})

export const STYLE_NAMES = Object.freeze(Object.keys(CODES).filter((name) => name !== 'reset'))

/**
 * Decide whether to emit colour.
 *
 * `NO_COLOR` wins over `FORCE_COLOR`: the convention is that an explicit request for no
 * colour is never overridden by an ambient force, and a non-TTY (pipe, CI log, test
 * harness) defaults to plain text.
 */
export function colorEnabled({ stream, env = process.env } = {}) {
  const noColor = env?.NO_COLOR
  if (typeof noColor === 'string' && noColor.length > 0) return false
  const force = env?.FORCE_COLOR
  if (typeof force === 'string' && force.length > 0) return force !== '0'
  if (typeof env?.FORCE_COLOR === 'number') return env.FORCE_COLOR !== 0
  return Boolean(stream?.isTTY)
}

/**
 * Build a styler. With `enabled` false every method is the identity function, so callers
 * never need to branch.
 */
export function createStyler(enabled) {
  const wrap = (text, names) => {
    const value = String(text ?? '')
    if (!enabled || value.length === 0) return value
    const codes = names.map((name) => CODES[name]).filter((code) => code !== undefined)
    if (codes.length === 0) return value
    return `${ESC}${codes.join(';')}m${value}${ESC}${CODES.reset}m`
  }
  const styler = { enabled: Boolean(enabled), style: (text, ...names) => wrap(text, names) }
  for (const name of STYLE_NAMES) {
    styler[name] = (text) => wrap(text, [name])
  }
  return Object.freeze(styler)
}

/**
 * Inline tokens, matched in a single left-to-right pass.
 *
 * The alternation does the protection for us: a code span is consumed whole, so a `**`
 * inside it is never seen by the bold alternative. That removes the need for placeholder
 * round-tripping (and the control characters such placeholders would require).
 */
const INLINE_TOKEN = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/gu

/** Style inline Markdown, consuming the decorative punctuation. */
export function renderInlineMarkdown(text, styler) {
  const value = String(text ?? '')
  if (!value || !styler?.enabled) return value
  return value.replace(INLINE_TOKEN, (_match, code, bold) => (
    code !== undefined ? styler.cyan(code) : styler.bold(bold)
  ))
}

/**
 * Render a Markdown-ish block of assistant or diagnostic text for a terminal.
 *
 * Deliberately conservative: fenced code blocks are dimmed as a whole, headings get
 * bold, list markers and quotes get a colour, and everything else goes through the
 * inline pass. Line count and line order are always preserved.
 */
export function renderMarkdown(text, styler) {
  const value = String(text ?? '')
  if (!value || !styler?.enabled) return value
  const lines = value.split('\n')
  const out = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence
      out.push(styler.dim(line))
      continue
    }
    if (inFence) {
      out.push(styler.dim(line))
      continue
    }
    const heading = /^(#{1,6})(\s+)(.*)$/u.exec(line)
    if (heading) {
      // The hashes are markup, not content: render the title, drop the marker, keep the line.
      out.push(styler.bold(renderInlineMarkdown(heading[3], styler)))
      continue
    }
    const bullet = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/u.exec(line)
    if (bullet) {
      out.push(`${bullet[1]}${styler.cyan(bullet[2])}${bullet[3]}${renderInlineMarkdown(bullet[4], styler)}`)
      continue
    }
    const quote = /^(\s*>+\s?)(.*)$/u.exec(line)
    if (quote) {
      out.push(`${styler.dim(quote[1])}${styler.dim(renderInlineMarkdown(quote[2], styler))}`)
      continue
    }
    out.push(renderInlineMarkdown(line, styler))
  }
  return out.join('\n')
}

/** Resolve a styler straight from a stream and environment. */
export function stylerForStream(stream, env = process.env) {
  return createStyler(colorEnabled({ stream, env }))
}
