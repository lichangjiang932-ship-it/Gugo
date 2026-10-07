import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `.gugo/launch.json` — how to start the app under development, if the project
 * declares it. Nothing here is mandatory: a repository without the file simply
 * has no preview server, and the tools report that instead of inventing one.
 *
 * Two shapes are accepted, matching Claude Code's file: a `runtimeExecutable`
 * (npm/yarn/node) with `runtimeArgs`, or a `program` run by node with `args`.
 */
export const LAUNCH_FILE = join('.gugo', 'launch.json')
export const DEFAULT_PORT = 3000
export const DEFAULT_READY_PATTERN = 'ready'
export const LAUNCH_VERSION = '0.0.1'

function asString(value, fallback = '') {
  const text = String(value ?? '').trim()
  return text || fallback
}

function asArgs(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

function asEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [String(key), String(entry)]))
}

export function substituteWorkspace(value, workspacePath) {
  return String(value ?? '').replace(/\$\{workspaceFolder\}/gu, workspacePath)
}

/** Normalize one configuration entry; returns null when it cannot run. */
export function normalizePreviewConfiguration(entry = {}, { workspacePath = '' } = {}) {
  const name = asString(entry.name)
  if (!name) return null
  const runtimeExecutable = substituteWorkspace(entry.runtimeExecutable, workspacePath)
  const program = substituteWorkspace(entry.program, workspacePath)
  if (!runtimeExecutable && !program) return null
  const port = Number(entry.port)
  const normalizedPort = Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_PORT
  return {
    name,
    runtimeExecutable,
    runtimeArgs: asArgs(entry.runtimeArgs),
    program,
    args: asArgs(entry.args),
    cwd: substituteWorkspace(entry.cwd, workspacePath) || workspacePath,
    env: asEnv(entry.env),
    port: normalizedPort,
    autoPort: entry.autoPort === true,
    readyPattern: asString(entry.readyPattern, DEFAULT_READY_PATTERN),
    url: asString(entry.url),
    persistCookies: entry.persistCookies === true,
  }
}

export function previewUrlFor(configuration = {}) {
  const explicit = asString(configuration.url)
  if (explicit) return explicit
  return `http://localhost:${Number(configuration.port) || DEFAULT_PORT}`
}

/**
 * Read the file. `ok` says the file exists and at least one configuration
 * survives normalization; every failure carries a code the caller can show.
 */
export function readLaunchConfig(workspacePath, { fsExists = existsSync, readFile = readFileSync } = {}) {
  const path = join(workspacePath || '.', LAUNCH_FILE)
  if (!fsExists(path)) return { ok: false, code: 'PREVIEW_LAUNCH_MISSING', path, autoVerify: true, configurations: [] }
  try {
    const parsed = JSON.parse(readFile(path, 'utf8'))
    const configurations = (Array.isArray(parsed?.configurations) ? parsed.configurations : [])
      .map((entry) => normalizePreviewConfiguration(entry, { workspacePath }))
      .filter(Boolean)
    if (configurations.length === 0) return { ok: false, code: 'PREVIEW_LAUNCH_EMPTY', path, autoVerify: parsed?.autoVerify !== false, configurations: [] }
    return {
      ok: true,
      path,
      version: asString(parsed?.version, LAUNCH_VERSION),
      autoVerify: parsed?.autoVerify !== false,
      configurations,
    }
  } catch (error) {
    return { ok: false, code: 'PREVIEW_LAUNCH_INVALID', path, message: String(error?.message || error), autoVerify: true, configurations: [] }
  }
}

export function pickConfiguration(launch, name = '') {
  if (!launch?.ok) return null
  const wanted = asString(name)
  if (!wanted) return launch.configurations[0]
  return launch.configurations.find((entry) => entry.name === wanted) || null
}

/** An IPv4/IPv6 port that is free right now; the caller retries on a race. */
export async function findFreePort(startPort, { createServer = defaultCreateServer, attempts = 50 } = {}) {
  const net = await import('node:net')
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = Number(startPort) + offset
    const free = await new Promise((resolve) => {
      const server = net.createServer()
      server.unref()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  void createServer
  return null
}

function defaultCreateServer() {
  throw new Error('not used')
}
