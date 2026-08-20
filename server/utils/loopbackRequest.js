import { isIP } from 'node:net'

export function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase()
  if (isIP(address) === 4) return Number(address.split('.')[0]) === 127
  if (isIP(address) !== 6) return false
  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    if (normalized === '::1') return true
    const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    return mapped ? (Number.parseInt(mapped[1], 16) >> 8) === 127 : false
  } catch {
    return false
  }
}

export function isLoopbackRequest(req) {
  return isLoopbackAddress(req?.socket?.remoteAddress)
}
