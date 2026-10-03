/**
 * Escape sequences a shell emits for a real terminal.
 *
 * A command console that is not a terminal emulator has to remove them: a colour
 * or cursor sequence arriving in a `<pre>` shows up as literal `ESC[33m` noise
 * around the text the reader actually asked for. Removing them is display-only —
 * nothing here changes what was executed or what the agent sees.
 *
 * Covered: CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and the
 * two-character escapes (`ESC` plus one byte).
 */
// eslint-disable-next-line no-control-regex -- the control bytes are exactly what this matches
const ANSI_ESCAPE = /[\u001B\u009B](?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/gu

export function stripAnsiSequences(text) {
  const value = String(text ?? '')
  if (!value.includes('\u001B') && !value.includes('\u009B')) return value
  return value.replace(ANSI_ESCAPE, '')
}
