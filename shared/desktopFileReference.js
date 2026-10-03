// Types a default application merely *displays or edits*. Anything whose default
// handler might instead execute it (scripts, shortcuts, installers, macro-enabled
// office files) stays out — open-file must never mean run-file.
const OPEN_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'rtf', 'odt', 'ods', 'odp', 'odf', 'epub', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'log', 'sql', 'tex',
  'zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'tgz',
  'html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv', 'wma',
])

export function desktopFileError(code) {
  return Object.assign(new Error(code), { code })
}

function hasControlCharacters(value) {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function opaqueId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !hasControlCharacters(value) && !/[/\\]/u.test(value) && !['.', '..'].includes(value)
}

export function normalizeDesktopFileReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw desktopFileError('DESKTOP_FILE_REFERENCE_INVALID')
  if (value.kind === 'artifact' && opaqueId(value.filename)) {
    return { kind: 'artifact', filename: value.filename }
  }
  if (['verified', 'retained'].includes(value.kind) && opaqueId(value.fileId) && opaqueId(value.turnId)
    && (!value.sessionId || opaqueId(value.sessionId))) {
    return {
      kind: value.kind, fileId: value.fileId, turnId: value.turnId,
      ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    }
  }
  throw desktopFileError('DESKTOP_FILE_REFERENCE_INVALID')
}

export function desktopFileReferenceFromUrl(value, origin) {
  try {
    const url = new URL(String(value || ''), origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(origin).origin
      || url.username || url.password) return null
    const receipt = url.pathname.match(/^\/api\/local-files\/(verified|retained)\/([^/]+)$/u)
    if (receipt) {
      if (url.searchParams.getAll('turnId').length !== 1 || url.searchParams.getAll('sessionId').length > 1) return null
      return normalizeDesktopFileReference({
        kind: receipt[1], fileId: decodeURIComponent(receipt[2]),
        turnId: url.searchParams.get('turnId'), sessionId: url.searchParams.get('sessionId'),
      })
    }
    const artifact = url.pathname.match(/^\/api\/artifacts\/([^/]+)$/u)
    return artifact ? normalizeDesktopFileReference({ kind: 'artifact', filename: decodeURIComponent(artifact[1]) }) : null
  } catch {
    return null
  }
}

export function desktopFileOpenPolicy(filename) {
  const value = String(filename || '')
  if (hasControlCharacters(value) || /[\u202a-\u202e\u2066-\u2069]/u.test(value) || /[ .]$/u.test(value)) return { allowed: false, confirm: false }
  const extension = value.match(/\.([a-z0-9]+)$/iu)?.[1]?.toLowerCase() || ''
  return { allowed: OPEN_EXTENSIONS.has(extension), confirm: ['html', 'htm', 'svg'].includes(extension) }
}
