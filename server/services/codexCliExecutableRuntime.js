import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import {
  CODEX_APP_SERVER_REASON,
  DEFAULT_SIGNATURE_TIMEOUT_MS,
  DEFAULT_VERSION_TIMEOUT_MS,
  codexEnvValue,
  normalizeCodexStageTimeout,
} from './codexAppServerContracts.js'

const WINDOWS_SYSTEM_POWERSHELL_OBJECT_PATH = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`

const OPENAI_PUBLISHERS = new Set([
  'openaiopcollc',
  'openaillc',
])

function executableFile(candidate, platform = process.platform) {
  try {
    if (!fs.statSync(candidate).isFile()) return false
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  throw error
}

async function executableFileAsync(candidate, platform = process.platform, {
  signal = null,
  stat = fs.promises.stat,
  access = fs.promises.access,
} = {}) {
  try {
    throwIfAborted(signal)
    const metadata = await stat(candidate)
    throwIfAborted(signal)
    if (!metadata.isFile()) return false
    if (platform !== 'win32') {
      await access(candidate, fs.constants.X_OK)
      throwIfAborted(signal)
    }
    return true
  } catch {
    throwIfAborted(signal)
    return false
  }
}

function localWindowsAbsolutePath(candidate) {
  const raw = typeof candidate === 'string' ? candidate : ''
  if (!/^[A-Za-z]:[\\/]/u.test(raw) || raw.includes('\0')) return false
  // A second colon denotes an alternate data stream. UNC, device, GLOBALROOT,
  // and root-relative paths are excluded by requiring a drive-letter root.
  return !raw.slice(2).includes(':')
}

export function isNativeCodexExecutablePath(candidate, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32') {
    return localWindowsAbsolutePath(candidate)
      && pathApi.extname(candidate).toLowerCase() === '.exe'
  }
  return pathApi.isAbsolute(candidate)
}

function windowsPathIdentity(candidate) {
  return path.win32.normalize(candidate).replace(/[\\/]+$/u, '').toLowerCase()
}

function windowsPathInside(candidate, parent) {
  if (!localWindowsAbsolutePath(candidate) || !localWindowsAbsolutePath(parent)) return false
  const relative = path.win32.relative(parent, candidate)
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.win32.sep}`)
    && !path.win32.isAbsolute(relative)
}

function configuredCandidate(value, source, { platform, isExecutable }) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!isNativeCodexExecutablePath(raw, platform) || !isExecutable(raw)) {
    return Object.freeze({
      configured: true,
      found: false,
      path: null,
      source,
      reasonCode: CODEX_APP_SERVER_REASON.CLI_PATH_INVALID,
    })
  }
  return Object.freeze({
    configured: true,
    found: true,
    path: pathApi.normalize(raw),
    source,
    reasonCode: null,
  })
}

async function configuredCandidateAsync(value, source, {
  platform,
  isExecutable,
  signal,
}) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!isNativeCodexExecutablePath(raw, platform)) {
    return Object.freeze({
      configured: true,
      found: false,
      path: null,
      source,
      reasonCode: CODEX_APP_SERVER_REASON.CLI_PATH_INVALID,
    })
  }
  const available = await isExecutable(raw)
  throwIfAborted(signal)
  if (!available) {
    return Object.freeze({
      configured: true,
      found: false,
      path: null,
      source,
      reasonCode: CODEX_APP_SERVER_REASON.CLI_PATH_INVALID,
    })
  }
  return Object.freeze({
    configured: true,
    found: true,
    path: pathApi.normalize(raw),
    source,
    reasonCode: null,
  })
}

/**
 * Resolve only native Codex executables. Configured paths fail closed instead
 * of silently falling through to another binary with the same name.
 */
