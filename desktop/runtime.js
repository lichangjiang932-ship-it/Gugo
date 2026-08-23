import fs from 'node:fs'
import path from 'node:path'
import {
  RUNTIME_CONFIG_RECOVERY_MODE,
  RUNTIME_CONFIG_RECOVERY_PROTOCOL_VERSION,
} from '../shared/runtimeConfigRecoveryProtocol.js'

export const DEFAULT_DESKTOP_PORT = 5180
export const DESKTOP_RUNTIME_RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000])

const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))

async function readJsonResponse(response) {
  if (!response?.ok
    || !String(response.headers?.get?.('content-type') || '').toLowerCase().includes('application/json')) {
    return null
  }
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function probeJson(origin, pathname, { fetchImpl, timeoutMs }) {
  try {
    const base = String(origin || '').replace(/\/$/u, '')
    return readJsonResponse(await fetchImpl(`${base}${pathname}`, {
      signal: AbortSignal.timeout(timeoutMs),
    }))
  } catch {
    return null
  }
}

export async function probeDesktopRuntimeMode(origin, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 1_500,
} = {}) {
  if (typeof fetchImpl !== 'function') return null
  const runtime = await probeJson(origin, '/api/health', { fetchImpl, timeoutMs })
  if (runtime?.ok === true) return 'runtime'

  const recovery = await probeJson(origin, '/api/recovery/status', { fetchImpl, timeoutMs })
  if (recovery?.ok === true
    && recovery.mode === RUNTIME_CONFIG_RECOVERY_MODE
    && recovery.protocolVersion === RUNTIME_CONFIG_RECOVERY_PROTOCOL_VERSION
    && recovery.restartRequired === true) {
    return 'recovery'
  }
  return null
}

/**
 * electron-updater may briefly replace the installed executable while NSIS is
 * completing an update. Treat that window as recoverable, but fail with a
 * user-facing error when the executable or bundled server really is missing.
 */
export async function waitForDesktopRuntimeFiles({
  executablePath,
  entryPath,
  existsSync = fs.existsSync,
  delays = DESKTOP_RUNTIME_RETRY_DELAYS_MS,
  sleep: wait = sleep,
} = {}) {
  const required = [
    ['executable', executablePath],
    ['server entry', entryPath],
  ].filter(([, candidate]) => typeof candidate === 'string' && candidate.trim())

  let missing = []
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    missing = required.filter(([, candidate]) => !existsSync(candidate))
    if (missing.length === 0) return { executablePath, entryPath }
    if (attempt === delays.length) break
    await wait(Math.max(0, Number(delays[attempt]) || 0))
  }

  const missingPaths = missing.map(([, candidate]) => candidate)
  const error = new Error(`Gugo 安装文件不完整，缺少：${missingPaths.join('；')}。请重新安装或修复 Gugo。`)
  error.code = 'ENOENT'
  error.missingPaths = missingPaths
  throw error
}

export function resolveDesktopPort(value) {
  const port = Number(value ?? DEFAULT_DESKTOP_PORT)
  return Number.isInteger(port) && port >= 1024 && port <= 65_535
    ? port
    : DEFAULT_DESKTOP_PORT
}

export function resolveDesktopDataPaths(userData) {
  const dataDir = path.resolve(String(userData || ''), 'server-data')
  return {
    dataDir,
    database: path.join(dataDir, 'app.db'),
    artifacts: path.join(dataDir, 'artifacts'),
  }
}

export function resolveDesktopRuntimeConfigPath(userData) {
  const basePath = String(userData || '').trim()
  if (!basePath) throw new TypeError('desktop user data path is required')
  return path.join(resolveDesktopDataPaths(basePath).dataDir, 'runtime.json')
}

export function ensureDesktopRuntimeConfigFile({
  userData,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
  lstatSync = fs.lstatSync,
} = {}) {
  const configPath = resolveDesktopRuntimeConfigPath(userData)
  mkdirSync(path.dirname(configPath), { recursive: true })
  try {
    writeFileSync(configPath, '{\n  "env": {}\n}\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  const stat = lstatSync(configPath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error('desktop runtime config must be a regular file')
    error.code = 'INVALID_RUNTIME_CONFIG_FILE'
    throw error
  }
  return configPath
}

function parseConfiguredRoots(value, delimiter = path.delimiter) {
  const input = String(value || '').trim()
  if (!input) return []
  if (input.startsWith('[')) {
    try {
      const parsed = JSON.parse(input)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      // Fall through to platform-delimited roots.
    }
  }
  return input.split(delimiter)
}

export function resolveDesktopPluginRoots({
  configured,
  appPath,
  resourcesPath,
  userData,
  homeDir,
  documentsDir,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const candidates = [
    ...parseConfiguredRoots(configured),
    appPath && path.join(appPath, 'codex-plugins'),
    resourcesPath && path.join(resourcesPath, 'codex-plugins'),
    userData && path.join(userData, 'codex-plugins'),
    homeDir && path.join(homeDir, 'codex-plugins'),
    documentsDir && path.join(documentsDir, 'codex-plugins'),
  ]

  // Probe only common exact workspace paths; never crawl a drive or execute
  // plugin code during discovery.
  if (platform === 'win32') {
    for (const drive of ['C', 'D', 'E', 'F']) {
      candidates.push(`${drive}:\\destok\\codex-plugins`)
    }
  }

  const seen = new Set()
  return candidates.filter(Boolean).map((candidate) => path.resolve(String(candidate).trim())).filter((candidate) => {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key) || !existsSync(candidate)) return false
    seen.add(key)
    return true
  })
}
