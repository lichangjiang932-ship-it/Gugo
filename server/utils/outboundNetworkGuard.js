import dns from 'node:dns/promises'
import net from 'node:net'
import { Agent } from 'undici'

export { maskOutboundUrl } from './urlDisplay.js'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const METADATA_IPV4 = new Set(['100.100.100.200', '169.254.169.254'])
const METADATA_IPV6 = new Set(['fd00:ec2::254'])
const METADATA_HOST_RE = /^(?:metadata|metadata\.google\.internal)$/i

function outboundError(message, code) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

function ipv4Parts(ip) {
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null
}

function isPrivateV4(ip) {
  const parts = ipv4Parts(ip)
  if (!parts) return false
  const [first, second, third] = parts
  return first === 10 || first === 127 || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || first === 0 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    // IANA special-purpose ranges that are not globally reachable targets.
    || (first === 192 && second === 0 && (third === 0 || third === 2))
    || (first === 192 && second === 88 && third === 99)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
}

function mappedIpv4Address(ip) {
  let canonical
  try {
    canonical = new URL(`http://[${String(ip || '').replace(/^\[|\]$/g, '')}]/`)
      .hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
  } catch {
    return null
  }
  const match = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!match) return null
  const high = Number.parseInt(match[1], 16)
  const low = Number.parseInt(match[2], 16)
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}

function isPrivateV6(ip) {
  let lower = ip.toLowerCase()
  try {
    lower = new URL(`http://[${lower.replace(/^\[|\]$/g, '')}]/`)
      .hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
  } catch { /* net.isIPv6 already validates callers */ }
  if (lower === '::' || lower === '::1') return true
  if (/^fe[89a-f][0-9a-f]:/.test(lower) || /^f[cd][0-9a-f]{2}:/.test(lower) || /^ff[0-9a-f]{2}:/.test(lower)) return true
  if (/^100:(?:0:){0,3}:/.test(lower) || lower === '100::') return true
  if (/^64:ff9b:1:/.test(lower)) return true
  if (/^2001:(?:1[0-9a-f]|2[0-9a-f]):/.test(lower)) return true
  if (lower === '2001:2::' || /^2001:2:(?:0:|:)/.test(lower)) return true
  if (/^2001:db8:/.test(lower) || /^5f00:/.test(lower)) return true
  const mapped = mappedIpv4Address(lower)
  return !!(mapped && isPrivateV4(mapped))
}

function isLoopbackIp(ip) {
  if (net.isIPv4(ip)) return ipv4Parts(ip)?.[0] === 127
  if (!net.isIPv6(ip)) return false
  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  const mapped = mappedIpv4Address(lower)
  return !!(mapped && isLoopbackIp(mapped))
}

export function isUnsafeIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip)
  if (net.isIPv6(ip)) return isPrivateV6(ip)
  return true
}

function isAllowedLocalIp(ip) {
  if (net.isIPv4(ip)) {
    if (METADATA_IPV4.has(ip)) return false
    const parts = ipv4Parts(ip)
    if (!parts) return false
    const [first, second, third, fourth] = parts
    if (first === 127 || first === 10) return true
    if (first === 172 && second >= 16 && second <= 31) return true
    if (first === 192 && second === 168) return true
    if (first === 100 && second >= 64 && second <= 127) return true
    return first === 0 && second === 0 && third === 0 && fourth === 0
  }
  if (!net.isIPv6(ip)) return false
  const lower = ip.toLowerCase()
  if (METADATA_IPV6.has(lower)) return false
  if (lower === '::1') return true
  const mapped = mappedIpv4Address(lower)
  if (mapped) return isAllowedLocalIp(mapped)
  return /^f[cd][0-9a-f]{2}:/.test(lower)
}

function assertAddressAllowed(address, { allowLocal = false } = {}) {
  if (!isUnsafeIp(address)) return
  if (allowLocal === 'loopback' && isLoopbackIp(address)) return
  if (allowLocal === true && isAllowedLocalIp(address)) return
  const kind = METADATA_IPV4.has(address) || METADATA_IPV6.has(String(address).toLowerCase())
    ? 'cloud metadata (private)'
    : 'private, loopback, link-local, or reserved'
  throw outboundError(`Outbound target resolves to a forbidden ${kind} address`, 'OUTBOUND_ADDRESS_DENIED')
}

export async function resolvePublicHost(hostname, {
  lookup = dns.lookup,
  allowLocal = false,
  resolveDns = true,
} = {}) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '')
  if (net.isIP(host)) {
    assertAddressAllowed(host, { allowLocal })
    return { host, lockedIp: host }
  }
  if (!host) throw outboundError('Outbound target hostname is required', 'OUTBOUND_HOST_INVALID')
  if (!resolveDns) return { host, lockedIp: null }
  let records
  try { records = await lookup(host, { all: true, verbatim: true }) }
  catch { throw outboundError('Outbound target DNS resolution failed', 'OUTBOUND_DNS_FAILED') }
  if (!Array.isArray(records) || records.length === 0) {
    throw outboundError('Outbound target has no DNS records', 'OUTBOUND_DNS_EMPTY')
  }
  for (const record of records) assertAddressAllowed(record?.address, { allowLocal })
  return { host, lockedIp: records[0].address }
}

