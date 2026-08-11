#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const require = createRequire(import.meta.url)

export const WINDOWS_MEDIA_SIDECARS = Object.freeze([
  Object.freeze({
    name: 'ffmpeg',
    envName: 'GUGO_FFMPEG_PATH',
    fileName: 'ffmpeg.exe',
    packageName: '@ffmpeg-installer/ffmpeg',
  }),
  Object.freeze({
    name: 'ffprobe',
    envName: 'GUGO_FFPROBE_PATH',
    fileName: 'ffprobe.exe',
    packageName: '@ffprobe-installer/ffprobe',
  }),
])

function actualExecutablePath(candidate) {
  if (!candidate) return null
  try {
    const resolved = path.resolve(String(candidate))
    const realPath = typeof fs.realpathSync.native === 'function'
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved)
    return fs.statSync(realPath).isFile() ? realPath : null
  } catch {
    return null
  }
}

function pathExtensions(command, platform, env) {
  if (platform !== 'win32' || path.extname(command)) return ['']
  const configured = String(env.PATHEXT || '.EXE;.COM')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => /^\.(?:exe|com)$/i.test(item))
  return configured.length ? configured : ['.EXE', '.COM']
}

function findOnPath(command, { env, platform }) {
  const raw = String(command || '').trim().replace(/^"|"$/g, '')
  if (!raw) return null
  if (path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\')) {
    return actualExecutablePath(raw)
  }

  const pathValue = env.PATH || env.Path || ''
  const delimiter = platform === 'win32' ? ';' : path.delimiter
  for (const entry of pathValue.split(delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (!directory) continue
    for (const extension of pathExtensions(raw, platform, env)) {
      const candidate = path.join(directory, `${raw}${extension}`)
      const actual = actualExecutablePath(candidate)
      if (actual) return actual
    }
  }
  return null
}

export function resolveLockedMediaSidecar({
  packageName,
  platform = process.platform,
} = {}) {
  // npm only installs the optional binary package for the host platform. Do
  // not mistake a Linux/macOS wrapper path for a Windows release sidecar when
  // tests emulate win32 on another host.
  if (!packageName || platform !== process.platform) return null
  try {
    const wrapper = require(packageName)
    return actualExecutablePath(wrapper?.path)
  } catch {
    return null
  }
}

function verifySidecar(candidate, name, { env, platform }) {
  const result = spawnSync(candidate, ['-version'], {
    encoding: 'utf8',
    env,
    shell: false,
    timeout: 15_000,
    windowsHide: true,
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (result.error || result.status !== 0 || !new RegExp(`^${name} version\\s`, 'mi').test(output)) {
    const detail = result.error?.message || output.trim() || `exit code ${result.status}`
    throw new Error(`${candidate} is not a working ${name} executable: ${detail}`)
  }
}

function atomicCopy(source, target) {
  const temporary = `${target}.${process.pid}.tmp`
  try {
    fs.copyFileSync(source, temporary)
    fs.rmSync(target, { force: true })
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function stageMediaSidecars({
  env = process.env,
  platform = process.platform,
  rootDir = repositoryRoot,
  lockedResolver = resolveLockedMediaSidecar,
  verify = verifySidecar,
  copy = atomicCopy,
} = {}) {
  if (platform !== 'win32') {
    throw new Error('Windows desktop media sidecars must be staged on Windows.')
  }

  const targetDirectory = path.join(rootDir, 'resources', 'bin')
  const plans = WINDOWS_MEDIA_SIDECARS.map(({ name, envName, fileName, packageName }) => {
    const target = path.join(targetDirectory, fileName)
    const configured = String(env[envName] || '').trim()
    if (configured) {
      const source = findOnPath(configured, { env, platform })
      if (!source) {
        throw new Error(`${envName} does not resolve to a working Windows executable: ${configured}`)
      }
      return { name, source, sourceType: 'environment', target, packageName }
    }

    const lockedCandidate = typeof lockedResolver === 'function'
      ? lockedResolver({ name, envName, fileName, packageName, env, platform, rootDir })
      : null
    const lockedSource = actualExecutablePath(lockedCandidate)
    if (lockedSource) {
      return { name, source: lockedSource, sourceType: 'locked-dependency', target, packageName }
    }

    const cachedSource = actualExecutablePath(target)
    if (cachedSource) {
      return { name, source: cachedSource, sourceType: 'resources-cache', target, packageName }
    }

    const pathSource = findOnPath(fileName, { env, platform }) || findOnPath(name, { env, platform })
    if (pathSource) {
      return { name, source: pathSource, sourceType: 'path-fallback', target, packageName }
    }

    throw new Error(
      `${name} was not found in locked dependency ${packageName}, resources/bin, or PATH. `
      + `Run npm ci or set ${envName} to its absolute Windows executable path.`,
    )
  })

  // Resolve and verify every source before mutating resources/bin. A missing
  // required sidecar therefore fails closed without a partially staged pair.
  for (const { name, source } of plans) verify(source, name, { env, platform })
  fs.mkdirSync(targetDirectory, { recursive: true })

  return plans.map(({ name, source, sourceType, target, packageName }) => {
    if (path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()) {
      copy(source, target)
      verify(target, name, { env, platform })
    }
    return { name, source, sourceType, target, packageName }
  })
}

if (path.resolve(process.argv[1] || '') === path.resolve(scriptPath)) {
  try {
    const staged = stageMediaSidecars()
    for (const item of staged) {
      console.log(`[media-sidecar] ${item.name} (${item.sourceType}): ${item.target}`)
    }
  } catch (error) {
    console.error(`[media-sidecar] ${error?.message || error}`)
    process.exitCode = 1
  }
}
