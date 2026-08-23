/**
 * Return a URL that is safe to expose in status/diagnostic payloads.
 *
 * Kept separate from outboundNetworkGuard so read-only catalog helpers do not
 * load DNS, undici, or transport policy just to format a configured endpoint.
 */
export function maskOutboundUrl(rawUrl = '') {
  try {
    const target = new URL(String(rawUrl || ''))
    target.username = ''
    target.password = ''
    target.search = ''
    target.hash = ''
    const masked = target.toString()
    return target.pathname === '/' ? masked.replace(/\/$/, '') : masked
  } catch {
    return ''
  }
}
