import fs from 'node:fs'
import path from 'node:path'
import { validateRuntimeStoragePath } from './runtimeStoragePath.js'

// 只在第一次没找到 .env 时提示一次,避免每次调用都刷屏
let missingEnvWarned = false
export const MAX_RUNTIME_CONFIG_BYTES = 64 * 1024
const RUNTIME_CONFIG_RELATIVE_PATH = path.join('.gugo', 'runtime.json')
const SENSITIVE_CONFIG_KEY = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY)/i
const BOOTSTRAP_ENV_KEYS = new Set(Object.keys(process.env))
const USER_CONFIG_SELF_RELOCATION_KEYS = Object.freeze(['APP_DATA_DIR', 'APP_CONFIG_PATH'])
const RUNTIME_STARTUP_IDENTITY_KEYS = Object.freeze([
  'APP_DATA_DIR',
  'APP_DB_PATH',
  'APP_CONFIG_PATH',
])

function runtimeConfigSelfRelocationError(key, filePath, requestedPath = null) {
  const error = new Error(
    `${key} cannot relocate its own runtime config source: ${filePath}`,
  )
  error.code = 'RUNTIME_CONFIG_SELF_RELOCATION'
  error.retryable = false
  error.key = key
  error.sourcePath = filePath
  error.requestedPath = requestedPath
  return error
}

export const WORKSPACE_FEATURE_ENV_KEYS = Object.freeze([
  'WORKSPACE_FS_ENABLED',
  'WORKSPACE_SHELL_ENABLED',
  'WORKSPACE_GIT_ENABLED',
  'WORKSPACE_GIT_MUTATION_ENABLED',
])

function runtimeConfigFileError(message, {
  code = 'RUNTIME_CONFIG_FILE_INVALID',
  statusCode = 422,
  sourcePath = null,
  key = null,
  cause = null,
} = {}) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  error.retryable = false
  if (sourcePath) error.sourcePath = sourcePath
  if (key) error.key = key
  if (cause) error.cause = cause
  return error
}

function normalizeRuntimeConfigValue(key, value, filePath) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw runtimeConfigFileError(`runtime config key must be uppercase env style: ${key}`, {
      sourcePath: filePath,
      key,
    })
  }
  if (SENSITIVE_CONFIG_KEY.test(key)) {
    throw runtimeConfigFileError(`sensitive runtime config key is not allowed in JSON: ${key}`, {
      sourcePath: filePath,
      key,
    })
  }
  if (value == null) return ''
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value)
  throw runtimeConfigFileError(`runtime config value must be a scalar: ${key}`, {
    sourcePath: filePath,
    key,
  })
}

export function parseRuntimeConfigContent(content, { filePath = null } = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
  if (bytes.byteLength > MAX_RUNTIME_CONFIG_BYTES) {
    throw runtimeConfigFileError(`runtime config exceeds ${MAX_RUNTIME_CONFIG_BYTES} bytes`, {
      code: 'RUNTIME_CONFIG_FILE_TOO_LARGE',
      statusCode: 413,
      sourcePath: filePath,
    })
  }
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw runtimeConfigFileError('runtime config contains invalid JSON', {
      sourcePath: filePath,
      cause,
    })
  }
  const values = parsed?.env ?? parsed
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw runtimeConfigFileError('runtime config must be a JSON object', { sourcePath: filePath })
  }
  const env = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, normalizeRuntimeConfigValue(key, value, filePath)]),
  )
  return Object.freeze({ document: parsed, env, content: bytes })
}

export function readRuntimeConfigFileSnapshot(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return Object.freeze({ exists: false, path: filePath || null, document: null, env: {}, content: null })
  }
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    throw runtimeConfigFileError('runtime config is not a regular file', { sourcePath: filePath })
  }
  if (stat.size > MAX_RUNTIME_CONFIG_BYTES) {
    throw runtimeConfigFileError(`runtime config exceeds ${MAX_RUNTIME_CONFIG_BYTES} bytes`, {
      code: 'RUNTIME_CONFIG_FILE_TOO_LARGE',
      statusCode: 413,
      sourcePath: filePath,
    })
  }
  const parsed = parseRuntimeConfigContent(fs.readFileSync(filePath), { filePath })
  return Object.freeze({ exists: true, path: filePath, ...parsed })
}

