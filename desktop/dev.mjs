import path from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getRuntimeEnv } from '../server/utils/runtimeEnv.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const runtime = getRuntimeEnv()
const port = Number(runtime.VITE_DEV_PORT || runtime.SERVER_PORT || 5175)
const devUrl = `http://127.0.0.1:${port}/`
const viteEntry = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')
const electronBinary = process.platform === 'win32'
  ? path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron')
const desktopEnv = { ...process.env, YMA_DESKTOP_DEV_URL: devUrl }
const ffmpegSidecar = path.join(rootDir, 'resources', 'bin', 'ffmpeg.exe')
const ffprobeSidecar = path.join(rootDir, 'resources', 'bin', 'ffprobe.exe')
if (!desktopEnv.GUGO_FFMPEG_PATH && existsSync(ffmpegSidecar)) desktopEnv.GUGO_FFMPEG_PATH = ffmpegSidecar
if (!desktopEnv.GUGO_FFPROBE_PATH && existsSync(ffprobeSidecar)) desktopEnv.GUGO_FFPROBE_PATH = ffprobeSidecar

const children = new Set()
let stopping = false

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    ...options,
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

function stopAll() {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/health', url), {
        signal: AbortSignal.timeout(1_500),
      })
      if (response.ok) return
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Vite 未能在 ${timeoutMs}ms 内启动：${url}`)
}

process.once('SIGINT', stopAll)
process.once('SIGTERM', stopAll)
process.once('exit', stopAll)

try {
  const vite = start(process.execPath, [viteEntry, '--configLoader', 'runner'])
  await Promise.race([
    waitForServer(devUrl),
    new Promise((_, reject) => vite.once('error', reject)),
  ])

  const electron = start(electronBinary, ['.'], {
    env: desktopEnv,
  })
  const [code] = await onceExit(electron)
  stopAll()
  process.exitCode = code ?? 0
} catch (error) {
  stopAll()
  console.error('[desktop:dev]', error?.stack || error)
  process.exitCode = 1
}

function onceExit(child) {
  return new Promise((resolve, reject) => {
    child.once('exit', (...args) => resolve(args))
    child.once('error', reject)
  })
}
