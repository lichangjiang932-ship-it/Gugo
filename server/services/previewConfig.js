import fs from 'node:fs'
import path from 'node:path'

/**
 * `.gugo/launch.json` — the preview's only source of truth.
 *
 * The file is written by the reader and lives in their repository, so every field
 * is treated as untrusted input: the launch command comes from a file that may be
 * committed by someone else, which is why nothing here is executed by a shell and
 * why the environment block refuses anything that looks like a credential (this
 * file is meant to be committed, and a committed secret is a leak that outlives
 * the session). Validation returns every problem at once — a reader fixing their
 * config wants the whole list, not the first line.
 */

export const PREVIEW_CONFIG_DIRECTORY = '.gugo'
export const PREVIEW_CONFIG_FILENAME = 'launch.json'
export const PREVIEW_WORKSPACE_FOLDER = '${workspaceFolder}'
export const DEFAULT_PREVIEW_PORT = 3000
export const MAX_PREVIEW_ARGUMENTS = 64
export const MAX_PREVIEW_ARGUMENT_CHARS = 512
export const MAX_PREVIEW_ENV_ENTRIES = 32

// A whole segment of the name, so `MONKEY` is not a key and `API_KEY` is.
const SECRET_ENV_NAME = /(?:^|_)(?:key|keys|token|secret|password|passwd|credential|credentials|auth|apikey)(?:$|_)/i
const SECRET_VALUE_PREFIX = /^(?:sk-[A-Za-z0-9]|ghp_|gho_|ghu_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{8,}|-----BEGIN )/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function previewConfigPath(workspaceRoot) {
  return path.join(String(workspaceRoot || ''), PREVIEW_CONFIG_DIRECTORY, PREVIEW_CONFIG_FILENAME)
}

function looksLikeSecretValue(value) {
  const text = String(value || '').trim()
  if (!text) return false
  if (SECRET_VALUE_PREFIX.test(text)) return true
  // A long unbroken run of mixed characters is a key, not a setting.
  return text.length >= 40 && !/\s/.test(text) && /[0-9]/.test(text) && /[A-Za-z]/.test(text)
}

/** Windows runs `.cmd` shims through cmd.exe, where these cannot be quoted safely. */
function hasUnquotableCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (character === '"' || code < 0x20 || code === 0x7f) return true
  }
  return false
}

function normalizeArguments(raw, problems, label) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problems.push(`${label} 必须是字符串数组`)
    return []
  }
  if (raw.length > MAX_PREVIEW_ARGUMENTS) {
    problems.push(`${label} 最多 ${MAX_PREVIEW_ARGUMENTS} 项`)
    return []
  }
  const args = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length > MAX_PREVIEW_ARGUMENT_CHARS) {
      problems.push(`${label} 只能是长度不超过 ${MAX_PREVIEW_ARGUMENT_CHARS} 的字符串`)
      return []
    }
    // Refusing these here keeps the spawn path free of a quoting decision it
    // cannot win.
    if (hasUnquotableCharacter(entry)) {
      problems.push(`${label} 不能包含引号或控制字符：${entry}`)
      return []
    }
    args.push(entry)
  }
  return args
}

