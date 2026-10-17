#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createDesktopSmokeEnvironment } from './smoke-test-desktop-package.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), '..')

function validateRoots({ runRoot, projectRoot, port }) {
  if (typeof runRoot !== 'string' || !path.isAbsolute(runRoot)
    || typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new TypeError('Isolated web roots must be explicit absolute paths')
  }
  const relative = path.relative(projectRoot, runRoot)
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new TypeError('Isolated web run root must be outside the project')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Isolated web port must be between 1 and 65535')
  }
}

/** A child-only environment: never mutate the caller or reuse user configuration. */
export function createIsolatedWebEnvironment({ sourceEnv = process.env, runRoot, projectRoot, port } = {}) {
  validateRoots({ runRoot, projectRoot, port })
  const env = createDesktopSmokeEnvironment({ sourceEnv, smokeRoot: runRoot, appOutDir: projectRoot, port })
  const home = path.join(runRoot, 'home')
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HOMEDRIVE
  delete env.HOMEPATH
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    ...(process.platform === 'win32' ? {
      HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''),
      HOMEPATH: home.slice(path.parse(home).root.length - 1),
      USERNAME: 'isolated', USERDOMAIN: 'isolated', LOGONSERVER: 'isolated',
    } : {}),
    GUGO_HOME: path.join(home, '.gugo'),
    APPDATA: path.join(runRoot, 'appdata'),
    LOCALAPPDATA: path.join(runRoot, 'localappdata'),
    XDG_CONFIG_HOME: path.join(runRoot, 'xdg-config'),
    XDG_CACHE_HOME: path.join(runRoot, 'xdg-cache'),
    AUTH_MODE: 'local',
    npm_config_cache: path.join(runRoot, 'npm-cache'),
    npm_config_userconfig: path.join(runRoot, 'empty-user.npmrc'),
    npm_config_globalconfig: path.join(runRoot, 'empty-global.npmrc'),
    npm_config_update_notifier: 'false',
  }
}

/** Build/preview only: preview never initializes the app's backend runtime. */
export function createIsolatedWebViteOptions({ runRoot, projectRoot, port } = {}) {
  validateRoots({ runRoot, projectRoot, port })
  return {
    configFile: path.join(projectRoot, 'vite.config.js'),
    configLoader: 'native',
    envDir: false,
    cacheDir: path.join(runRoot, 'vite-cache'),
    build: { outDir: path.join(runRoot, 'dist'), emptyOutDir: true },
    preview: { host: '127.0.0.1', port, strictPort: true, open: false },
  }
}

function prepareDirectories(env) {
  for (const key of [
    'HOME', 'GUGO_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'APP_DATA_DIR', 'ARTIFACT_DIR', 'WORKSPACE_ROOT', 'TEMP', 'npm_config_cache',
  ]) mkdirSync(env[key], { recursive: true })
}

async function runWorker({ mode, runRoot, port }) {
  const { build, preview } = await import('vite')
  const options = createIsolatedWebViteOptions({ runRoot, projectRoot: defaultProjectRoot, port })
  await build(options)
  console.log(`[isolated-web] build ready: ${options.build.outDir}`)
  if (mode !== 'preview') return
  const server = await preview(options)
  console.log(`[isolated-web] preview ready: http://127.0.0.1:${port}`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await server.close()
    process.exitCode = 0
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

async function receiveWorkerRequest(args) {
  if (args.length !== 1 || !process.send || !process.connected) {
    throw new TypeError('Isolated web worker requires parent IPC; use --build or --preview')
  }
  const request = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Isolated web parent handshake timed out')), 10_000)
    const onDisconnect = () => finish(new Error('Isolated web parent disconnected'))
    const onMessage = message => finish(null, message)
    function finish(error, message) {
      clearTimeout(timer)
      process.removeListener('disconnect', onDisconnect)
      process.removeListener('message', onMessage)
      if (error) reject(error)
      else resolve(message)
    }
    process.once('disconnect', onDisconnect)
    process.once('message', onMessage)
  })
  process.disconnect()
  const { mode, runRoot, port } = request || {}
  if (!['build', 'preview'].includes(mode)) throw new TypeError('Unknown isolated web worker mode')
  const expected = createIsolatedWebEnvironment({ runRoot, projectRoot: defaultProjectRoot, port })
  const normalize = env => {
    const result = Object.create(null)
    for (const [key, value] of Object.entries(env)) {
      const name = process.platform === 'win32' ? key.toUpperCase() : key
      if (Object.hasOwn(result, name)) throw new TypeError('Isolated web environment has duplicate keys')
      result[name] = value
    }
    return result
  }
  const actual = normalize(process.env)
  const normalized = normalize(expected)
  const mismatches = [...new Set([...Object.keys(actual), ...Object.keys(normalized)])]
    .filter(key => actual[key] !== normalized[key])
  if (path.resolve(process.cwd()) !== defaultProjectRoot || mismatches.length) {
    throw new TypeError(`Isolated web worker environment or cwd is not isolated (keys: ${mismatches.join(', ')})`)
  }
  return { mode, runRoot, port }
}

async function main(args) {
  if (args[0] === '--internal-worker') {
    await runWorker(await receiveWorkerRequest(args))
    return
  }
  const flags = [...args]
  const mode = flags[0] === '--preview' ? 'preview' : 'build'
  if (flags[0] === '--build' || flags[0] === '--preview') flags.shift()
  if (flags.length && (flags.length !== 2 || flags[0] !== '--port' || !/^\d+$/.test(flags[1]))) {
    throw new TypeError('Usage: verify-isolated-web.mjs [--build|--preview] [--port 5179]')
  }
  const port = flags.length ? Number(flags[1]) : 5179
  validateRoots({ runRoot: tmpdir(), projectRoot: defaultProjectRoot, port })
  const runRoot = mkdtempSync(path.join(tmpdir(), 'gugo-isolated-web-'))
  const env = createIsolatedWebEnvironment({ runRoot, projectRoot: defaultProjectRoot, port })
  prepareDirectories(env)
  console.log(`[isolated-web] temporary roots: ${runRoot}`)
  console.log('[isolated-web] no backend, model provider, MCP or user configuration is started')
  const child = spawn(process.execPath, [scriptPath, '--internal-worker'], {
    // Tailwind discovers its config/content from cwd; keep it anchored to the
    // checkout while every mutable/user path and dotenv lookup stays isolated.
    cwd: defaultProjectRoot, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
  })
  child.once('spawn', () => child.send({ mode, runRoot, port }, error => {
    if (error) child.kill('SIGTERM')
  }))
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM') }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
  })
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  process.exitCode = code
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[isolated-web] ${error.message}`)
    process.exitCode = 1
  })
}