export function resolveCodexCliExecutable({
  explicitPath = '',
  env = process.env,
  platform = process.platform,
  isExecutable = (candidate) => executableFile(candidate, platform),
} = {}) {
  if (typeof isExecutable !== 'function') throw new TypeError('isExecutable must be a function')

  const candidates = [
    [explicitPath, 'explicit'],
    [codexEnvValue(env, 'GUGO_CODEX_CLI_PATH', platform), 'gugo-environment'],
    [codexEnvValue(env, 'CODEX_CLI_PATH', platform), 'codex-environment'],
  ]
  for (const [value, source] of candidates) {
    const resolved = configuredCandidate(value, source, { platform, isExecutable })
    if (resolved) return resolved
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32') {
    const localAppData = codexEnvValue(env, 'LOCALAPPDATA', platform).trim()
    if (localAppData && pathApi.isAbsolute(localAppData)) {
      const desktopCli = pathApi.join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe')
      if (isNativeCodexExecutablePath(desktopCli, platform) && isExecutable(desktopCli)) {
        return Object.freeze({
          configured: false,
          found: true,
          path: pathApi.normalize(desktopCli),
          source: 'desktop-install',
          reasonCode: null,
        })
      }
    }
  }

  const pathValue = codexEnvValue(env, 'PATH', platform)
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex'
  for (const entry of pathValue.split(pathApi.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/gu, '')
    if (!directory || !pathApi.isAbsolute(directory)) continue
    const candidate = pathApi.join(directory, executableName)
    if (!isNativeCodexExecutablePath(candidate, platform) || !isExecutable(candidate)) continue
    return Object.freeze({
      configured: false,
      found: true,
      path: pathApi.normalize(candidate),
      source: 'path',
      reasonCode: null,
    })
  }

  return Object.freeze({
    configured: false,
    found: false,
    path: null,
    source: null,
    reasonCode: CODEX_APP_SERVER_REASON.CLI_NOT_FOUND,
  })
}

/**
 * Asynchronous production discovery. Candidate order matches the synchronous
 * compatibility helper, while filesystem probes yield so lifecycle aborts can
 * be observed on wall-clock time.
 */
export async function resolveCodexCliExecutableAsync({
  explicitPath = '',
  env = process.env,
  platform = process.platform,
  signal = null,
  isExecutable = (candidate) => executableFileAsync(candidate, platform, { signal }),
} = {}) {
  if (typeof isExecutable !== 'function') throw new TypeError('isExecutable must be a function')
  throwIfAborted(signal)

  const candidates = [
    [explicitPath, 'explicit'],
    [codexEnvValue(env, 'GUGO_CODEX_CLI_PATH', platform), 'gugo-environment'],
    [codexEnvValue(env, 'CODEX_CLI_PATH', platform), 'codex-environment'],
  ]
  for (const [value, source] of candidates) {
    const resolved = await configuredCandidateAsync(value, source, {
      platform, isExecutable, signal,
    })
    if (resolved) return resolved
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32') {
    const localAppData = codexEnvValue(env, 'LOCALAPPDATA', platform).trim()
    if (localAppData && pathApi.isAbsolute(localAppData)) {
      const desktopCli = pathApi.join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe')
      if (isNativeCodexExecutablePath(desktopCli, platform)) {
        const available = await isExecutable(desktopCli)
        throwIfAborted(signal)
        if (available) {
          return Object.freeze({
            configured: false,
            found: true,
            path: pathApi.normalize(desktopCli),
            source: 'desktop-install',
            reasonCode: null,
          })
        }
      }
    }
  }

  const pathValue = codexEnvValue(env, 'PATH', platform)
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex'
  for (const entry of pathValue.split(pathApi.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/gu, '')
    if (!directory || !pathApi.isAbsolute(directory)) continue
    const candidate = pathApi.join(directory, executableName)
    if (!isNativeCodexExecutablePath(candidate, platform)) continue
    const available = await isExecutable(candidate)
    throwIfAborted(signal)
    if (!available) continue
    return Object.freeze({
      configured: false,
      found: true,
      path: pathApi.normalize(candidate),
      source: 'path',
      reasonCode: null,
    })
  }

  return Object.freeze({
    configured: false,
    found: false,
    path: null,
    source: null,
    reasonCode: CODEX_APP_SERVER_REASON.CLI_NOT_FOUND,
  })
}