export function readRuntimeConfigFile(filePath) {
  return readRuntimeConfigFileSnapshot(filePath).env
}

export function resolveRuntimeConfigPaths({ cwd = process.cwd(), env = process.env } = {}) {
  const configuredDataDir = validateRuntimeStoragePath(env.APP_DATA_DIR, { key: 'APP_DATA_DIR' })
  const dataDir = path.resolve(cwd, configuredDataDir || 'server-data')
  const project = path.join(cwd, RUNTIME_CONFIG_RELATIVE_PATH)
  const explicit = env.APP_CONFIG_PATH ? path.resolve(cwd, env.APP_CONFIG_PATH) : null
  return {
    user: path.join(dataDir, 'runtime.json'),
    project,
    explicit,
  }
}

export function readRuntimeEnvFile(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env')
  if (!fs.existsSync(envPath)) {
    // ★ 找不到 .env 时原来是完全静默的 —— 从子目录启动服务(很常见)
    // 会导致所有模型配置凭空消失,而用户看到的只是「没配模型」,
    // 完全想不到是启动目录的问题。至少说一声。
    if (!missingEnvWarned && !process.env.MODEL_BASE_URL && !process.env.MODEL_PROVIDERS) {
      missingEnvWarned = true
      console.warn(
        `[env] 未找到 ${envPath} —— 仍可在“设置 → 模型”中保存并使用本地 BYOK Provider；`
        + 'MODEL_* 环境变量仅用于部署默认配置。'
        + '\n[env] 如果你希望加载 .env，请确认是从**仓库根目录**启动服务（npm run serve）。',
      )
    }
    return {}
  }

  const entries = {}
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!key) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    entries[key] = value
  }
  return entries
}

export function getRuntimeEnv(env = process.env, { cwd = process.cwd(), loadDotEnv = true } = {}) {
  const paths = resolveRuntimeConfigPaths({ cwd, env })
  const user = readRuntimeConfigFile(paths.user)
  const project = readRuntimeConfigFile(paths.project)
  const explicit = paths.explicit && ![paths.user, paths.project].includes(paths.explicit)
    ? readRuntimeConfigFile(paths.explicit)
    : {}
  const dotenv = loadDotEnv && env.GUGO_LOAD_DOTENV !== '0' ? readRuntimeEnvFile(cwd) : {}
  return { ...user, ...project, ...explicit, ...dotenv, ...env }
}

