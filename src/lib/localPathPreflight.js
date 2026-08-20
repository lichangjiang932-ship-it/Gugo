import { sanitizeSuggestedDirectoryPath } from '../../shared/suggestedDirectoryPath.js'

const QUOTE_CHARS = /["'`\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f]/u
const TRAILING_PUNCTUATION = /[\uFF0C\u3002\uFF1B;\uFF01\uFF1F!?\u3001>\u300B\u300D\u300F]+$/u
const WINDOWS_DRIVE_PATH = /(?<![A-Za-z0-9])([A-Za-z]:[\\/][^\s"'`<>|?*\uFF08\uFF0C\u3002\uFF1B;\uFF01\uFF1F!\u3001\u300B\u300D\u300F]+)/gu
const WINDOWS_UNC_PATH = /\\\\[^\\/\s"'`<>|?*\uFF08]+[\\/][^\s"'`<>|?*\uFF08\uFF0C\u3002\uFF1B;\uFF01\uFF1F!\u3001\u300B\u300D\u300F]+/gu
const UNIX_PATH = /(?:^|[\s(\uFF08\u3010])((?:\/(?!\/)(?:Users|home|mnt|Volumes|opt|srv|var|tmp|workspace|root|data|etc))(?:\/[^\s"'`<>\uFF0C\u3002\uFF1B;\uFF01\uFF1F!\u3001\u300B\u300D\u300F]+)*)/gu
const ACCESS_INTENT = /\u8bfb\u53d6|\u9605\u8bfb|\u80fd\u8bfb|\u53ef\u8bfb|\u8bfb\u4e00\u4e0b|\u8bfb\u8fd9\u4e2a|\u8bbf\u95ee|\u89e3\u6790|\u5206\u6790|\u67e5\u770b|\u770b\u770b|\u6253\u5f00|\u68c0\u67e5|\u641c\u7d22|\u5217\u51fa|\u904d\u5386|\u9879\u76ee|\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|read|access|parse|analy[sz]e|inspect|open|search|list|project|file|folder|directory|local\s+path/i
const WRITE_INTENT = /\u4fee\u6539|\u5199\u5165|\u7f16\u8f91|\u521b\u5efa|\u65b0\u5efa|\u5220\u9664|\u79fb\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u4fdd\u5b58|\u8986\u76d6|update|write|edit|create|delete|remove|rename|move|save|overwrite/i

function cleanCandidate(value) {
  let result = String(value || '').trim().replace(TRAILING_PUNCTUATION, '').trim()
  const pairs = [['(', ')'], ['\uFF08', '\uFF09'], ['[', ']'], ['{', '}'], ['\u3010', '\u3011']]
  let changed = true
  while (changed && result) {
    changed = false
    for (const [open, close] of pairs) {
      if (!result.endsWith(close)) continue
      const opens = result.split(open).length - 1
      const closes = result.split(close).length - 1
      if (closes > opens) {
        result = result.slice(0, -close.length).trimEnd()
        changed = true
        break
      }
    }
  }
  while (result.length >= 2 && QUOTE_CHARS.test(result[0]) && QUOTE_CHARS.test(result.at(-1))) {
    result = result.slice(1, -1).trim()
  }
  return result
}

function isAbsoluteLocalPath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)
    || (/^\/(?!\/)/u.test(value) && !/^\/\/(?:https?:)?/iu.test(value))
}

function comparablePath(value) {
  const input = cleanCandidate(value)
  const windows = /^[A-Za-z]:[\\/]/u.test(input) || /^\\\\/u.test(input) || input.includes('\\')
  if (windows) {
    return { value: input.replace(/[\\/]+/gu, '\\').replace(/\\+$/u, '').toLowerCase(), separator: '\\' }
  }
  const normalized = input.replace(/\/{2,}/gu, '/').replace(/\/+$/u, '') || '/'
  return { value: normalized, separator: '/' }
}

function pathContains(rootPath, targetPath) {
  const root = comparablePath(rootPath)
  const target = comparablePath(targetPath)
  if (!root.value || !target.value || root.separator !== target.separator) return false
  if (root.value === target.value) return true
  const prefix = root.value.endsWith(root.separator) ? root.value : `${root.value}${root.separator}`
  return target.value.startsWith(prefix)
}

function normalizeResourceType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'file' || normalized === 'directory' ? normalized : 'unknown'
}

export function localPathResourceType(localPathAccess = {}, targetPath = '') {
  const target = comparablePath(targetPath).value
  if (!target) return 'unknown'
  const resource = (Array.isArray(localPathAccess?.resources) ? localPathAccess.resources : [])
    .find((item) => comparablePath(item?.path).value === target)
  return normalizeResourceType(resource?.resourceType)
}

export function resolveLocalPathResources(paths, status = {}) {
  return (Array.isArray(paths) ? paths : []).map((targetPath) => {
    const target = comparablePath(targetPath).value
    const grant = (Array.isArray(status?.grants) ? status.grants : []).find((item) => {
      if (!item?.path || item.available === false) return false
      if (normalizeResourceType(item.resourceType) === 'file') {
        return comparablePath(item.path).value === target
      }
      return pathContains(item.path, targetPath)
    })
    let resourceType = 'unknown'
    if (normalizeResourceType(grant?.resourceType) === 'file') resourceType = 'file'
    else if (normalizeResourceType(grant?.resourceType) === 'directory'
      && comparablePath(grant.path).value === target) resourceType = 'directory'
    else if (status?.workspace?.enabled && status.workspace.path
      && comparablePath(status.workspace.path).value === target) resourceType = 'directory'
    return {
      path: targetPath,
      resourceType,
      ...(grant?.accessMode ? { accessMode: grant.accessMode } : {}),
    }
  })
}

function parseProbePayload(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function optionalString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

// Users often type a file path followed immediately by a task/step number with
// no separator (for example "E:\fruit\gallery.html1.open the gallery page"). The path
// regex cannot tell where the file ends and will treat the whole text as the
// path, making authorization fail with "path does not exist". When the matched
// text contains a known file extension followed by more characters, truncate
// at the last known extension. Directory names containing dots that are not a
// known extension are left untouched.
const KNOWN_FILE_EXTENSION_RE = /\.(?:avif|bmp|cjs|css|csv|docx?|gif|html?|jpe?g|js|json|md|mjs|mp3|mp4|pdf|png|pptx?|py|sh|svg|tsx?|txt|webp|xlsx?|ya?ml|zip)/giu

function truncateAtKnownExtension(value) {
  const text = String(value || '')
  let last = null
  for (const match of text.matchAll(KNOWN_FILE_EXTENSION_RE)) last = match
  if (!last) return value
  return text.slice(0, last.index + last[0].length)
}

/**
 * Normalize the read_file probe contract for both the preflight evidence and
 * the optional local-file preview. PDF access is deliberately fail-closed:
 * reading bytes is not proof that text or page layout was extracted.
 */
export function resolveLocalPathReadEvidence(result = {}) {
  const payload = parseProbePayload(result.content)
  const path = optionalString(payload?.path, result.path)
  const outerMimeType = optionalString(result.mimeType).toLowerCase().split(';', 1)[0]
  const payloadMimeType = optionalString(payload?.mimeType).toLowerCase().split(';', 1)[0]
  const mimeType = [outerMimeType, payloadMimeType].includes('application/pdf')
    ? 'application/pdf'
    : optionalString(outerMimeType, payloadMimeType)
  const statuses = [result.extractionStatus, payload?.extractionStatus]
    .map((value) => optionalString(value).toLowerCase())
    .filter(Boolean)
  const extractionStatus = statuses.find((value) => value !== 'text') || statuses[0] || ''
  const visionFlags = [result.requiresVision, payload?.requiresVision]
    .filter((value) => typeof value === 'boolean')
  const requiresVision = visionFlags.includes(true)
    ? true
    : visionFlags.includes(false)
      ? false
      : null
  const content = typeof payload?.content === 'string' ? payload.content : ''
  const truncated = result.truncated === true || payload?.truncated === true
  const isPdf = mimeType === 'application/pdf'
    || /\.pdf$/iu.test(path)
    || /\.pdf$/iu.test(String(result.path || '').trim())
  const accessSucceeded = result.ok !== false && payload?.ok !== false
  const contentExtracted = accessSucceeded
    && typeof payload?.content === 'string'
    && (!isPdf || (
      extractionStatus === 'text'
      && requiresVision !== true
      && content.trim().length > 0
    ))

  return {
    payload,
    path,
    mimeType,
    extractionStatus,
    requiresVision,
    truncated,
    content,
    isPdf,
    accessSucceeded,
    contentExtracted,
  }
}

function readFailureSummary(read) {
  const code = optionalString(read.payload?.code, read.payload?.error?.code)
  const message = typeof read.payload?.error === 'string'
    ? read.payload.error
    : optionalString(read.payload?.error?.message)
  return [
    `Read failed${code ? ` (${code})` : ''}; no file content was accepted as evidence.`,
    ...(message ? [`Error: ${message.slice(0, 2000)}`] : []),
  ]
}

function describeProbeError(value, label) {
  const payload = typeof value === 'string' ? parseProbePayload(value) : value
  if (!payload || typeof payload !== 'object') return ''
  const code = optionalString(payload.code, payload.error?.code)
  const message = typeof payload.error === 'string'
    ? payload.error
    : optionalString(payload.error?.message)
  if (!code && !message) return ''
  return `${label}: ${[code, message].filter(Boolean).join(' - ')}`.slice(0, 2000)
}

function localProbeFailureSummary(result) {
  const payload = parseProbePayload(result.content)
  const summaries = [
    describeProbeError(payload, 'Probe'),
    describeProbeError(payload?.listDirectoryError, 'list_directory'),
    describeProbeError(payload?.readFileError, 'read_file'),
  ].filter(Boolean)
  return summaries.length > 0
    ? summaries
    : ['Probe failed; nested tool results did not provide verified file content.']
}

export function extractLocalAbsolutePaths(content) {
  const text = String(content || '')
  const found = []
  const add = (value) => {
    const candidate = cleanCandidate(sanitizeSuggestedDirectoryPath(truncateAtKnownExtension(value)))
    if (!candidate || !isAbsoluteLocalPath(candidate)) return
    const key = comparablePath(candidate).value
    if (!found.some((item) => comparablePath(item).value === key)) found.push(candidate)
  }
  const quoted = /["'`\u201c\u2018\u300c\u300e]([^\r\n"'`\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f]+)["'`\u201d\u2019\u300d\u300f]/gu
  const unquotedText = text.replace(quoted, (match, value) => {
    add(value)
    return ' '.repeat(match.length)
  })
  for (const match of unquotedText.matchAll(WINDOWS_DRIVE_PATH)) add(match[1])
  for (const match of unquotedText.matchAll(WINDOWS_UNC_PATH)) add(match[0])
  for (const match of unquotedText.matchAll(UNIX_PATH)) add(match[1])
  return found
}

export function buildLocalPathPreflight(content) {
  const paths = extractLocalAbsolutePaths(content)
  const text = String(content || '')
  if (!paths.length || (!ACCESS_INTENT.test(text) && !WRITE_INTENT.test(text))) {
    return { paths: [], accessMode: 'read_only' }
  }
  return { paths, accessMode: WRITE_INTENT.test(text) ? 'read_write' : 'read_only' }
}

export function isLocalPathAuthorized(targetPath, status, accessMode = 'read_only') {
  if (!targetPath || !status) return false
  if (status.bypassEnabled === true) return true
  if (status.allFilesEnabled) return true
  if (status.workspace?.enabled && status.workspace.path && pathContains(status.workspace.path, targetPath)) return true
  return (status.grants || []).some((grant) => {
    if (!grant?.path || grant.available === false) return false
    if (accessMode === 'read_write' && grant.accessMode !== 'read_write') return false
    if (grant.resourceType === 'file') return comparablePath(grant.path).value === comparablePath(targetPath).value
    return pathContains(grant.path, targetPath)
  })
}

export function buildLocalPathToolInstruction(paths, accessMode = 'read_only', resources = []) {
  if (!Array.isArray(paths) || !paths.length) return ''
  const localPathAccess = { resources }
  const filePaths = paths.filter((path) => localPathResourceType(localPathAccess, path) === 'file')
  return [
    '[LOCAL PATH ACCESS GRANTED] The user explicitly authorized these local paths:',
    ...paths.map((path) => {
      const resourceType = localPathResourceType(localPathAccess, path)
      return `- ${path}${resourceType === 'unknown' ? '' : ` (${resourceType})`}`
    }),
    `Access mode: ${accessMode === 'read_write' ? 'read and write' : 'read only'}.`,
    'Reuse these exact absolute paths. Never replace one with ".", its parent directory, or a guessed workspace path; those locations are not implicitly authorized.',
    'Use list_directory only for an authorized directory path. Use read_file directly with an exact authorized file path.',
    ...(filePaths.length > 0
      ? ['Paths marked "file" are exact-file grants. Do not call list_directory on those files or on their parent directories.']
      : []),
    ...(accessMode === 'read_write'
      ? [
          'For text changes, keep using the exact authorized path with write_file or edit_file.',
          ...(filePaths.length > 0
            ? [
                'For PDF, image, or other binary transformations, an exact-file grant cannot be used as a bash_exec working directory. Even for an in-place change, first call request_directory with access_mode "read_write" and the file parent directory as suggested_path; after that directory is granted, use bash_exec with an installed library/tool.',
                'An exact-file grant does not authorize new sibling outputs. Use that same parent-directory request before creating a PNG, PDF, script, or other adjacent file instead of claiming the capability is unavailable.',
              ]
            : [
                'For PDF, image, or other binary transformations, use bash_exec with an installed library/tool when available; do not treat text-only write_file/edit_file as binary editors.',
              ]),
        ]
      : []),
    'A directory listing is discovery evidence, not a project review. If the user asks to read, inspect, review, understand, or analyze a project/directory, read representative documentation, configuration, and entrypoint files before answering; never infer file contents from names alone.',
    'You must not claim that local files are inaccessible by design or ask the user to paste their contents. Report concrete tool errors truthfully.',
  ].join('\n')
}

export function resolveLocalPathToolNames(enabledNames, localPathAccess = {}) {
  const configured = Array.from(enabledNames || [])
  if (!Array.isArray(localPathAccess.paths) || localPathAccess.paths.length === 0) return configured
  const exactFilesOnly = localPathAccess.paths.every((path) => (
    localPathResourceType(localPathAccess, path) === 'file'
  ))
  const required = [
    ...(!exactFilesOnly ? ['list_directory'] : []),
    'read_file',
    ...(localPathAccess.accessMode === 'read_write' ? ['write_file', 'edit_file', 'bash_exec'] : []),
  ]
  return [...new Set([...configured, ...required])]
}

export function buildLocalPathEvidenceInstruction(results) {
  if (!Array.isArray(results) || results.length === 0) return ''
  const hasSuccessfulAccess = results.some((result) => (
    result?.tool === 'read_file'
      ? resolveLocalPathReadEvidence(result).accessSucceeded
      : result?.ok !== false
  ))
  const hasAccessibleUnextractedPdf = results.some((result) => (
    result?.tool === 'read_file'
      && resolveLocalPathReadEvidence(result).isPdf
      && resolveLocalPathReadEvidence(result).accessSucceeded
      && !resolveLocalPathReadEvidence(result).contentExtracted
  ))
  const evidenceLines = results.flatMap((result) => {
    const base = [
      `Path: ${result.path}`,
      `Tool: ${result.tool}`,
    ]
    if (result?.tool !== 'read_file') {
      if (result?.tool === 'local_path_probe' && result?.ok === false) {
        return [
          ...base,
          'Succeeded: no',
          ...localProbeFailureSummary(result),
        ]
      }
      return [
        ...base,
        `Succeeded: ${result.ok === false ? 'no' : 'yes'}`,
        String(result.content || '').slice(0, 24000),
      ]
    }

    const read = resolveLocalPathReadEvidence(result)
    const lines = [
      ...base,
      `Access succeeded: ${read.accessSucceeded ? 'yes' : 'no'}`,
    ]
    if (read.mimeType) lines.push(`MIME type: ${read.mimeType}`)
    if (read.extractionStatus) lines.push(`Extraction status: ${read.extractionStatus}`)
    if (read.requiresVision !== null) lines.push(`Requires vision: ${read.requiresVision ? 'yes' : 'no'}`)

    if (!read.isPdf) {
      lines.push(`Content extracted: ${read.contentExtracted ? 'yes' : 'no'}`)
      if (read.contentExtracted) lines.push('Extracted file text:', read.content.slice(0, 24000))
      else if (!read.accessSucceeded) lines.push(...readFailureSummary(read))
      else lines.push('The file path is accessible, but no readable text was returned.')
      return lines
    }

    lines.push(`Content extracted: ${read.contentExtracted ? 'yes' : 'no'}`)
    if (read.contentExtracted) {
      lines.push('Extracted PDF text:', read.content.slice(0, 24000))
    } else if (read.accessSucceeded) {
      lines.push('The PDF path and bytes are accessible, but readable text and page layout have not been verified. Use PDF- or vision-capable tooling before making claims about its contents.')
    } else {
      lines.push(...readFailureSummary(read))
    }
    return lines
  })
  return [
    hasSuccessfulAccess ? '[VERIFIED LOCAL FILESYSTEM ACCESS]' : '[LOCAL FILESYSTEM ACCESS PROBE]',
    hasSuccessfulAccess
      ? 'The application already performed real filesystem calls after user authorization. Filesystem-access status is authoritative. Treat only successful directory listings and file content explicitly marked "Content extracted: yes" as content evidence.'
      : 'The application attempted filesystem calls after user authorization, but none succeeded. Treat the errors below as probe results, not as verified file content.',
    ...evidenceLines,
    hasSuccessfulAccess
      ? 'Do not answer that local access is unavailable. Use the attached file tools for any follow-up inspection.'
      : 'Report the concrete access errors truthfully; do not claim that any file content was read.',
    ...(hasAccessibleUnextractedPdf
      ? ['A PDF marked "Content extracted: no" confirms only path/byte access; do not claim its text or layout was read.']
      : []),
    'For a project/directory review, the listing above is only a discovery step: call read_file for representative documentation, configuration, and entrypoint files before summarizing, and do not guess from filenames.',
  ].join('\n')
}
