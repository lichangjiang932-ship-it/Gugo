import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_DESKTOP_PORT = 5180

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