function discoverRuntimeStartupConfigLayers({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const dotenv = env.GUGO_LOAD_DOTENV !== '0' ? readRuntimeEnvFile(cwd) : {}
  const bootstrapEnv = { ...dotenv, ...env }
  const bootstrapPaths = resolveRuntimeConfigPaths({ cwd, env: bootstrapEnv })
  const project = readRuntimeConfigFile(bootstrapPaths.project)
  // Project configuration may itself select the deployment-owned explicit
  // config file, so resolve that path only after the fixed project layer has
  // been read. Dotenv and the caller environment retain their higher priority.
  const explicitPaths = resolveRuntimeConfigPaths({
    cwd,
    env: { ...project, ...dotenv, ...env },
  })
  const explicit = explicitPaths.explicit
    && ![explicitPaths.user, explicitPaths.project].includes(explicitPaths.explicit)
    ? readRuntimeConfigFile(explicitPaths.explicit)
    : {}
  if (explicitPaths.explicit && Object.hasOwn(explicit, 'APP_CONFIG_PATH')) {
    const relocatedExplicitPath = explicit.APP_CONFIG_PATH
      ? path.resolve(cwd, explicit.APP_CONFIG_PATH)
      : null
    if (relocatedExplicitPath !== explicitPaths.explicit) {
      throw runtimeConfigSelfRelocationError(
        'APP_CONFIG_PATH',
        explicitPaths.explicit,
        relocatedExplicitPath,
      )
    }
  }
  const storageDiscoveryEnv = { ...project, ...explicit, ...dotenv, ...env }
  const storagePaths = resolveRuntimeConfigPaths({ cwd, env: storageDiscoveryEnv })
  return Object.freeze({
    dotenv,
    project,
    explicit,
    paths: Object.freeze({
      user: storagePaths.user,
      project: bootstrapPaths.project,
      explicit: explicitPaths.explicit,
    }),
  })
}

/**
 * Resolve the exact startup-owned config source paths without reading the user
 * runtime.json. Recovery mode uses this to prove that an error belongs to the
 * user-editable source instead of a project or deployment-owned source.
 */
export function resolveRuntimeStartupConfigPaths(options = {}) {
  return discoverRuntimeStartupConfigLayers(options).paths
}

/**
 * Resolve the process startup environment before SQLite is opened.
 *
 * Storage paths need one extra discovery pass because `.env`, project config,
 * or an explicit config can relocate APP_DATA_DIR, which in turn relocates the
 * user runtime.json file. The returned paths are absolute and anchored to the
 * caller-provided cwd so every process-owned service receives one data root.
 */
export function resolveRuntimeStartupEnvironment({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const {
    dotenv,
    project,
    explicit,
    paths: sourcePaths,
  } = discoverRuntimeStartupConfigLayers({ cwd, env })
  const user = readRuntimeConfigFile(sourcePaths.user)
  const selfRelocatingKey = USER_CONFIG_SELF_RELOCATION_KEYS.find((key) => (
    Object.hasOwn(user, key)
  ))
  if (selfRelocatingKey) {
    throw runtimeConfigSelfRelocationError(selfRelocatingKey, sourcePaths.user)
  }
  const resolved = { ...user, ...project, ...explicit, ...dotenv, ...env }
  const configuredDataDir = validateRuntimeStoragePath(resolved.APP_DATA_DIR, { key: 'APP_DATA_DIR' })
  const configuredDbPath = validateRuntimeStoragePath(resolved.APP_DB_PATH, { key: 'APP_DB_PATH' })
  const appDataDir = path.resolve(cwd, configuredDataDir || 'server-data')
  const appDbPath = configuredDbPath
    ? path.resolve(cwd, configuredDbPath)
    : path.join(appDataDir, 'app.db')
  return Object.freeze({
    ...resolved,
    APP_DATA_DIR: appDataDir,
    APP_DB_PATH: appDbPath,
    ...(sourcePaths.explicit ? { APP_CONFIG_PATH: sourcePaths.explicit } : {}),
  })
}

export function assertRuntimeStartupIdentityStable(before, after) {
  for (const key of RUNTIME_STARTUP_IDENTITY_KEYS) {
    const left = before?.[key] ? String(before[key]) : null
    const right = after?.[key] ? String(after[key]) : null
    if (left === right) continue
    const error = new Error(`${key} changed during runtime startup preflight`)
    error.code = 'RUNTIME_CONFIG_IDENTITY_CHANGED_DURING_PREFLIGHT'
    error.retryable = false
    error.key = key
    error.before = left
    error.after = right
    throw error
  }
  return true
}

/** Apply only process storage identity before importing/starting DB consumers. */
export function applyRuntimeStorageBootstrap(options = {}) {
  const resolved = resolveRuntimeStartupEnvironment(options)
  process.env.APP_DATA_DIR = resolved.APP_DATA_DIR
  process.env.APP_DB_PATH = resolved.APP_DB_PATH
  return resolved
}

function readRuntimeConfigDocument(filePath) {
  const snapshot = readRuntimeConfigFileSnapshot(filePath)
  if (!snapshot.exists) return { env: {}, onboarding: {} }
  const parsed = snapshot.document
  const metadata = parsed?.env && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'env'))
    : {}
  return {
    ...metadata,
    env: snapshot.env,
    onboarding: parsed?.env && parsed?.onboarding && typeof parsed.onboarding === 'object'
      ? parsed.onboarding
      : {},
  }
}

function runtimeFeatureLock(key, { cwd = process.cwd(), env = process.env } = {}) {
  const paths = resolveRuntimeConfigPaths({ cwd, env })
  const dotenv = env.GUGO_LOAD_DOTENV !== '0' ? readRuntimeEnvFile(cwd) : {}
  const explicit = paths.explicit && ![paths.user, paths.project].includes(paths.explicit)
    ? readRuntimeConfigFile(paths.explicit)
    : {}
  const project = readRuntimeConfigFile(paths.project)
  if (BOOTSTRAP_ENV_KEYS.has(key)) return { locked: true, source: 'environment' }
  if (Object.hasOwn(dotenv, key)) return { locked: true, source: '.env' }
  if (Object.hasOwn(explicit, key)) return { locked: true, source: 'explicit_config' }
  if (Object.hasOwn(project, key)) return { locked: true, source: 'project_config' }
  return { locked: false, source: 'user_config' }
}

