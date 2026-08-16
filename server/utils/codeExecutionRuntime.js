import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const PYTHON_CONFIG_KEY = 'CODE_EXECUTION_PYTHON'
const PROBE_TIMEOUT_MS = 4_000
const NULL_OUTPUT_TARGET = /^(?:\/dev\/null|(?:\\\\\.\\)?nul:?|\$null)$/i

let cachedRuntime = null
let cachedRuntimeKey = null

function unquotePairedTarget(value) {
  let target = String(value || '').trim()
  if ((target.startsWith('"') && target.endsWith('"'))
    || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1).trim()
  }
  return target
}

function isNullOutputTarget(value, platform = process.platform) {
  const target = unquotePairedTarget(value)
  // A dangling wrapper quote may survive a caller's shell parsing. Use the
  // stripped form only for device detection; preserve it for ordinary paths.
  const candidate = target.replace(/^["']+|["']+$/g, '').trim()
  if (NULL_OUTPUT_TARGET.test(candidate)) return true
  if (platform !== 'win32') return false
  const filename = candidate.replace(/\\/g, '/').split('/').at(-1) || ''
  // Win32 device names remain devices with a colon or extension and inside a
  // directory (for example NUL:, NUL.txt, or .\\NUL).
  return /^nul(?::|\..*)?$/i.test(filename)
}

function normalizedOutputTarget(value, platform = process.platform) {
  const target = unquotePairedTarget(value)
  if (!target || /^&\d+$/.test(target)) return ''
  return isNullOutputTarget(target, platform) ? '' : target
}

function inlinePythonSource(command) {
  const source = String(command || '').trim()
  const match = source.match(/^(?:(?:"[^"]*(?:python(?:3)?|py)(?:\.exe)?")|(?:[^\s"]*[\\/])?(?:python(?:3)?|py)(?:\.exe)?)(?:\s+(?!-c\b)-[^\s]+)*\s+-c\s+([\s\S]+)$/i)
  if (!match) return ''
  const rawCode = String(match[1] || '').trim()
  const quote = rawCode[0]
  if (!['"', "'"].includes(quote) || rawCode.at(-1) !== quote) return ''
  return rawCode.slice(1, -1)
}

/**
 * Infer only literal output paths that can be snapshotted safely. These are
 * hints, not success evidence: bash_exec still compares each target before
 * and after the process and reports it only when the filesystem really
 * changed.
 */
export function inferCodeExecutionOutputPaths(command, { platform = process.platform } = {}) {
  const targets = new Set()
  const add = (value) => {
    const target = normalizedOutputTarget(value, platform)
    if (target) targets.add(target)
  }
  const source = String(command || '')

  const redirection = /\d?>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))/g
  for (const match of source.matchAll(redirection)) add(match[1] || match[2] || match[3])

  const python = inlinePythonSource(source)
  if (!python) return [...targets]

  const writeMode = (value) => /[wax+]/i.test(String(value || ''))
  const openWriters = [
    /\bopen\s*\(\s*(?:file\s*=\s*)?[rRuUbB]{0,2}'([^'\r\n]+)'\s*,\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}'([^'\r\n]+)'/g,
    /\bopen\s*\(\s*(?:file\s*=\s*)?[rRuUbB]{0,2}"([^"\r\n]+)"\s*,\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}"([^"\r\n]+)"/g,
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}'([^'\r\n]+)'\s*\)\s*\.open\s*\(\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}'([^'\r\n]+)'/g,
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}"([^"\r\n]+)"\s*\)\s*\.open\s*\(\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}"([^"\r\n]+)"/g,
  ]
  for (const pattern of openWriters) {
    for (const match of python.matchAll(pattern)) {
      if (writeMode(match[2])) add(match[1])
    }
  }

  const directWriters = [
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}'([^'\r\n]+)'\s*\)\s*\.(?:write_text|write_bytes|touch)\s*\(/g,
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}"([^"\r\n]+)"\s*\)\s*\.(?:write_text|write_bytes|touch)\s*\(/g,
  ]
  for (const pattern of directWriters) {
    for (const match of python.matchAll(pattern)) add(match[1])
  }

  return [...targets]
}

