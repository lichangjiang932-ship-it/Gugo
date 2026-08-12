import fs from 'node:fs'
import path from 'node:path'

// 只在第一次没找到 .env 时提示一次,避免每次调用都刷屏
let missingEnvWarned = false
const MAX_RUNTIME_CONFIG_BYTES = 64 * 1024
const RUNTIME_CONFIG_RELATIVE_PATH = path.join('.gugo', 'runtime.json')
const SENSITIVE_CONFIG_KEY = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY)/i
const BOOTSTRAP_ENV_KEYS = new Set(Object.keys(process.env))

export const WORKSPACE_FEATURE_ENV_KEYS = Object.freeze([
  'WORKSPACE_FS_ENABLED',
  'WORKSPACE_SHELL_ENABLED',
  'WORKSPACE_GIT_ENABLED',
  'WORKSPACE_GIT_MUTATION_ENABLED',
])

function normalizeRuntimeConfigValue(key, value, filePath) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`runtime config key must be uppercase env style: ${key} (${filePath})`)
  }
  if (SENSITIVE_CONFIG_KEY.test(key)) {
    throw new Error(`sensitive runtime config key is not allowed in JSON: ${key} (${filePath})`)
  }
  if (value == null) return ''
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value)
  throw new Error(`runtime config value must be a scalar: ${key} (${filePath})`)
}

export function readRuntimeConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {}
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`runtime config is not a regular file: ${filePath}`)
  if (stat.size > MAX_RUNTIME_CONFIG_BYTES) {
    throw new Error(`runtime config exceeds ${MAX_RUNTIME_CONFIG_BYTES} bytes: ${filePath}`)
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const values = parsed?.env ?? parsed
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`runtime config must be a JSON object: ${filePath}`)
  }
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, normalizeRuntimeConfigValue(key, value, filePath)]),
  )
}

export function resolveRuntimeConfigPaths({ cwd = process.cwd(), env = process.env } = {}) {
  const dataDir = path.resolve(env.APP_DATA_DIR || path.join(cwd, 'server-data'))
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
        `[env] 未找到 ${envPath} —— 模型配置将只从系统环境变量读取。`
        + '\n[env] 如果你已经写了 .env，请确认是从**仓库根目录**启动服务（npm run serve）。',
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

function readRuntimeConfigDocument(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { env: {}, onboarding: {} }
  // Reuse the strict validation (size, shape, key names and secret rejection)
  // before preserving optional non-env metadata.
  const validatedEnv = readRuntimeConfigFile(filePath)
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return {
    env: validatedEnv,
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

export function applyRuntimeConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const resolved = getRuntimeEnv(env, { cwd })
  for (const [key, value] of Object.entries(resolved)) {
    if (env[key] === undefined) process.env[key] = String(value)
  }
  return resolved
}