function normalizeEnvironment(raw, problems, label) {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${label} 必须是对象`)
    return {}
  }
  const entries = Object.entries(raw)
  if (entries.length > MAX_PREVIEW_ENV_ENTRIES) {
    problems.push(`${label} 最多 ${MAX_PREVIEW_ENV_ENTRIES} 项`)
    return {}
  }
  const env = {}
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      problems.push(`${label}.${key} 必须是字符串`)
      continue
    }
    if (SECRET_ENV_NAME.test(key) || looksLikeSecretValue(value)) {
      problems.push(`${label}.${key} 看起来是凭据；launch.json 会被提交，密钥不要写在这里`)
      continue
    }
    env[key] = value
  }
  return env
}

function normalizeCwd(raw, problems, label) {
  if (raw === undefined) return PREVIEW_WORKSPACE_FOLDER
  if (typeof raw !== 'string' || !raw.trim()) {
    problems.push(`${label} 必须是非空字符串`)
    return PREVIEW_WORKSPACE_FOLDER
  }
  return raw.trim()
}

/** A localhost origin only: a preview URL with a path or query names one screen, not the app. */
function normalizeUrl(raw, problems, label) {
  if (raw === undefined) return ''
  if (typeof raw !== 'string' || !raw.trim()) {
    problems.push(`${label} 必须是非空字符串`)
    return ''
  }
  let parsed
  try {
    parsed = new URL(raw.trim())
  } catch {
    problems.push(`${label} 不是合法的 URL`)
    return ''
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !/^https?:$/.test(parsed.protocol)) {
    problems.push(`${label} 只能是本机地址（localhost / 127.0.0.1），预览不打开外部站点`)
    return ''
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    problems.push(`${label} 只能是服务器源，不能带路径或查询参数`)
    return ''
  }
  return parsed.origin
}

function normalizePort(raw, problems, label) {
  if (raw === undefined) return { port: DEFAULT_PREVIEW_PORT, explicit: false }
  if (!Number.isInteger(raw) || raw < 1 || raw > 65_535) {
    problems.push(`${label} 必须是 1..65535 的整数`)
    return { port: DEFAULT_PREVIEW_PORT, explicit: false }
  }
  return { port: raw, explicit: true }
}

function normalizeBoolean(raw, problems, label, fallback) {
  if (raw === undefined) return fallback
  if (typeof raw !== 'boolean') {
    problems.push(`${label} 必须是布尔值`)
    return fallback
  }
  return raw
}

function normalizeConfiguration(raw, index, problems) {
  const label = `configurations[${index}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${label} 必须是对象`)
    return null
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) problems.push(`${label}.name 必填`)
  const hasExecutable = Boolean(typeof raw.runtimeExecutable === 'string' && raw.runtimeExecutable.trim())
  const hasProgram = Boolean(typeof raw.program === 'string' && raw.program.trim())
  if (hasExecutable === hasProgram) {
    problems.push(`${label} 必须且只能声明 runtimeExecutable 或 program 之一`)
  }
  const { port, explicit } = normalizePort(raw.port, problems, `${label}.port`)
  return {
    index,
    name,
    executable: hasExecutable ? String(raw.runtimeExecutable).trim() : String(raw.program || '').trim(),
    args: normalizeArguments(hasExecutable ? raw.runtimeArgs : raw.args, problems, `${label}.${hasExecutable ? 'runtimeArgs' : 'args'}`),
    cwd: normalizeCwd(raw.cwd, problems, `${label}.cwd`),
    env: normalizeEnvironment(raw.env, problems, `${label}.env`),
    port,
    portExplicit: explicit,
    autoPort: typeof raw.autoPort === 'boolean' ? raw.autoPort : null,
    readyPattern: typeof raw.readyPattern === 'string' && raw.readyPattern.trim() ? raw.readyPattern.trim() : '',
    url: normalizeUrl(raw.url, problems, `${label}.url`),
    persistCookies: normalizeBoolean(raw.persistCookies, problems, `${label}.persistCookies`, false),
  }
}

/**
 * The config as the app reads it, plus every problem found in it.
 *
 * `missing` is not a failure: a workspace that has never set up a preview is the
 * normal first state, and the panel offers to write the file rather than treating
 * an absent file as an error.
 */
export function readPreviewConfig({ workspaceRoot } = {}) {
  const filePath = previewConfigPath(workspaceRoot)
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, missing: true, problems: [], config: null, path: filePath }
    return { ok: false, missing: false, problems: [`无法读取 ${filePath}：${error?.message || error}`], config: null, path: filePath }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, missing: false, problems: [`launch.json 不是合法 JSON：${error?.message || error}`], config: null, path: filePath }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, missing: false, problems: ['launch.json 顶层必须是对象'], config: null, path: filePath }
  }
  const problems = []
  const autoVerify = normalizeBoolean(raw.autoVerify, problems, 'autoVerify', true)
  if (!Array.isArray(raw.configurations) || raw.configurations.length === 0) {
    return { ok: false, missing: false, problems: [...problems, 'configurations 至少需要一个条目'], config: null, path: filePath }
  }
  const configurations = raw.configurations
    .map((entry, index) => normalizeConfiguration(entry, index, problems))
    .filter(Boolean)
  const seen = new Set()
  for (const configuration of configurations) {
    if (seen.has(configuration.name)) problems.push(`配置名重复：${configuration.name}`)
    seen.add(configuration.name)
  }
  const config = {
    version: typeof raw.version === 'string' ? raw.version : '0.0.1',
    autoVerify,
    configurations,
  }
  return { ok: problems.length === 0, missing: false, problems, config, path: filePath }
}

/**
 * The file a workspace starts from, written only when there is none.
 *
 * It is a starting point a reader edits — `npm run dev` on port 3000 is the shape
 * of most projects — and it is never written over a file that already exists, so
 * pressing "set up" twice cannot discard someone's configuration.
 */
export function writeStarterPreviewConfig({ workspaceRoot } = {}) {
  const filePath = previewConfigPath(workspaceRoot)
  if (fs.existsSync(filePath)) return { ok: false, code: 'PREVIEW_CONFIG_EXISTS', problems: ['launch.json 已经存在'] }
  const starter = {
    version: '0.0.1',
    autoVerify: true,
    configurations: [{
      name: 'dev-server',
      runtimeExecutable: 'npm',
      runtimeArgs: ['run', 'dev'],
      port: DEFAULT_PREVIEW_PORT,
      cwd: PREVIEW_WORKSPACE_FOLDER,
      env: {},
      autoPort: true,
      readyPattern: '',
    }],
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${JSON.stringify(starter, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    return { ok: false, code: 'PREVIEW_CONFIG_WRITE_FAILED', problems: [`无法写入 launch.json：${error?.message || error}`] }
  }
  return { ok: true, problems: [], path: filePath }
}

/** The absolute working directory of one configuration, kept inside the workspace. */
export function resolveConfigurationCwd(configuration, workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || ''))
  const requested = String(configuration?.cwd || PREVIEW_WORKSPACE_FOLDER).replaceAll(PREVIEW_WORKSPACE_FOLDER, root)
  const resolved = path.resolve(root, requested)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: 'cwd 必须位于工作区内', path: resolved }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return { ok: false, reason: 'cwd 不是已存在的目录', path: resolved }
  return { ok: true, reason: '', path: resolved }
}

/** What the panel's server dropdown shows, without exposing the full config. */
export function previewConfigurationSummaries(config) {
  return (config?.configurations || []).map((configuration) => ({
    name: configuration.name,
    command: [configuration.executable, ...configuration.args].join(' '),
    port: configuration.port,
    url: configuration.url || `http://localhost:${configuration.port}`,
    autoPort: configuration.autoPort === true,
  }))
}

/**
 * Flip one boolean in the file the reader owns.
 *
 * Only `autoVerify` is written by the app: the switch has to survive a restart,
 * and the file is the config. Everything else — command, port, environment — is
 * the reader's to change, so this rewrites the parsed object rather than
 * reserializing a shape the app invented, and it writes through a temporary file
 * so a crash mid-write cannot leave an unparseable launch.json behind.
 */
export function writePreviewAutoVerify({ workspaceRoot, autoVerify } = {}) {
  if (typeof autoVerify !== 'boolean') return { ok: false, problems: ['autoVerify 必须是布尔值'] }
  const filePath = previewConfigPath(workspaceRoot)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    return { ok: false, problems: [`无法更新 launch.json：${error?.message || error}`] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problems: ['launch.json 顶层必须是对象'] }
  }
  raw.autoVerify = autoVerify
  const temporary = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, filePath)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch { /* the rename failure is the one to report */ }
    return { ok: false, problems: [`无法写入 launch.json：${error?.message || error}`] }
  }
  return { ok: true, problems: [] }
}
