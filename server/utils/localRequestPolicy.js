// @ts-check
import { isIP } from 'node:net'

/** @typedef {Readonly<Record<string, unknown>>} RuntimeEnv */
/** @typedef {{headers?: {host?: string, origin?: string}, method?: string}} RequestSource */

/** @param {string | undefined} value */
function httpAuthority(value) {
  if (typeof value !== 'string' || !value || /[\s/\\?#@,]/u.test(value)) return null
  try {
    const url = new URL(`http://${value}`)
    return url.host ? url : null
  } catch { return null }
}

/** @param {string} hostname */
export function isLoopbackRequestHostname(hostname) {
  const value = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  return value === 'localhost' || value.endsWith('.localhost') || value === '::1'
    || (isIP(value) === 4 && value.split('.')[0] === '127')
}

/**
 * Local identity is available only through a loopback authority. Missing Origin
 * is supported for native desktop/CLI clients; opaque preview frames may read
 * resources but cannot bootstrap an identity or submit a mutation.
 *
 * @param {RequestSource} request
 * @param {RuntimeEnv} [env]
 * @returns {{code: string, message: string} | null}
 */
export function localRequestRejection(request, env = process.env) {
  const mode = String(env.AUTH_MODE || 'local').trim().toLowerCase()
  if (['multi_user', 'multi-user', 'multiuser'].includes(mode)) return null
  if (String(env.ALLOW_INSECURE_LOCAL_AUTH || '').trim() === '1') return null
  const authority = httpAuthority(request.headers?.host)
  if (!authority || !isLoopbackRequestHostname(authority.hostname)) {
    return { code: 'LOCAL_REQUEST_HOST_DENIED', message: 'Local requests require a loopback Host.' }
  }
  const origin = request.headers?.origin
  if (!origin) return null
  if (origin === 'null' && ['GET', 'HEAD'].includes(request.method || '')) return null
  try {
    const url = new URL(origin)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash
      && isLoopbackRequestHostname(url.hostname)) return null
  } catch { /* malformed origins are refused */ }
  return { code: 'LOCAL_REQUEST_ORIGIN_DENIED', message: 'Local mutations require a loopback origin.' }
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {() => unknown} next
 * @param {RuntimeEnv} [env]
 */
export function enforceLocalRequestBoundary(request, response, next, env = process.env) {
  const rejection = localRequestRejection(request, env)
  if (!rejection) return next()
  response.writeHead(403, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify({ ok: false, error: rejection }))
}
