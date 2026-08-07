import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_DESKTOP_PORT = 5180
export const DESKTOP_RUNTIME_RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000])

const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))

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
