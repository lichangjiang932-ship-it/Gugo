const QUOTE_CHARS = /["'`\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f]/u
const TRAILING_PUNCTUATION = /[\uFF0C\u3002\uFF1B;\uFF01\uFF1F!?\u3001)\uFF09\]}>\u3011\u300B\u300D\u300F]+$/u
const WINDOWS_DRIVE_PATH = /(?<![A-Za-z0-9])([A-Za-z]:[\\/][^\s"'`<>|?*\uFF0C\u3002\uFF1B;\uFF01\uFF1F!\u3001)\uFF09\]}>\u3011\u300B\u300D\u300F]+)/gu
const WINDOWS_UNC_PATH = /\\\\[^\\/\s"'`<>|?*]+[\\/][^\s"'`<>|?*\uFF0C\u3002\uFF1B;\uFF01\uFF1F!\u3001)\uFF09\]}>\u3011\u300B\u300D\u300F]+/gu
const UNIX_PATH = /(?:^|[\s(\uFF08\u3010])((?:\/(?!\/)(?:Users|home|mnt|Volumes|opt|srv|var|tmp|workspace|root|data|etc))(?:\/[^\s"'`<>\uFF0C\u3002\uFF1B;\uFF01\uFF1F!\u3001)\uFF09\]}>\u3011\u300B\u300D\u300F]+)*)/gu
const ACCESS_INTENT = /\u8bfb\u53d6|\u9605\u8bfb|\u80fd\u8bfb|\u53ef\u8bfb|\u8bfb\u4e00\u4e0b|\u8bfb\u8fd9\u4e2a|\u8bbf\u95ee|\u89e3\u6790|\u5206\u6790|\u67e5\u770b|\u770b\u770b|\u6253\u5f00|\u68c0\u67e5|\u641c\u7d22|\u5217\u51fa|\u904d\u5386|\u9879\u76ee|\u6587\u4ef6|\u6587\u4ef6\u5939|\u76ee\u5f55|read|access|parse|analy[sz]e|inspect|open|search|list|project|file|folder|directory|local\s+path/i
const WRITE_INTENT = /\u4fee\u6539|\u5199\u5165|\u7f16\u8f91|\u521b\u5efa|\u65b0\u5efa|\u5220\u9664|\u79fb\u9664|\u91cd\u547d\u540d|\u79fb\u52a8|\u4fdd\u5b58|\u8986\u76d6|update|write|edit|create|delete|remove|rename|move|save|overwrite/i

function cleanCandidate(value) {
  let result = String(value || '').trim().replace(TRAILING_PUNCTUATION, '').trim()
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

export function extractLocalAbsolutePaths(content) {
  const text = String(content || '')
  const found = []
  const add = (value) => {
    const candidate = cleanCandidate(value)
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
  if (status.allFilesEnabled) return true
  if (status.workspace?.enabled && status.workspace.path && pathContains(status.workspace.path, targetPath)) return true
  return (status.grants || []).some((grant) => {
    if (!grant?.path || grant.available === false) return false
    if (accessMode === 'read_write' && grant.accessMode !== 'read_write') return false
    if (grant.resourceType === 'file') return comparablePath(grant.path).value === comparablePath(targetPath).value
    return pathContains(grant.path, targetPath)
  })
}

export function buildLocalPathToolInstruction(paths, accessMode = 'read_only') {
  if (!Array.isArray(paths) || !paths.length) return ''
  return [
    '[LOCAL PATH ACCESS GRANTED] The user explicitly authorized these local paths:',
    ...paths.map((path) => `- ${path}`),
    `Access mode: ${accessMode === 'read_write' ? 'read and write' : 'read only'}.`,
    'Use the available file tools, such as list_directory, read_file, and search_files, to access these paths when requested.',
    'You must not claim that local files are inaccessible by design or ask the user to paste their contents. Report concrete tool errors truthfully.',
  ].join('\n')
}

export function resolveLocalPathToolNames(enabledNames, localPathAccess = {}) {
  const configured = Array.from(enabledNames || [])
  if (!Array.isArray(localPathAccess.paths) || localPathAccess.paths.length === 0) return configured
  const required = localPathAccess.accessMode === 'read_write'
    ? ['list_directory', 'read_file', 'write_file', 'edit_file']
    : ['list_directory', 'read_file']
  return [...new Set([...configured, ...required])]
}

export function buildLocalPathEvidenceInstruction(results) {
  if (!Array.isArray(results) || results.length === 0) return ''
  return [
    '[VERIFIED LOCAL FILESYSTEM ACCESS]',
    'The application already performed real filesystem calls after user authorization. Treat the results below as authoritative.',
    ...results.flatMap((result) => [
      `Path: ${result.path}`,
      `Tool: ${result.tool}`,
      `Succeeded: ${result.ok === false ? 'no' : 'yes'}`,
      String(result.content || '').slice(0, 24000),
    ]),
    'Do not answer that local access is unavailable. Use the attached file tools for any follow-up inspection.',
  ].join('\n')
}