export function getWorkspaceRuntimeConfiguration({ cwd = process.cwd(), env = process.env } = {}) {
  const paths = resolveRuntimeConfigPaths({ cwd, env })
  const document = readRuntimeConfigDocument(paths.user)
  const resolved = getRuntimeEnv(env, { cwd })
  return {
    path: paths.user,
    completedAt: Number(document.onboarding?.completedAt) || null,
    features: Object.fromEntries(WORKSPACE_FEATURE_ENV_KEYS.map((key) => {
      const lock = runtimeFeatureLock(key, { cwd, env })
      return [key, {
        enabled: String(resolved[key] || '') === '1',
        locked: lock.locked,
        source: lock.locked
          ? lock.source
          : Object.hasOwn(document.env, key) ? 'user_config' : 'default',
      }]
    })),
  }
}

/**
 * Persist the three non-secret workspace feature switches used by the local
 * onboarding flow. Deployment-level values (.env, project/explicit config or
 * the process environment) remain authoritative and cannot be overwritten.
 */
export function updateWorkspaceRuntimeConfiguration({
  features,
  completedAt = Date.now(),
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    const error = new Error('workspace features must be an object')
    error.statusCode = 400
    error.code = 'INVALID_WORKSPACE_FEATURES'
    throw error
  }
  const unknown = Object.keys(features).filter((key) => !WORKSPACE_FEATURE_ENV_KEYS.includes(key))
  if (unknown.length) {
    const error = new Error(`unsupported workspace feature keys: ${unknown.join(', ')}`)
    error.statusCode = 400
    error.code = 'INVALID_WORKSPACE_FEATURES'
    throw error
  }
  const effectiveFeatures = {
    ...features,
    WORKSPACE_GIT_MUTATION_ENABLED: features.WORKSPACE_GIT_MUTATION_ENABLED
      ?? features.WORKSPACE_GIT_ENABLED,
  }
  const values = Object.fromEntries(WORKSPACE_FEATURE_ENV_KEYS.map((key) => {
    if (typeof effectiveFeatures[key] !== 'boolean') {
      const error = new Error(`${key} must be a boolean`)
      error.statusCode = 400
      error.code = 'INVALID_WORKSPACE_FEATURES'
      throw error
    }
    return [key, effectiveFeatures[key] ? '1' : '0']
  }))
  const locks = Object.entries(values).flatMap(([key, value]) => {
    const lock = runtimeFeatureLock(key, { cwd, env })
    const current = String(getRuntimeEnv(env, { cwd })[key] || '')
    return lock.locked && current !== value ? [{ key, source: lock.source, current }] : []
  })
  if (locks.length) {
    const error = new Error(`deployment policy locks: ${locks.map((item) => item.key).join(', ')}`)
    error.statusCode = 409
    error.code = 'RUNTIME_CONFIG_LOCKED'
    error.locks = locks
    throw error
  }

  const paths = resolveRuntimeConfigPaths({ cwd, env })
  const document = readRuntimeConfigDocument(paths.user)
  const next = {
    ...document,
    env: { ...document.env, ...values },
    onboarding: { ...document.onboarding, completedAt },
  }
  fs.mkdirSync(path.dirname(paths.user), { recursive: true })
  const tempPath = `${paths.user}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(tempPath, paths.user)
  } catch (error) {
    try { fs.unlinkSync(tempPath) } catch { /* best effort */ }
    throw error
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  return getWorkspaceRuntimeConfiguration({ cwd, env: { ...env, ...values } })
}

export function applyRuntimeConfig({
  cwd = process.cwd(),
  env = process.env,
  resolvedEnv = null,
} = {}) {
  const resolved = resolvedEnv || resolveRuntimeStartupEnvironment({ cwd, env })
  for (const [key, value] of Object.entries(resolved)) {
    process.env[key] = String(value)
  }
  return resolved
}