export function codeExecutionFailureHint(command, {
  platform = process.platform,
  stderr = '',
} = {}) {
  if (platform !== 'win32') return ''

  const source = String(command || '')
  const errorText = String(stderr || '')
  const isInlinePython = /(?:^|[\s"'])(?:python(?:3)?|py)(?:\.exe)?\b[\s\S]*?\s-c(?:\s|$)/i.test(source)
  const isFragileInlineScript = isInlinePython
    && (source.length >= 600 || /(?:\r|\n|\\[rn])/.test(source))
  if (isFragileInlineScript) {
    return 'Windows uses cmd.exe. Do not retry a long or multiline Python program through python -c. Use write_file to save a UTF-8 .py script inside the authorized directory, then run python "script.py" with bash_exec and declare only the final generated files in expected_outputs.'
  }

  const unixPipeline = /\|\s*(?:tail|head|grep|sed|awk)\b/i.test(source)
  const missingUnixCommand = /(?:tail|head|grep|sed|awk).{0,80}(?:not recognized|not found)/i.test(errorText)
  if (unixPipeline || missingUnixCommand) {
    return 'Windows bash_exec runs cmd.exe, so Unix-only pipeline commands such as tail, grep, sed, and awk are not portable. Use a native cmd command or powershell -NoProfile -Command instead.'
  }

  return ''
}

function pathDelimiter(platform) {
  return platform === 'win32' ? ';' : ':'
}

function pathKey(env, platform) {
  const keys = Object.keys(env || {}).filter((key) => key.toLowerCase() === 'path')
  if (platform === 'win32') {
    return keys.find((key) => key === 'Path') || keys.find((key) => key === 'PATH') || keys[0] || 'Path'
  }
  return keys.find((key) => key === 'PATH') || keys[0] || 'PATH'
}

function cleanPathEntry(value) {
  const entry = String(value || '').trim()
  if (entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')) return entry.slice(1, -1)
  return entry
}

function pathEntries(env, platform) {
  const key = pathKey(env, platform)
  return String(env?.[key] || '')
    .split(pathDelimiter(platform))
    .map(cleanPathEntry)
    .filter(Boolean)
}

function dedupePaths(entries, platform) {
  const seen = new Set()
  const result = []
  for (const entry of entries) {
    if (!entry) continue
    const normalized = path.normalize(entry)
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function executableCandidates(directory, platform) {
  const names = platform === 'win32'
    ? ['python.exe', 'python3.exe']
    : ['python3', 'python']
  return names.map((name) => path.join(directory, name))
}

function pipCandidates(pythonPath, platform) {
  const pythonDirectory = path.dirname(pythonPath)
  if (platform === 'win32') {
    const scriptsDirectory = path.basename(pythonDirectory).toLowerCase() === 'scripts'
      ? pythonDirectory
      : path.join(pythonDirectory, 'Scripts')
    return [
      path.join(scriptsDirectory, 'pip.exe'),
      path.join(scriptsDirectory, 'pip3.exe'),
      path.join(pythonDirectory, 'pip.exe'),
      path.join(pythonDirectory, 'pip3.exe'),
    ]
  }
  return [path.join(pythonDirectory, 'pip'), path.join(pythonDirectory, 'pip3')]
}

function resolveExplicitPython(rawValue, { env, platform, exists }) {
  const configured = cleanPathEntry(rawValue)
  if (!configured) return null
  if (path.isAbsolute(configured)) return exists(configured) ? path.normalize(configured) : null

  for (const directory of pathEntries(env, platform)) {
    const candidate = path.join(directory, configured)
    if (exists(candidate)) return path.normalize(candidate)
    if (platform === 'win32' && !path.extname(configured)) {
      const executable = `${candidate}.exe`
      if (exists(executable)) return path.normalize(executable)
    }
  }
  return null
}

function discoverPythonCandidates({ env, platform, exists }) {
  const candidates = []
  const configured = resolveExplicitPython(env?.[PYTHON_CONFIG_KEY], { env, platform, exists })
  if (configured) candidates.push(configured)

  for (const directory of pathEntries(env, platform)) {
    candidates.push(...executableCandidates(directory, platform))
    if (platform === 'win32' && path.basename(directory).toLowerCase() === 'scripts') {
      candidates.push(...executableCandidates(path.dirname(directory), platform))
    }
  }

  return dedupePaths(candidates.filter((candidate) => exists(candidate)), platform)
}

function probePythonPip(pythonPath, { env, spawnSyncImpl }) {
  try {
    const result = spawnSyncImpl(pythonPath, ['-m', 'pip', '--version'], {
      env,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: 'ignore',
    })
    return !result.error && result.status === 0
  } catch {
    return false
  }
}

export function resolveCodeExecutionPython({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
  spawnSyncImpl = spawnSync,
} = {}) {
  const configured = cleanPathEntry(env?.[PYTHON_CONFIG_KEY])
  const candidates = discoverPythonCandidates({ env, platform, exists })

  for (const pythonPath of candidates) {
    const pipPath = pipCandidates(pythonPath, platform).find((candidate) => exists(candidate))
    if (!pipPath) continue
    if (!probePythonPip(pythonPath, { env, spawnSyncImpl })) continue
    return {
      pythonPath,
      pipPath: path.normalize(pipPath),
      configured: Boolean(configured && path.normalize(pythonPath) === path.normalize(resolveExplicitPython(
        configured,
        { env, platform, exists },
      ) || '')),
    }
  }

  return null
}

function runtimeCacheKey(env, platform) {
  const key = pathKey(env, platform)
  return [platform, env?.[PYTHON_CONFIG_KEY] || '', env?.[key] || ''].join('\0')
}

function resolveCachedRuntime(env, platform) {
  const key = runtimeCacheKey(env, platform)
  if (key !== cachedRuntimeKey) {
    cachedRuntimeKey = key
    cachedRuntime = resolveCodeExecutionPython({ env, platform })
  }
  return cachedRuntime
}

export function buildCodeExecutionEnv(
  baseEnv,
  { platform = process.platform, runtime = undefined } = {},
) {
  const env = { ...(baseEnv || {}) }
  const selected = runtime === undefined ? resolveCachedRuntime(env, platform) : runtime
  if (!selected?.pythonPath || !selected?.pipPath) return env

  const key = pathKey(env, platform)
  // Tests and remote runners may assemble an environment for a target OS
  // different from the host OS. Parse the selected runtime paths with the
  // target platform's path rules so Windows paths do not collapse to `.` on
  // Linux (and vice versa).
  const targetPath = platform === 'win32' ? path.win32 : path.posix
  const pythonDirectory = targetPath.dirname(selected.pythonPath)
  const pipDirectory = targetPath.dirname(selected.pipPath)
  const nextPath = dedupePaths(
    [pythonDirectory, pipDirectory, ...pathEntries(env, platform)],
    platform,
  ).join(pathDelimiter(platform))

  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === 'path' && existingKey !== key) delete env[existingKey]
  }
  env[key] = nextPath
  return env
}

export const _internals = {
  PYTHON_CONFIG_KEY,
  cleanPathEntry,
  dedupePaths,
  discoverPythonCandidates,
  pathEntries,
  pathKey,
  pipCandidates,
  isNullOutputTarget,
  normalizedOutputTarget,
}
