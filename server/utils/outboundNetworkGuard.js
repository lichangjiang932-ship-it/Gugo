import dns from 'node:dns/promises'
import net from 'node:net'

function isPrivateV4(ip) {
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return false
  const first = Number(match[1])
  const second = Number(match[2])
  return first === 10 || first === 127 || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168) || first === 0 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (/^fe[89ab][0-9a-f]:/.test(lower) || /^f[cd][0-9a-f]{2}:/.test(lower) || /^ff[0-9a-f]{2}:/.test(lower)) return true
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return !!(mapped && isPrivateV4(mapped[1]))
}

export function isUnsafeIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip)
  if (net.isIPv6(ip)) return isPrivateV6(ip)
  return true
}

export async function resolvePublicHost(hostname, { lookup = dns.lookup } = {}) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '')
  if (net.isIP(host)) {
    if (isUnsafeIp(host)) throw new Error('Outbound target resolves to a private, loopback, or link-local address')
    return { host, lockedIp: host }
  }
  let records
  try { records = await lookup(host, { all: true, verbatim: true }) }
  catch { throw new Error('Outbound target DNS resolution failed') }
  if (!Array.isArray(records) || records.length === 0) throw new Error('Outbound target has no DNS records')
  for (const record of records) {
    if (isUnsafeIp(record?.address)) throw new Error(`Outbound target resolves to a private address: ${record?.address || 'unknown'}`)
  }
  return { host, lockedIp: records[0].address }
}

export async function assertSafeOutboundUrl(rawUrl, options = {}) {
  let target
  try { target = new URL(rawUrl) } catch { throw new Error('url is invalid') }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only http/https outbound URLs are supported')
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
