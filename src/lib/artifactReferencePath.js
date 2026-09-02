function normalizedReferenceUrl(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw, 'http://artifact.local')
    return decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase()
  } catch {
    try { return decodeURIComponent(raw.split(/[?#]/)[0]).replace(/\/+$/, '').toLowerCase() } catch { return raw.toLowerCase() }
  }
}

export function artifactReferenceMatchesHref(reference, href) {
  if (!reference || !href) return false
  const target = normalizedReferenceUrl(href)
  const artifactUrl = normalizedReferenceUrl(reference.url)
  if (artifactUrl) return Boolean(target && target === artifactUrl)
  const filename = String(reference.filename || reference.title || '').trim().toLowerCase()
  if (!filename) return false
  const targetName = target.split('/').pop() || ''
  return targetName === filename || target.endsWith(`/${filename}`)
}

export function findArtifactReferenceByHref(references = [], href = '') {
  return references.find((reference) => artifactReferenceMatchesHref(reference, href)) || null
}

export const ARTIFACT_PATH_FIELDS = Object.freeze([
  'path',
  'fullPath',
  'sourcePath',
  'outputPath',
  'localPath',
])

export function decodedPathText(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try { return decodeURIComponent(raw) } catch { return raw }
}

function unwrappedPathText(value = '') {
  let raw = decodedPathText(value)
  if ((raw.startsWith('<') && raw.endsWith('>'))
    || (raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim()
  }
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      const host = url.hostname && url.hostname.toLowerCase() !== 'localhost' ? `//${url.hostname}` : ''
      raw = `${host}${decodeURIComponent(url.pathname)}`
    } catch {
      raw = raw.replace(/^file:\/\//i, '')
    }
  }
  return raw.replaceAll('\\', '/')
}

/**
 * Normalize a Windows absolute path for comparison only. This never grants
 * filesystem access; it is used to resolve prose back to an already persisted
 * artifact URL.
 */
export function normalizeArtifactLocalPath(value = '') {
  let raw = unwrappedPathText(value)
  if (/^\/[a-z]:\//i.test(raw)) raw = raw.slice(1)
  const drive = raw.match(/^([a-z]):\/(.*)$/i)
  const unc = raw.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/)
  if (!drive && !unc) return ''

  const root = drive ? `${drive[1].toLowerCase()}:/` : `//${unc[1].toLowerCase()}/${unc[2].toLowerCase()}/`
  const tail = drive ? drive[2] : (unc[3] || '')
  const segments = []
  for (const segment of tail.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment.normalize('NFC').toLowerCase())
  }
  return `${root}${segments.join('/')}`.replace(/\/$/, segments.length > 0 ? '' : '/')
}

function normalizedArtifactFilenameValue(value = '') {
  const raw = decodedPathText(value)
  if (!raw) return ''
  const path = normalizeArtifactLocalPath(raw)
  const filename = path ? path.split('/').pop() : raw.split(/[\\/]/).pop()
  return String(filename || '').normalize('NFC').trim().toLowerCase()
}

export function artifactFilenameAliases(reference = {}) {
  const filename = decodedPathText(reference?.filename || '')
  const title = decodedPathText(reference?.title || '')
  const values = filename ? [filename] : [title]
  // Local artifacts retain the original source basename in `title` when the
  // artifact store adds a collision suffix (report.pdf -> report-2.pdf).
  // Semantic titles such as "Quarterly report" are intentionally excluded.
  if (filename && title && /\.[a-z0-9]{1,12}$/i.test(title.split(/[\\/]/).pop() || '')) values.push(title)
  const aliases = []
  const seen = new Set()
  for (const value of values) {
    const normalized = normalizedArtifactFilenameValue(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    aliases.push({ normalized, value: String(value).split(/[\\/]/).pop() || String(value) })
  }
  return aliases
}

export function uniqueArtifactReference(references = []) {
  const unique = []
  const keys = new Set()
  for (const reference of references) {
    const key = String(reference?.id || reference?.url || '')
    if (key ? keys.has(key) : unique.includes(reference)) continue
    if (key) keys.add(key)
    unique.push(reference)
  }
  return unique.length === 1 ? unique[0] : null
}

export function findArtifactReferenceByFilename(references = [], filename = '') {
  const normalized = decodedPathText(filename).normalize('NFC').trim().toLowerCase()
  if (!normalized || normalized.includes('/') || normalized.includes('\\')) return null
  return uniqueArtifactReference(references.filter((reference) => (
    reference?.url && artifactFilenameAliases(reference).some((alias) => alias.normalized === normalized)
  )))
}

/**
 * Resolve an absolute Windows path only against a registered, exact source or
 * delivery path. A pathless managed artifact must never impersonate a local
 * path merely because its filename happens to match.
 */
export function findArtifactReferenceByLocalPath(references = [], value = '') {
  const target = normalizeArtifactLocalPath(value)
  if (!target || !Array.isArray(references)) return null
  const registered = references.filter((reference) => reference?.url)
  const exactMatches = registered.filter((reference) => ARTIFACT_PATH_FIELDS.some((field) => (
    normalizeArtifactLocalPath(reference?.[field]) === target
  )))
  const exact = uniqueArtifactReference(exactMatches)
  return exact || null
}

export function localFileHrefMatchesReference(href, reference) {
  const raw = String(href || '').trim()
  const aliases = artifactFilenameAliases(reference)
  if (!raw || aliases.length === 0) return false
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { /* compare the original href */ }
  const localPath = /^(?:file:\/\/|[a-z]:[\\/]|\.\.?[\\/])/i.test(decoded)
  if (!localPath) return false
  const targetName = normalizedArtifactFilenameValue(decoded.replace(/[?#].*$/, '').split(/[\\/]/).pop() || '')
  return aliases.some((alias) => alias.normalized === targetName)
}

export function sameArtifactReference(left, right) {
  if (!left || !right) return false
  if (left === right) return true
  return ['identity', 'id', 'url'].some((key) => (
    left[key] && right[key] && String(left[key]) === String(right[key])
  ))
}

function referenceForInlineHref(references, label, href) {
  const direct = findArtifactReferenceByHref(references, href)
    || findArtifactReferenceByLocalPath(references, href)
  if (direct) return direct
  if (normalizeArtifactLocalPath(href)) return null
  const normalizedLabel = String(label || '').normalize('NFC').trim().toLowerCase()
  if (!normalizedLabel) return null
  return uniqueArtifactReference(references.filter((reference) => (
    reference?.url
      && artifactFilenameAliases(reference).some((alias) => alias.normalized === normalizedLabel)
      && localFileHrefMatchesReference(href, reference)
  )))
}

export function artifactHasInlineLink(content = '', artifact = {}, references = [artifact]) {
  const markdown = String(content || '')
  const candidates = Array.isArray(references) && references.length > 0 ? references : [artifact]
  const links = /\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[\x22\x27][^\x22\x27]*[\x22\x27])?\s*\)|<((?:https?:\/\/|\/)[^>]+)>/g
  let match
  while ((match = links.exec(markdown)) !== null) {
    const href = match[2] || match[3] || match[4] || ''
    const reference = referenceForInlineHref(candidates, match[1], href)
    if (sameArtifactReference(reference, artifact)) return true
  }
  return false
}
