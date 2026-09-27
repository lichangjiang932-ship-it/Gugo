/**
 * What the address bars accept.
 *
 * Both the workbench browser and the sidebar browser share this policy, so a URL
 * can never be acceptable in one panel and not the other. Only plain HTTP(S)
 * without embedded credentials is allowed: anything a browser would treat as a
 * different kind of target (file:, javascript:, data:, a UNC path, a local drive)
 * is refused rather than guessed at.
 */
export function isLocalWorkbenchPath(value) {
  return /^(?:file:|[a-z]:|[\\/]|\.{1,2}[\\/]|~[\\/])/i.test(String(value || '').trim())
}

export function normalizeBrowserUrl(value) {
  const input = String(value || '').trim()
  if (!input || input.includes('\\') || isLocalWorkbenchPath(input)) return ''
  if (Array.from(input).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return ''
  const explicitHttp = /^https?:\/\//i.test(input)
  const hostWithPort = /^(?:localhost|[a-z\d.-]+\.[a-z\d.-]+):\d+(?:[/?#]|$)/i.test(input)
  if (!explicitHttp && /^[a-z][a-z\d+.-]*:/i.test(input) && !hostWithPort) return ''
  try {
    const url = new URL(explicitHttp ? input : `https://${input}`)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch {
    return ''
  }
}
