const LOCAL_PATH_FIELDS = Object.freeze([
  'path',
  'fullPath',
  'sourcePath',
  'localPath',
  'outputPath',
])

function firstStableValue(...values) {
  return values.find((value) => (
    value !== undefined
      && value !== null
      && String(value).trim() !== ''
  ))
}

function decodePathText(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try { return decodeURIComponent(raw) } catch { return raw }
}

function unwrapPathText(value = '') {
  let raw = String(value || '').trim()
  if ((raw.startsWith('<') && raw.endsWith('>'))
    || (raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim()
  }
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      const host = url.hostname && url.hostname.toLowerCase() !== 'localhost'
        ? `//${url.hostname}`
        : ''
      raw = `${host}${url.pathname}`
    } catch {
      raw = raw.replace(/^file:\/\//i, '')
    }
  }
  return decodePathText(raw)
}

function normalizeSegments(tail, { caseInsensitive = false, separatorPattern = '/' } = {}) {
  const segments = []
  for (const rawSegment of tail.split(separatorPattern)) {
    if (!rawSegment || rawSegment === '.') continue
    if (rawSegment === '..') {
      segments.pop()
      continue
    }
    const segment = rawSegment.normalize('NFC')
    segments.push(caseInsensitive ? segment.toLowerCase() : segment)
  }
  return segments
}

/**
 * Build a canonical absolute-path identity for verified local-file UI state.
 * Windows drive and UNC paths are case-insensitive; POSIX paths retain case.
 * This is comparison-only and never grants filesystem access.
 */
export function normalizeVerifiedLocalFilePath(value = '') {
  const raw = unwrapPathText(value)
  if (!raw) return ''

  const windowsPath = /^\/[a-z]:[\\/]/i.test(raw) ? raw.slice(1) : raw
  const drive = windowsPath.match(/^([a-z]):[\\/](.*)$/i)
  const unc = windowsPath.match(/^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/)
  if (drive || unc) {
    const root = drive
      ? `${drive[1].toLowerCase()}:/`
      : `//${unc[1].normalize('NFC').toLowerCase()}/${unc[2].normalize('NFC').toLowerCase()}/`
    const tail = drive ? drive[2] : (unc[3] || '')
    const segments = normalizeSegments(tail, {
      caseInsensitive: true,
      separatorPattern: /[\\/]/,
    })
    return segments.length > 0 ? `${root}${segments.join('/')}` : root
  }

  if (!raw.startsWith('/')) return ''
  const segments = normalizeSegments(raw, { separatorPattern: '/' })
  return segments.length > 0 ? `/${segments.join('/')}` : '/'
}

export function verifiedLocalFileIdentity(...sources) {
  const pathValues = sources.flatMap((source) => (
    LOCAL_PATH_FIELDS.map((field) => source?.[field])
  ))
  for (const path of pathValues) {
    const normalizedPath = normalizeVerifiedLocalFilePath(path)
    if (normalizedPath) return `path:${normalizedPath}`
  }

  const receiptId = firstStableValue(...sources.map((source) => source?.id))
  if (receiptId !== undefined) return `receipt:${String(receiptId).trim()}`

  const url = firstStableValue(...sources.flatMap((source) => [
    source?.url,
    source?.downloadUrl,
    source?.uri,
  ]))
  return url === undefined ? '' : `url:${String(url).trim()}`
}
