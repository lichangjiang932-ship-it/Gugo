import { CONNECTOR_WRITE_TOOL_NAMES } from '../../shared/connectorWriteTools.js'

const TASK_GRANT_SCOPES = new Set(['this-run', 'until-date', 'forever'])

const SHELL_TASK_GRANT_TOOLS = new Set([
  'bash_exec',
  'run_command',
  'run_test',
  'docker_exec',
  'bash_background',
])

// Task grants are an explicit capability surface, not a name-pattern guess.
// Keep this list limited to known outbound side-effect tools; dynamic or newly
// added tools must be reviewed and declared here before a cron rule can waive
// their normal approval prompt.
const EXTERNAL_TASK_GRANT_TOOLS = new Set([
  ...CONNECTOR_WRITE_TOOL_NAMES,
  'publish_report',
  'fetch_url',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_open_url',
  'browser_navigate',
  'connected_app_open',
])

// A scheduled grant must never replace the existing local-write boundary.
const LOCAL_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'patch_file',
  'file_download',
  'image_transform',
  'pdf_transform',
  'media_transform',
  'archive_create',
  'archive_extract',
  'batch_rename',
  'git_commit',
  'git_push',
  'git_rollback',
  'git_write',
  'rewind_files',
])

const TARGET_FIELDS = new Set([
  'to',
  'recipient',
  'recipientEmail',
  'email',
  'channelId',
  'channel',
  'conversationId',
  'repository',
  'repo',
  'owner',
  'url',
  'target',
  'selector',
  'resourceId',
  'projectId',
  'issueId',
  'pageId',
  'databaseId',
  'eventId',
  'appId',
  'id',
])

