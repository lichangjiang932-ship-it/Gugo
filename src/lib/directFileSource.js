import { getAuthToken } from './accountClient.js'
import { classifyDirectFile, directFileExtension } from './directFilePreview.js'

const SOURCE_KINDS = new Set(['html', 'markdown', 'json', 'xml', 'code', 'text', 'csv'])
const SOURCE_BYTE_LIMIT = 4 * 1024 * 1024

export function canViewDirectFileSource(file) {
  return SOURCE_KINDS.has(classifyDirectFile(file)) || directFileExtension(file) === 'svg'
}

function sourceRequest(url) {
  const baseOrigin = globalThis.location?.origin || globalThis.window?.location?.origin || 'http://localhost'
  const parsed = new URL(url, baseOrigin)
  if (['blob:', 'data:'].includes(parsed.protocol)) return { url: parsed.href, headers: {} }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw Object.assign(new Error('Invalid source preview URL'), { code: 'SOURCE_PREVIEW_DENIED' })
  }
  const sameOrigin = parsed.origin === baseOrigin
  const headers = {}
  if (sameOrigin) {
    const token = getAuthToken()
    if (token) headers.Authorization = `Bearer ${token}`
    parsed.searchParams.delete('token')
    // Source is fetched as text, never navigated to or executed. Avoid putting
    // the account token in a URL; local HTML previews reject that combination.
    parsed.searchParams.set('preview', '1')
  }
  return { url: sameOrigin ? `${parsed.pathname}${parsed.search}` : parsed.href, headers }
}

function sourceTooLarge() {
  return Object.assign(new Error('File exceeds the source preview limit'), { code: 'SOURCE_PREVIEW_TOO_LARGE' })
}

async function readBoundedSource(response) {
  if (Number(response.headers?.get?.('content-length')) > SOURCE_BYTE_LIMIT) {
    await response.body?.cancel?.()
    throw sourceTooLarge()
  }
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > SOURCE_BYTE_LIMIT) throw sourceTooLarge()
    return new TextDecoder().decode(buffer)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > SOURCE_BYTE_LIMIT) {
        await reader.cancel()
        throw sourceTooLarge()
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

export async function loadDirectFileSource({ file, url, signal, fetchImpl = fetch }) {
  if (!canViewDirectFileSource(file)) {
    throw Object.assign(new Error('Source preview is unavailable for this file type'), { code: 'SOURCE_PREVIEW_UNSUPPORTED' })
  }
  const request = sourceRequest(url)
  const response = await fetchImpl(request.url, {
    headers: request.headers, credentials: 'same-origin', cache: 'no-store', signal,
  })
  if (!response.ok) {
    throw Object.assign(new Error(`File source request failed (${response.status})`), {
      code: response.status === 401 || response.status === 403 ? 'SOURCE_PREVIEW_DENIED'
        : response.status === 404 ? 'SOURCE_PREVIEW_MISSING' : 'SOURCE_PREVIEW_FAILED',
    })
  }
  return readBoundedSource(response)
}
