import { JSDOM, VirtualConsole } from 'jsdom'

export const HTML_PREVIEW_REMOTE_IMAGE_ORIGINS_ENV = 'HTML_PREVIEW_REMOTE_IMAGE_ORIGINS'
const MAX_REMOTE_IMAGE_ORIGINS = 32
const MASKED_IMAGE_URL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
const REMOTE_URL_PATTERN = /^(?:https?:)?\/\//i
const IMAGE_ATTRIBUTES = Object.freeze([
  ['img[src]', 'src'],
  ['input[type="image"][src]', 'src'],
  ['video[poster]', 'poster'],
  ['svg image[href]', 'href'],
  ['svg image[xlink\\:href]', 'xlink:href'],
  ['link[rel~="icon"][href]', 'href'],
  ['link[rel~="apple-touch-icon"][href]', 'href'],
  ['link[rel~="mask-icon"][href]', 'href'],
])

function configuredValue(envOrValue) {
  if (typeof envOrValue === 'string') return envOrValue
  return String(envOrValue?.[HTML_PREVIEW_REMOTE_IMAGE_ORIGINS_ENV] || '')
}

/** Parse a bounded list of exact HTTPS origins. Invalid entries fail closed. */
export function htmlPreviewRemoteImageOrigins(envOrValue = process.env) {
  const origins = []
  const seen = new Set()
  for (const candidate of configuredValue(envOrValue).split(/[\s,]+/)) {
    const raw = candidate.trim()
    if (!raw || raw.includes('*')) continue
    try {
      const parsed = new URL(raw)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.pathname !== '/' || parsed.search || parsed.hash) continue
      if (seen.has(parsed.origin)) continue
      seen.add(parsed.origin)
      origins.push(parsed.origin)
      if (origins.length >= MAX_REMOTE_IMAGE_ORIGINS) break
    } catch {
      // Invalid configuration never widens the browser policy.
    }
  }
  return origins
}

export function isAllowedHtmlPreviewRemoteImage(value, origins = htmlPreviewRemoteImageOrigins()) {
  const raw = String(value || '').trim()
  if (!raw || !REMOTE_URL_PATTERN.test(raw)) return false
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' && new Set(origins).has(parsed.origin)
  } catch {
    return false
  }
}

function maskAttribute(element, attribute, origins) {
  const value = element.getAttribute(attribute)
  if (isAllowedHtmlPreviewRemoteImage(value, origins)) element.setAttribute(attribute, MASKED_IMAGE_URL)
}

function maskSrcset(element, origins) {
  const value = String(element.getAttribute('srcset') || '')
  if (!value) return
  const masked = value.split(',').map((candidate) => {
    const trimmed = candidate.trim()
    const [url, ...descriptor] = trimmed.split(/\s+/)
    if (!isAllowedHtmlPreviewRemoteImage(url, origins)) return candidate
    return [MASKED_IMAGE_URL, ...descriptor].join(' ')
  }).join(',')
  element.setAttribute('srcset', masked)
}

/**
 * Produce validation-only markup with explicitly trusted image references
 * masked. All other network URLs remain visible to the caller's deny rules.
 */
export function maskAllowedHtmlPreviewRemoteImages(source, origins = htmlPreviewRemoteImageOrigins()) {
  if (!Array.isArray(origins) || origins.length === 0) return String(source || '')
  let dom
  try {
    dom = new JSDOM(String(source || ''), { virtualConsole: new VirtualConsole() })
    const { document } = dom.window
    for (const [selector, attribute] of IMAGE_ATTRIBUTES) {
      for (const element of document.querySelectorAll(selector)) maskAttribute(element, attribute, origins)
    }
    for (const element of document.querySelectorAll('img[srcset], picture source[srcset]')) {
      maskSrcset(element, origins)
    }
    return dom.serialize()
  } catch {
    return String(source || '')
  } finally {
    dom?.window?.close()
  }
}