function cleanupSnapshotPaths(snapshotPath, directory, { removeFile, removeDirectory }) {
  try { if (snapshotPath) removeFile(snapshotPath) } catch { /* best-effort private file cleanup */ }
  try { if (directory) removeDirectory(directory) } catch { /* leave an unexpected non-empty directory */ }
}

async function cleanupSnapshotPathsAsync(snapshotPath, directory, {
  removeFile,
  removeDirectory,
}) {
  try { if (snapshotPath) await removeFile(snapshotPath) } catch { /* best-effort cleanup */ }
  try { if (directory) await removeDirectory(directory) } catch { /* unexpected non-empty dir */ }
}

/**
 * Copy only codex.exe into a randomly named, process-private local directory.
 * Signature verification, version probing, and app-server startup all use this
 * immutable-by-convention snapshot rather than reopening an attacker-selected
 * source path at each trust boundary.
 */
export function createCodexCliExecutableSnapshot(executable, {
  platform = process.platform,
  tempRoot = os.tmpdir(),
  realpath = fs.realpathSync.native,
  mkdtemp = fs.mkdtempSync,
  copyFile = fs.copyFileSync,
  isExecutable = (candidate) => executableFile(candidate, platform),
  removeFile = (candidate) => fs.rmSync(candidate, { force: true }),
  removeDirectory = (candidate) => fs.rmdirSync(candidate),
} = {}) {
  if (platform !== 'win32') {
    if (!isNativeCodexExecutablePath(executable, platform)) return null
    return Object.freeze({ path: executable, cleanup() {} })
  }
  if (!isNativeCodexExecutablePath(executable, platform)) return null

  let snapshotDirectory = null
  let snapshotPath = null
  try {
    const sourcePath = realpath(executable)
    const canonicalTempRoot = realpath(tempRoot)
    if (!isNativeCodexExecutablePath(sourcePath, platform)
      || !localWindowsAbsolutePath(canonicalTempRoot)) return null

    snapshotDirectory = mkdtemp(path.win32.join(canonicalTempRoot, 'gugo-codex-'))
    const canonicalDirectory = realpath(snapshotDirectory)
    if (!windowsPathInside(canonicalDirectory, canonicalTempRoot)) throw new Error('unsafe snapshot path')
    snapshotDirectory = canonicalDirectory
    snapshotPath = path.win32.join(snapshotDirectory, 'codex.exe')
    copyFile(sourcePath, snapshotPath, fs.constants.COPYFILE_EXCL)

    const canonicalSnapshotPath = realpath(snapshotPath)
    if (windowsPathIdentity(canonicalSnapshotPath) !== windowsPathIdentity(snapshotPath)
      || !isNativeCodexExecutablePath(canonicalSnapshotPath, platform)
      || !isExecutable(canonicalSnapshotPath)) {
      throw new Error('invalid executable snapshot')
    }
    snapshotPath = canonicalSnapshotPath
    let cleaned = false
    return Object.freeze({
      path: snapshotPath,
      cleanup() {
        if (cleaned) return
        cleaned = true
        cleanupSnapshotPaths(snapshotPath, snapshotDirectory, { removeFile, removeDirectory })
      },
    })
  } catch {
    cleanupSnapshotPaths(snapshotPath, snapshotDirectory, { removeFile, removeDirectory })
    return null
  }
}

/**
 * Asynchronous Windows snapshot used by the production runtime. The copy may
 * finish after cancellation on platforms where copyFile cannot be interrupted;
 * abort checkpoints then remove the late private snapshot before returning.
 */
