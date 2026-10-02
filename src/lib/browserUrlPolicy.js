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

/** Loopback and private-network hosts: where dev servers live, and they speak http. */
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[a-z\d-]+\.local)(?::\d+)?(?:[/?#]|$)/i

export const BROWSER_SEARCH_URL = 'https://www.bing.com/search?q='

/**
 * What typing into the address bar means, the way a browser reads it:
 *   · a URL — kept, or given a scheme: https for the web, http for a local dev
 *     server (`localhost:5173` almost never serves TLS, so https there just
 *     fails to connect);
 *   · anything that cannot be a host — words, a question — is a web search.
 * The strict policy above still decides what is a URL, so a refused target
 * (file:, javascript:, a credential URL, a local path) is never searched for
 * either: it stays an error, and nothing about it leaves the machine.
 */
export function resolveBrowserInput(value) {
  const input = String(value || '').trim()
  if (!input) return { kind: 'empty', url: '' }
  if (isLocalWorkbenchPath(input) || input.includes('\\')) return { kind: 'refused', url: '' }
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^https?:\/\//i.test(input)
    && !/^(?:localhost|[a-z\d.-]+):\d+(?:[/?#]|$)/i.test(input)) return { kind: 'refused', url: '' }
  const looksLikeHost = !/\s/.test(input) && (/^https?:\/\//i.test(input) || /[.:]/.test(input) || /^localhost(?:[/?#]|$)/i.test(input))
  if (looksLikeHost) {
    const local = !/^https?:\/\//i.test(input) && LOCAL_HOST.test(input)
    const url = normalizeBrowserUrl(local ? `http://${input}` : input)
    return url ? { kind: 'url', url } : { kind: 'refused', url: '' }
  }
  if (Array.from(input).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return { kind: 'refused', url: '' }
  }
  return { kind: 'search', url: `${BROWSER_SEARCH_URL}${encodeURIComponent(input)}` }
}
