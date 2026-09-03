import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'

function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * Local code execution is available by default only for the desktop-style
 * single-user deployment bound to loopback. Multi-user or remotely bound
 * servers must opt in explicitly with LOCAL_CODE_EXECUTION_ENABLED=1.
 */
export function isLocalCodeExecutionEnabled(env = getRuntimeEnv()) {
  if (env.LOCAL_CODE_EXECUTION_ENABLED === '1') return true
  if (env.LOCAL_CODE_EXECUTION_ENABLED === '0') return false
  const authMode = String(env.AUTH_MODE || 'local').trim().toLowerCase()
  const serverHost = String(env.SERVER_HOST || '127.0.0.1').trim()
  return authMode === 'local' && isLoopbackHost(serverHost)
}

/**
 * The bounded run_code worker may be enabled by either the newer local-code
 * deployment policy or the legacy trusted-workspace shell switch. Keep this
 * predicate shared by status projection and the execution boundary so model
 * visibility cannot drift from what the dispatcher will actually permit.
 */
export function isRunCodeExecutionEnabled(env = getRuntimeEnv()) {
  return env?.WORKSPACE_SHELL_ENABLED === '1' || isLocalCodeExecutionEnabled(env)
}

export function serviceError(message, statusCode = 400, code = 'LOCAL_FILE_ACCESS_ERROR') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

export function workspaceRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT?.trim() || process.cwd())
}

export function appDataRoot() {
  return path.resolve(process.env.APP_DATA_DIR?.trim() || path.join(process.cwd(), 'server-data'))
}

export function sharedWorkspaceTrusted() {
  return process.env.WORKSPACE_SHARED_TRUSTED === '1'
}

export function stripPairedOuterQuotes(value) {
  let normalized = String(value || '').trim()
  while (normalized.length >= 2) {
    const first = normalized[0]
    const last = normalized[normalized.length - 1]
    if (!((first === '"' && last === '"') || (first === "'" && last === "'"))) break
    normalized = normalized.slice(1, -1).trim()
  }
  return normalized
}

export function realPath(input) {
  // Keep one canonical representation across Node APIs on Windows. The
  // native variant expands 8.3 aliases (for example RUNNER~1) while the
  // regular variant preserves the representation returned by os.tmpdir().
  // Mixing the two makes an already-authorized path appear different.
  return fs.realpathSync(input)
}

export function samePath(left, right) {
  const a = path.normalize(left)
  const b = path.normalize(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function pathKey(value) {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function assertPathWritable(canonicalPath, stat) {
  let descriptor = null
  let probePath = canonicalPath
  let createdProbe = false
  try {
    if (stat.isDirectory()) {
      probePath = path.join(canonicalPath, `.gugo-write-probe-${crypto.randomUUID()}.tmp`)
      descriptor = fs.openSync(probePath, 'wx')
      createdProbe = true
    } else {
      descriptor = fs.openSync(canonicalPath, 'r+')
    }
    fs.closeSync(descriptor)
    descriptor = null
    if (createdProbe) {
      fs.unlinkSync(probePath)
      createdProbe = false
    }
  } catch (cause) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor) } catch { /* best effort */ }
    }
    if (createdProbe) {
      try { fs.unlinkSync(probePath) } catch { /* best effort */ }
    }
    const error = serviceError(
      `所选路径无法写入（${cause?.code || 'WRITE_DENIED'}）：${canonicalPath}。`
        + '授权未保存，请先检查 Windows 文件夹权限、只读属性或安全软件拦截。',
      403,
      'PATH_NOT_WRITABLE',
    )
    error.path = canonicalPath
    error.retryable = false
    error.hint = '同一根目录下改试 src、.tmp、output 不会解决；修复目录权限后再授权一次。'
    error.cause = cause
    throw error
  }
}

export function resolveTarget(rawPath, { allowMissing = false } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw serviceError('path 必填', 400, 'PATH_REQUIRED')
  }
  const fullPath = path.resolve(rawPath.trim())
  try {
    return { fullPath: realPath(fullPath), anchorPath: null, exists: true }
  } catch {
    if (!allowMissing) {
      throw serviceError(`路径不存在或无法访问: ${rawPath}`, 404, 'PATH_NOT_FOUND')
    }
    let probe = fullPath
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe)
    let anchorPath
    try {
      anchorPath = realPath(probe)
    } catch {
      throw serviceError('无可锚定的祖先目录', 404, 'PATH_NOT_FOUND')
    }
    return { fullPath, anchorPath, exists: false }
  }
}