export async function createCodexCliExecutableSnapshotAsync(executable, {
  platform = process.platform,
  tempRoot = os.tmpdir(),
  signal = null,
  realpath = fs.promises.realpath,
  mkdtemp = fs.promises.mkdtemp,
  copyFile = fs.promises.copyFile,
  isExecutable = (candidate) => executableFileAsync(candidate, platform, { signal }),
  removeFile = (candidate) => fs.promises.rm(candidate, { force: true }),
  removeDirectory = (candidate) => fs.promises.rmdir(candidate),
} = {}) {
  throwIfAborted(signal)
  if (platform !== 'win32') {
    if (!isNativeCodexExecutablePath(executable, platform)) return null
    return Object.freeze({ path: executable, cleanup() {} })
  }
  if (!isNativeCodexExecutablePath(executable, platform)) return null

  let snapshotDirectory = null
  let snapshotPath = null
  try {
    const sourcePath = await realpath(executable)
    throwIfAborted(signal)
    const canonicalTempRoot = await realpath(tempRoot)
    throwIfAborted(signal)
    if (!isNativeCodexExecutablePath(sourcePath, platform)
      || !localWindowsAbsolutePath(canonicalTempRoot)) return null

    snapshotDirectory = await mkdtemp(path.win32.join(canonicalTempRoot, 'gugo-codex-'))
    throwIfAborted(signal)
    const canonicalDirectory = await realpath(snapshotDirectory)
    throwIfAborted(signal)
    if (!windowsPathInside(canonicalDirectory, canonicalTempRoot)) {
      throw new Error('unsafe snapshot path')
    }
    snapshotDirectory = canonicalDirectory
    snapshotPath = path.win32.join(snapshotDirectory, 'codex.exe')
    await copyFile(sourcePath, snapshotPath, fs.constants.COPYFILE_EXCL)
    throwIfAborted(signal)

    const canonicalSnapshotPath = await realpath(snapshotPath)
    throwIfAborted(signal)
    const available = await isExecutable(canonicalSnapshotPath)
    throwIfAborted(signal)
    if (windowsPathIdentity(canonicalSnapshotPath) !== windowsPathIdentity(snapshotPath)
      || !isNativeCodexExecutablePath(canonicalSnapshotPath, platform)
      || !available) {
      throw new Error('invalid executable snapshot')
    }
    snapshotPath = canonicalSnapshotPath
    let cleanupPromise = null
    return Object.freeze({
      path: snapshotPath,
      cleanup() {
        cleanupPromise ||= cleanupSnapshotPathsAsync(snapshotPath, snapshotDirectory, {
          removeFile, removeDirectory,
        })
        return cleanupPromise
      },
    })
  } catch {
    await cleanupSnapshotPathsAsync(snapshotPath, snapshotDirectory, {
      removeFile, removeDirectory,
    })
    return null
  }
}

export function parseCodexCliVersion(output) {
  const match = String(output || '').trim().match(/^codex(?:-cli)?\s+([0-9][0-9A-Za-z.+-]{0,63})$/u)
  return match?.[1] || null
}

function execOptions({ env, timeoutMs, signal, maxBuffer = 64 * 1024 }) {
  return {
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer,
    windowsHide: true,
    shell: false,
    ...(signal ? { signal } : {}),
  }
}

export function readCodexCliVersion(executable, {
  execFileImpl = execFile,
  env = process.env,
  platform = process.platform,
  signal = null,
  timeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    try {
      execFileImpl(executable, ['--version'], execOptions({
        env: sanitizeChildEnv({}, { sourceEnv: env, platform }),
        timeoutMs: normalizeCodexStageTimeout(timeoutMs, DEFAULT_VERSION_TIMEOUT_MS),
        signal,
      }), (error, stdout) => {
        if (error) return resolve(null)
        resolve(parseCodexCliVersion(stdout))
      })
    } catch {
      resolve(null)
    }
  })
}

export function resolveWindowsPowerShellExecutable({
  realpath = fs.realpathSync.native,
  isExecutable = (candidate) => executableFile(candidate, 'win32'),
} = {}) {
  try {
    // GLOBALROOT\SystemRoot is maintained by the Windows object manager and
    // cannot be redirected through the caller-controlled process environment.
    // Node cannot spawn the object-manager path directly, so resolve it to the
    // native DOS path first and validate the resulting executable.
    const candidate = realpath(WINDOWS_SYSTEM_POWERSHELL_OBJECT_PATH)
    if (!isNativeCodexExecutablePath(candidate, 'win32') || !isExecutable(candidate)) return null
    return path.win32.normalize(candidate)
  } catch {
    return null
  }
}

