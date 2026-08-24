export function isManagedArtifactPreviewUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  try {
    const baseOrigin = globalThis.location?.origin
      || globalThis.window?.location?.origin
      || 'http://localhost'
    const parsed = new URL(raw, baseOrigin)
    return parsed.origin === baseOrigin && parsed.pathname.startsWith('/api/artifacts/')
  } catch {
    return false
  }
}

export function isLocalReceiptFileUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  try {
    const baseOrigin = globalThis.location?.origin
      || globalThis.window?.location?.origin
      || 'http://localhost'
    const parsed = new URL(raw, baseOrigin)
    return parsed.origin === baseOrigin
      && /^\/api\/local-files\/(?:verified|retained)\/[^/]+$/.test(parsed.pathname)
  } catch {
    return false
  }
}

export async function issueUsableHtmlPreviewSession({ createSession, revokeSession, signal }) {
  let previewUrl = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    previewUrl = await createSession({ signal })
    if (signal.aborted) {
      await revokeSession(previewUrl).catch(() => {})
      throw signal.reason || new DOMException('Aborted', 'AbortError')
    }
    try {
      await probeHtmlPreviewSession(previewUrl, { signal })
      return previewUrl
    } catch (cause) {
      await revokeSession(previewUrl).catch(() => {})
      previewUrl = ''
      if (signal.aborted || cause?.name === 'AbortError' || attempt === 1) throw cause
    }
  }
  return previewUrl
}

export function withPreviewRetry(url, attempt) {
  if (!attempt || !url || /^(?:data|blob):/i.test(url)) return url
  try {
    const baseOrigin = globalThis.location?.origin
      || globalThis.window?.location?.origin
      || 'http://localhost'
    const parsed = new URL(url, baseOrigin)
    parsed.searchParams.set('previewRetry', String(attempt))
    if (/^[a-z][a-z\d+.-]*:/i.test(url)) return parsed.href
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    const hashIndex = url.indexOf('#')
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
    return `${base}${base.includes('?') ? '&' : '?'}previewRetry=${attempt}${hash}`
  }
}
import { probeHtmlPreviewSession } from '../../../lib/jobClient.js'