const SHELL_META_RE = /[;&|><`$()\r\n]/u
const WILDCARD_RE = /[*?[\]{}]/u
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,160}$/u
const MAX_GRANTS = 50
const MAX_TARGET_TEXT = 2048

function grantError(message, code = 'TASK_GRANT_INVALID') {
  const error = new Error(message)
  error.code = code
  error.statusCode = 400
  return error
}

function normalizeTargetScalar(value, label) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') throw grantError(`${label} must be a string or finite number`)
  const normalized = value.trim()
  if (!normalized) throw grantError(`${label} is required`)
  if (normalized.length > MAX_TARGET_TEXT) throw grantError(`${label} is too long`)
  if (WILDCARD_RE.test(normalized)) throw grantError(`${label} must not contain wildcards`)
  if (SHELL_META_RE.test(normalized)) throw grantError(`${label} must not contain shell metacharacters`)
  return normalized
}

function normalizeShellTarget(target) {
  if (!Array.isArray(target)) {
    throw grantError('shell task grant target must be an argv array')
  }
  if (target.length < 2 || target.length > 16) {
    throw grantError('shell task grant target must contain between 2 and 16 argv entries')
  }
  return target.map((entry, index) => {
    const normalized = normalizeTargetScalar(entry, `shell target argv[${index}]`)
    if (typeof normalized !== 'string') {
      throw grantError(`shell target argv[${index}] must be a string`)
    }
    return normalized
  })
}

function normalizeExternalTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw grantError('external task grant target must be an object with one exact target field')
  }
  const entries = Object.entries(target)
  if (entries.length !== 1) {
    throw grantError('external task grant target must contain exactly one target field')
  }
  const [field, value] = entries[0]
  if (!TARGET_FIELDS.has(field)) {
    throw grantError(`unsupported task grant target field: ${field}`)
  }
  return { [field]: normalizeTargetScalar(value, `target.${field}`) }
}

function normalizeExpiry(value) {
  const numeric = typeof value === 'number' ? value : Number.NaN
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw grantError('until-date task grants require a valid expiresAt value')
  }
  return Math.floor(timestamp)
}

export function normalizeTaskGrant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw grantError('each task grant must be an object')
  }
  const tool = String(value.tool || value.toolName || '').trim()
  if (!TOOL_NAME_RE.test(tool)) throw grantError('task grant tool is invalid')
  if (LOCAL_WRITE_TOOLS.has(tool)) {
    throw grantError(`${tool} cannot be auto-authorized by a task grant`, 'TASK_GRANT_LOCAL_WRITE_FORBIDDEN')
  }
  const grantKind = SHELL_TASK_GRANT_TOOLS.has(tool)
    ? 'shell'
    : EXTERNAL_TASK_GRANT_TOOLS.has(tool)
      ? 'external'
      : null
  if (!grantKind) {
    throw grantError(
      `${tool} is not declared as a task-grant-capable external tool`,
      'TASK_GRANT_TOOL_UNSUPPORTED',
    )
  }
  const scope = String(value.scope || 'this-run').trim()
  if (!TASK_GRANT_SCOPES.has(scope)) {
    throw grantError('task grant scope must be this-run, until-date, or forever')
  }
  const target = grantKind === 'shell'
    ? normalizeShellTarget(value.target)
    : normalizeExternalTarget(value.target)
  const normalized = { tool, target, scope }
  if (scope === 'until-date') {
    normalized.expiresAt = normalizeExpiry(value.expiresAt ?? value.untilDate ?? value.until)
  }
  return normalized
}

export function normalizeTaskGrants(value) {
  if (value == null || value === '') return []
  let source = value
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch (error) {
      throw grantError(`grants must be valid JSON: ${error.message}`)
    }
  }
  if (!Array.isArray(source)) throw grantError('grants must be an array')
  if (source.length > MAX_GRANTS) throw grantError(`grants may contain at most ${MAX_GRANTS} entries`)
  const seen = new Set()
  const normalized = []
  for (const item of source) {
    const grant = normalizeTaskGrant(item)
    const key = JSON.stringify(grant)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(grant)
  }
  return normalized
}

function commandArgv(command) {
  const source = typeof command === 'string' ? command.trim() : ''
  if (!source || SHELL_META_RE.test(source) || WILDCARD_RE.test(source)) return null
  const argv = []
  let token = ''
  let quote = null
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && source[index + 1] === '"') {
        token += '"'
        index += 1
      } else {
        token += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/u.test(char)) {
      if (token) {
        argv.push(token)
        token = ''
      }
      continue
    }
    token += char
  }
  if (quote) return null
  if (token) argv.push(token)
  return argv.length > 0 ? argv : null
}

function grantIsActive(grant, now) {
  return grant.scope !== 'until-date' || Number(grant.expiresAt) > now
}

function matchesShellGrant(grant, args) {
  const argv = commandArgv(args?.command)
  if (!argv || argv.length < grant.target.length) return false
  return grant.target.every((expected, index) => argv[index] === expected)
}

function matchesExternalGrant(grant, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  const [[field, expected]] = Object.entries(grant.target)
  const actual = args[field]
  if (typeof expected === 'number') return typeof actual === 'number' && actual === expected
  return typeof actual === 'string' && actual.trim() === expected
}

export function findMatchingTaskGrant(toolName, args = {}, grants = [], { now = Date.now() } = {}) {
  const tool = String(toolName || '').trim()
  if (!tool || LOCAL_WRITE_TOOLS.has(tool) || !Array.isArray(grants)) return null
  for (const candidate of grants) {
    let grant
    try {
      grant = normalizeTaskGrant(candidate)
    } catch {
      continue
    }
    if (grant.tool !== tool || !grantIsActive(grant, now)) continue
    const matches = SHELL_TASK_GRANT_TOOLS.has(tool)
      ? matchesShellGrant(grant, args)
      : matchesExternalGrant(grant, args)
    if (matches) return grant
  }
  return null
}

export const _testing = Object.freeze({
  commandArgv,
  EXTERNAL_TASK_GRANT_TOOLS,
  LOCAL_WRITE_TOOLS,
  SHELL_TASK_GRANT_TOOLS,
  TARGET_FIELDS,
})
