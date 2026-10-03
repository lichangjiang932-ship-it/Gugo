import { createHash } from 'node:crypto'
import { canonicalizeSkillId } from '../../shared/artifactIntent.js'
import { normalizeSkillResourcePath } from '../../shared/skillResourcePaths.js'
import { getImportedSkill } from './skillStore.js'

const MAX_TEXT_BYTES = 512 * 1024
const DEFAULT_PAGE_CHARACTERS = 6000
const MAX_PAGE_CHARACTERS = 8192
const MAX_MANIFEST_FILES = 128
const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'csv', 'tsv',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'sh', 'bash', 'ps1', 'bat', 'cmd',
  'html', 'htm', 'css', 'scss', 'svg', 'xml', 'sql', 'r', 'rs', 'go', 'java', 'c', 'h', 'cpp',
])

function digest(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function textResource(resourcePath, content) {
  if (typeof content !== 'string' || /^data:[^,]*;base64,/i.test(content)) return false
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return false
  }
  const filename = resourcePath.split('/').at(-1)
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase()
  return extension ? TEXT_EXTENSIONS.has(extension) : /^(?:readme|license|notice|dockerfile|makefile)$/i.test(filename)
}

function resourceEntry(resourcePath, content) {
  const storedBytes = Buffer.byteLength(String(content || ''), 'utf8')
  const isText = textResource(resourcePath, content)
  const supported = isText && storedBytes <= MAX_TEXT_BYTES
  return {
    path: resourcePath,
    kind: isText ? 'text' : 'binary',
    storedBytes,
    readable: supported,
    ...(supported ? { sha256: digest(content) } : { reason: isText ? 'resource_too_large' : 'binary_unsupported' }),
  }
}

export function describeSkillResources(skill) {
  if (!skill?.id || !skill.files || typeof skill.files !== 'object') return null
  const entries = Object.entries(skill.files)
    .filter(([resourcePath]) => normalizeSkillResourcePath(resourcePath) === resourcePath)
    .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)
  if (!entries.length) return null
  return {
    version: 1,
    skillId: skill.id,
    base: 'skill-resource:v1:' + skill.id,
    access: 'host_read_only',
    files: entries.slice(0, MAX_MANIFEST_FILES).map(([resourcePath, content]) => resourceEntry(resourcePath, content)),
    omittedFiles: Math.max(0, entries.length - MAX_MANIFEST_FILES),
  }
}

export function getSkillResourceManifest(skillId, { userId } = {}) {
  return describeSkillResources(getImportedSkill(canonicalizeSkillId(skillId), { userId }))
}

export function selectedSkillsHaveResources({ userId, skillIds = [] } = {}) {
  return [...new Set((Array.isArray(skillIds) ? skillIds : []).map(canonicalizeSkillId).filter(Boolean))]
    .slice(0, 32).some((id) => getSkillResourceManifest(id, { userId }) !== null)
}

function failure(code, error, extra = {}) {
  return { ok: false, code, error, retryable: false, ...extra }
}

/** The host supplies identity/selection; model arguments can select neither an owner nor a directory. */
export function readSelectedSkillResource(args = {}, { userId, skillIds = [], skillId = null, signal } = {}) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })
  const requestedId = canonicalizeSkillId(args.skill_id)
  const selected = new Set([...(Array.isArray(skillIds) ? skillIds : []), skillId].map(canonicalizeSkillId).filter(Boolean))
  if (!userId || !requestedId || !selected.has(requestedId)) {
    return failure('SKILL_RESOURCE_NOT_AUTHORIZED', 'The resource must belong to a skill selected for this turn.')
  }
  const skill = getImportedSkill(requestedId, { userId })
  if (!skill) return failure('SKILL_RESOURCE_NOT_AUTHORIZED', 'The selected skill is not accessible to this user.')
  const manifest = describeSkillResources(skill)
  if (args.path === undefined) return { ok: true, manifest, execution: 'not_executed' }
  const resourcePath = normalizeSkillResourcePath(args.path)
  if (!resourcePath || /%(?:2e|2f|5c|00)/i.test(resourcePath)) {
    return failure('SKILL_RESOURCE_PATH_INVALID', 'Use a canonical relative package path without traversal or encoded separators.')
  }
  if (!Object.hasOwn(skill.files || {}, resourcePath)) {
    return failure('SKILL_RESOURCE_NOT_FOUND', 'The selected skill does not contain this resource.')
  }
  const content = skill.files[resourcePath]
  const entry = resourceEntry(resourcePath, content)
  if (!entry.readable) return failure(
    entry.reason === 'binary_unsupported' ? 'SKILL_RESOURCE_BINARY_UNSUPPORTED' : 'SKILL_RESOURCE_TOO_LARGE',
    'This resource is stored but is not supported by the bounded text reader.',
    { reason: entry.reason, resource: entry },
  )
  const offset = args.offset ?? 0
  const limit = args.limit ?? DEFAULT_PAGE_CHARACTERS
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_CHARACTERS) {
    return failure('SKILL_RESOURCE_PAGE_INVALID', 'offset and limit must be bounded non-negative Unicode character counts.')
  }
  const characters = Array.from(content)
  if (offset > characters.length) return failure('SKILL_RESOURCE_PAGE_INVALID', 'offset is beyond the end of this resource.')
  const nextOffset = Math.min(characters.length, offset + limit)
  return {
    ok: true, skillId: requestedId, resourceBase: manifest.base, path: resourcePath,
    content: characters.slice(offset, nextOffset).join(''), sha256: entry.sha256,
    offset, nextOffset: nextOffset < characters.length ? nextOffset : null,
    totalCharacters: characters.length, eof: nextOffset === characters.length,
    execution: 'not_executed',
  }
}
