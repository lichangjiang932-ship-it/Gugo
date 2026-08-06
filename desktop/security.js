import { isIP } from 'node:net'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

export function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url : null
  } catch {
    return null
  }
}

export function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === 'localhost.') return true
  if (isIP(normalized) === 4) return Number(normalized.split('.')[0]) === 127
  return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1'
}

export function resolveDesktopDevUrl(value) {
  const url = parseHttpUrl(value)
  if (!url || !isLoopbackHostname(url.hostname)) return null
  return url.toString()
}

export function isTrustedNavigation(target, applicationOrigin) {
  const targetUrl = parseHttpUrl(target)
  const originUrl = parseHttpUrl(applicationOrigin)
  return Boolean(targetUrl && originUrl && targetUrl.origin === originUrl.origin)
}

export function isSafeExternalUrl(value) {
  const url = parseHttpUrl(value)
  return Boolean(url && !url.username && !url.password)
}