export async function assertSafeOutboundUrl(rawUrl, options = {}) {
  let target
  try { target = new URL(rawUrl) } catch { throw outboundError('url is invalid', 'OUTBOUND_URL_INVALID') }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw outboundError('Only http/https outbound URLs are supported', 'OUTBOUND_PROTOCOL_DENIED')
  }
  if (target.username || target.password) {
    throw outboundError('Outbound URL userinfo credentials are not allowed', 'OUTBOUND_CREDENTIALS_DENIED')
  }
  if (METADATA_HOST_RE.test(target.hostname)) {
    throw outboundError('Cloud metadata hostnames are not allowed', 'OUTBOUND_METADATA_DENIED')
  }
  const resolved = await resolvePublicHost(target.hostname, options)
  target.lockedIp = resolved.lockedIp
  return target
}

export function pinnedLookup(lockedIp) {
  const family = net.isIPv6(lockedIp) ? 6 : 4
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address: lockedIp, family }])
    else callback(null, lockedIp, family)
  }
}

function redirectLocation(response) {
  return response?.headers?.get?.('location') || response?.headers?.location || ''
}

function redirectedInit(init, status) {
  const method = String(init?.method || 'GET').toUpperCase()
  if (status !== 303 && !([301, 302].includes(status) && method === 'POST')) return init
  const headers = new Headers(init?.headers || {})
  headers.delete('content-length')
  headers.delete('content-type')
  return { ...init, method: 'GET', headers, body: undefined }
}

async function cancelResponseBody(response) {
  try { await response?.body?.cancel?.() } catch { /* best effort before redirect */ }
}

/** Validate and DNS-pin every physical request, including redirects. */
export async function fetchSafeOutbound(rawUrl, init = {}, {
  fetchImpl = globalThis.fetch,
  lookup = dns.lookup,
  allowLocal = false,
  resolveDns = true,
  maxRedirects = 5,
  allowCrossOriginRedirects = false,
  dispatcherFactory = (lockedIp) => new Agent({ connect: { lookup: pinnedLookup(lockedIp) } }),
} = {}) {
  let current = String(rawUrl || '')
  let currentInit = { ...init }
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const target = await assertSafeOutboundUrl(current, { lookup, allowLocal, resolveDns })
    const dispatcher = target.lockedIp && typeof dispatcherFactory === 'function'
      ? dispatcherFactory(target.lockedIp, target)
      : null
    let response
    try {
      response = await fetchImpl(target.toString(), {
        ...currentInit,
        redirect: 'manual',
        ...(dispatcher ? { dispatcher } : {}),
      })
    } finally {
      if (dispatcher?.close) void dispatcher.close().catch(() => {})
    }

    let location = ''
    if (REDIRECT_STATUSES.has(response?.status)) {
      try { location = redirectLocation(response) }
      catch {
        await cancelResponseBody(response)
        throw outboundError('Outbound redirect Location is invalid', 'OUTBOUND_REDIRECT_INVALID')
      }
    }
    if (!location) return response
    let next
    try {
      next = new URL(location, target)
    } catch {
      await cancelResponseBody(response)
      throw outboundError('Outbound redirect Location is invalid', 'OUTBOUND_REDIRECT_INVALID')
    }
    if (!['http:', 'https:'].includes(next.protocol)) {
      await cancelResponseBody(response)
      throw outboundError('Outbound redirect Location is invalid', 'OUTBOUND_REDIRECT_INVALID')
    }
    if (redirectCount >= maxRedirects) {
      await cancelResponseBody(response)
      throw outboundError('Outbound redirect limit exceeded', 'OUTBOUND_REDIRECT_LIMIT')
    }
    if (target.protocol === 'https:' && next.protocol !== 'https:') {
      await cancelResponseBody(response)
      throw outboundError('HTTPS outbound redirects cannot downgrade to HTTP', 'OUTBOUND_REDIRECT_DOWNGRADE')
    }
    if (!allowCrossOriginRedirects && next.origin !== target.origin) {
      await cancelResponseBody(response)
      throw outboundError('Cross-origin outbound redirects are not allowed', 'OUTBOUND_REDIRECT_CROSS_ORIGIN')
    }
    await cancelResponseBody(response)
    current = next.toString()
    currentInit = redirectedInit(currentInit, response.status)
  }
  throw outboundError('Outbound redirect limit exceeded', 'OUTBOUND_REDIRECT_LIMIT')
}
