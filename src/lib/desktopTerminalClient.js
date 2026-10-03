/**
 * The desktop shell can host a real shell, one process in the main app rather than
 * a command the server runs on the reader's behalf. The web build has no such host
 * and keeps the command console it already had, so callers must ask rather than
 * assume — and the ask is a function so the answer is testable.
 */
const REQUIRED_METHODS = Object.freeze(['start', 'write', 'resize', 'kill', 'onData', 'onExit'])

export function getDesktopTerminalHost() {
  const host = globalThis.window?.gugoDesktop?.terminal
  if (!host) return null
  return REQUIRED_METHODS.every((name) => typeof host[name] === 'function') ? host : null
}

export function isDesktopTerminalAvailable() {
  return getDesktopTerminalHost() !== null
}