export async function resolveWindowsPowerShellExecutableAsync({
  signal = null,
  realpath = (candidate) => fs.promises.realpath(candidate),
  isExecutable = (candidate) => executableFileAsync(candidate, 'win32', { signal }),
} = {}) {
  try {
    throwIfAborted(signal)
    const candidate = await realpath(WINDOWS_SYSTEM_POWERSHELL_OBJECT_PATH)
    throwIfAborted(signal)
    if (!isNativeCodexExecutablePath(candidate, 'win32')
      || !(await isExecutable(candidate))) return null
    throwIfAborted(signal)
    return path.win32.normalize(candidate)
  } catch {
    return null
  }
}

const AUTHENTICODE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Import-Module -Name $env:GUGO_CODEX_SIGNATURE_MODULE -Force -ErrorAction Stop
$signature = Get-AuthenticodeSignature -LiteralPath $env:GUGO_CODEX_SIGNATURE_TARGET
$publisher = ''
if ($null -ne $signature.SignerCertificate) {
  $publisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
}
$publisherBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$publisher)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::Out.WriteLine(([string]$signature.Status) + "\t" + [Convert]::ToBase64String($publisherBytes))
`.trim()

function normalizedPublisher(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/gu, '')
}

function parseAuthenticodeResult(output) {
  const line = String(output || '').replace(/^\uFEFF/u, '').trim()
  const fields = line.split('\t')
  if (fields.length !== 2 || fields[0] !== 'Valid') return false
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(fields[1])) {
    return false
  }
  const publisher = Buffer.from(fields[1], 'base64').toString('utf8')
  return OPENAI_PUBLISHERS.has(normalizedPublisher(publisher))
}

/**
 * Windows accepts only a valid Authenticode signature issued to OpenAI. Other
 * platforms have no Authenticode facility, so native executable validation is
 * the applicable platform check and this stage succeeds.
 */
export async function verifyCodexCliAuthenticode(executable, {
  execFileImpl = execFile,
  platform = process.platform,
  powershellPath,
  resolvePowerShell = resolveWindowsPowerShellExecutableAsync,
  signal = null,
  timeoutMs = DEFAULT_SIGNATURE_TIMEOUT_MS,
} = {}) {
  if (platform !== 'win32') return true
  if (signal?.aborted) return false
  const trustedPowerShell = powershellPath === undefined
    ? await resolvePowerShell({ signal })
    : powershellPath
  if (signal?.aborted) return false
  if (!trustedPowerShell || !isNativeCodexExecutablePath(trustedPowerShell, 'win32')) {
    return false
  }
  const encodedScript = Buffer.from(AUTHENTICODE_SCRIPT, 'utf16le').toString('base64')
  // Authenticode is a trust decision, so do not inherit even otherwise-safe
  // host variables. PATH/PSModulePath and CLR profiler/startup-hook variables
  // can all redirect code before the verification command runs.
  const childEnv = sanitizeChildEnv({
    GUGO_CODEX_SIGNATURE_TARGET: executable,
    GUGO_CODEX_SIGNATURE_MODULE: path.win32.join(
      path.win32.dirname(trustedPowerShell),
      'Modules',
      'Microsoft.PowerShell.Security',
      'Microsoft.PowerShell.Security.psd1',
    ),
  }, { sourceEnv: {}, platform })
  return new Promise((resolve) => {
    try {
      execFileImpl(trustedPowerShell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        encodedScript,
      ], execOptions({
        env: childEnv,
        timeoutMs: normalizeCodexStageTimeout(timeoutMs, DEFAULT_SIGNATURE_TIMEOUT_MS),
        signal,
      }), (error, stdout) => {
        if (error) return resolve(false)
        resolve(parseAuthenticodeResult(stdout))
      })
    } catch {
      resolve(false)
    }
  })
}
