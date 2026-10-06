import { getAuthToken } from './accountClient.js'

/** Files whose bytes are not lines a diff can show. */
const BINARY_EXTENSIONS = new Set([
  'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
  'zip', 'gz', 'tar', '7z', 'exe', 'dll', 'mp3', 'mp4', 'wav', 'webm', 'mov', 'woff', 'woff2', 'ttf', 'otf',
])

/** Lines read for the fallback view; a longer file says it was cut. */
export const CURRENT_CONTENT_LINE_LIMIT = 400

export function isBinaryChangePath(path) {
  const name = String(path || '').split(/[\\/]/u).pop() || ''
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  return BINARY_EXTENSIONS.has(extension)
}

/**
 * The file as it is now, through the same authorized read route the app's local
 * path probe uses (grant boundary, per-user tool switch). Used only where the
 * transcript holds no edit for a changed file — a script wrote it, or its
 * recorded arguments were cut for size — so the review can still show it.
 */
export async function readCurrentFileContent(path, { signal, fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = getAuthToken?.()
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetchImpl('/api/tools/fs/read', {
    method: 'POST',
    headers,
    body: JSON.stringify({ path, limit: CURRENT_CONTENT_LINE_LIMIT }),
    signal,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok === false || typeof data?.content !== 'string') {
    const error = new Error(String(data?.error || `HTTP ${response.status}`))
    error.code = data?.code || 'CURRENT_CONTENT_UNAVAILABLE'
    throw error
  }
  return {
    lines: data.content.replace(/\r\n/gu, '\n').split('\n'),
    totalLines: Number(data.totalLines) || 0,
  }
}
