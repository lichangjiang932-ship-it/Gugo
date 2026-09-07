import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 60_000
const SMOKE_INHERITED_ENVIRONMENT_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'OS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE',
])

export function createDesktopSmokeEnvironment({
  sourceEnv = process.env,
  smokeRoot,
  appOutDir,
  port,
} = {}) {
  if (typeof smokeRoot !== 'string' || !path.isAbsolute(smokeRoot)
    || typeof appOutDir !== 'string' || !path.isAbsolute(appOutDir)) {
    throw new TypeError('Desktop smoke roots must be explicit absolute paths')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Desktop smoke port must be between 1 and 65535')
  }
  const resolvedSmokeRoot = path.resolve(smokeRoot)
  const resolvedAppOutDir = path.resolve(appOutDir)
  // Never copy deployment configuration or startup hooks into the smoke child.
  // Canonical keys also prevent Windows case aliases from overriding isolation.
  const inherited = Object.fromEntries(Object.entries(sourceEnv)
    .filter(([key, value]) => SMOKE_INHERITED_ENVIRONMENT_KEYS.has(key.toUpperCase())
      && typeof value === 'string')
    .map(([key, value]) => [key.toUpperCase(), value]))
  return {
    ...inherited,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    GUGO_LOAD_DOTENV: '0',
    GUGO_PURE_LOCAL_MODE: '1',
    GUGO_SQLITE_DRIVER: 'node',
    SERVER_HOST: LOOPBACK_HOST,
    SERVER_PORT: String(port),
    APP_DATA_DIR: resolvedSmokeRoot,
    APP_DB_PATH: path.join(resolvedSmokeRoot, 'app.db'),
    APP_CONFIG_PATH: path.join(resolvedSmokeRoot, 'runtime.json'),
    ARTIFACT_DIR: path.join(resolvedSmokeRoot, 'artifacts'),
    WORKSPACE_ROOT: path.join(resolvedSmokeRoot, 'workspace'),
    TEMP: path.join(resolvedSmokeRoot, 'tmp'),
    TMP: path.join(resolvedSmokeRoot, 'tmp'),
    TMPDIR: path.join(resolvedSmokeRoot, 'tmp'),
    CODEX_PLUGIN_ROOTS: '[]',
    CODEX_APP_SERVER_ENABLED: '0',
    MCP_STDIO_ENABLED: '0',
    GUGO_FFMPEG_PATH: path.join(resolvedAppOutDir, 'resources', 'bin', 'ffmpeg.exe'),
    GUGO_FFPROBE_PATH: path.join(resolvedAppOutDir, 'resources', 'bin', 'ffprobe.exe'),
  }
}

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      const address = server.address()
      server.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

function appendLog(current, chunk) {
  return `${current}${String(chunk)}`.slice(-8_000)
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(5_000, false),
  ])
  if (!exited && child.exitCode === null) child.kill('SIGKILL')
}

export async function smokeTestDesktopPackage({
  appOutDir = path.join('release', 'win-unpacked'),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Desktop package smoke test requires Windows')
  }

  const resolvedAppOutDir = path.resolve(appOutDir)
  const executablePath = path.join(resolvedAppOutDir, 'Gugo.exe')
  const asarPath = path.join(resolvedAppOutDir, 'resources', 'app.asar')
  await Promise.all([fs.access(executablePath), fs.access(asarPath)])

  const tempBase = path.resolve(os.tmpdir())
  const smokeRoot = await fs.mkdtemp(path.join(tempBase, 'gugo-desktop-smoke-'))
  const artifactsDir = path.join(smokeRoot, 'artifacts')
  const workspaceRoot = path.join(smokeRoot, 'workspace')
  const temporaryDir = path.join(smokeRoot, 'tmp')
  await Promise.all([
    fs.mkdir(artifactsDir, { recursive: true }),
    fs.mkdir(workspaceRoot, { recursive: true }),
    fs.mkdir(temporaryDir, { recursive: true }),
  ])

  const port = await reserveFreePort()
  const origin = `http://${LOOPBACK_HOST}:${port}`
  const entryPath = path.join(asarPath, 'server', 'start.js')
  const env = createDesktopSmokeEnvironment({ smokeRoot, appOutDir: resolvedAppOutDir, port })

  let stdout = ''
  let stderr = ''
  let spawnError = null
  const child = spawn(executablePath, [entryPath], {
    cwd: resolvedAppOutDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => { stdout = appendLog(stdout, chunk) })
  child.stderr?.on('data', (chunk) => { stderr = appendLog(stderr, chunk) })
  child.once('error', (error) => { spawnError = error })

  try {
    const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null) {
        throw new Error(`Packaged desktop backend exited with code ${child.exitCode}.\n${stderr || stdout}`)
      }
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_500) })
        if (response.ok) {
          const body = await response.text()
          console.log(`[desktop-smoke] packaged backend healthy at ${origin}: ${body}`)
          return { origin, body }
        }
      } catch (error) {
        if (error?.name !== 'TimeoutError' && error?.name !== 'TypeError') throw error
      }
      await delay(250)
    }
    throw new Error(`Packaged desktop backend did not become healthy within ${timeoutMs}ms.\n${stderr || stdout}`)
  } finally {
    await stopChild(child)
    const resolvedSmokeRoot = path.resolve(smokeRoot)
    if (resolvedSmokeRoot.startsWith(`${tempBase}${path.sep}`)) {
      await fs.rm(resolvedSmokeRoot, { recursive: true, force: true })
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  smokeTestDesktopPackage({ appOutDir: process.argv[2] })
    .catch((error) => {
      console.error(error?.stack || error)
      process.exitCode = 1
    })
}
