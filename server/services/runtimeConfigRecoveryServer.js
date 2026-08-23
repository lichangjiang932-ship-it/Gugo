import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { validateRuntimePluginConfigDocument } from '../plugins/runtimePluginConfigFile.js'
import {
  MAX_RUNTIME_CONFIG_BYTES,
  parseRuntimeConfigContent,
  resolveRuntimeStartupConfigPaths,
} from '../utils/runtimeEnv.js'
import { toPublicRuntimeConfigHttpError } from '../utils/runtimeConfigErrors.js'
import {
  RUNTIME_CONFIG_RECOVERY_MODE,
  RUNTIME_CONFIG_RECOVERY_PROTOCOL_VERSION,
} from '../../shared/runtimeConfigRecoveryProtocol.js'

export const RECOVERABLE_RUNTIME_CONFIG_CODES = Object.freeze([
  'RUNTIME_CONFIG_FILE_INVALID',
  'RUNTIME_CONFIG_FILE_TOO_LARGE',
  'PLUGIN_CONFIG_FILE_INVALID',
])

const RECOVERABLE_CODE_SET = new Set(RECOVERABLE_RUNTIME_CONFIG_CODES)
const SENSITIVE_CONFIG_KEY = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_?KEY)/iu
const SELF_RELOCATION_KEYS = Object.freeze(['APP_DATA_DIR', 'APP_CONFIG_PATH'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])

const PUBLIC_RECOVERY_ERRORS = Object.freeze({
  RECOVERY_FORBIDDEN: Object.freeze({ statusCode: 403, message: '恢复请求未通过本机安全校验' }),
  RECOVERY_TARGET_CHANGED: Object.freeze({ statusCode: 409, message: '运行配置文件已被其他进程修改，请重启后再试' }),
  RECOVERY_TARGET_UNSAFE: Object.freeze({ statusCode: 409, message: '运行配置路径不满足安全恢复条件' }),
  RECOVERY_TOKEN_INVALID: Object.freeze({ statusCode: 403, message: '恢复页面令牌无效，请刷新页面后重试' }),
  RECOVERY_ORIGIN_INVALID: Object.freeze({ statusCode: 403, message: '恢复请求来源无效' }),
  RECOVERY_CONTENT_TYPE_INVALID: Object.freeze({ statusCode: 415, message: '恢复配置必须使用 JSON 内容类型' }),
  RECOVERY_METHOD_NOT_ALLOWED: Object.freeze({ statusCode: 405, message: '恢复接口不支持该请求方法' }),
  RECOVERY_NOT_FOUND: Object.freeze({ statusCode: 404, message: '恢复接口不存在' }),
  RECOVERY_WRITE_FAILED: Object.freeze({ statusCode: 500, message: '运行配置保存失败，原文件未被替换' }),
})

function recoveryError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  error.retryable = false
  return error
}

function comparablePath(filePath) {
  const resolved = path.resolve(String(filePath || ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function samePath(left, right) {
  return Boolean(left && right) && comparablePath(left) === comparablePath(right)
}

function resolveRecoverableUserConfigPath({ error, cwd, env }) {
  if (!RECOVERABLE_CODE_SET.has(String(error?.code || ''))) return null
  if (typeof error?.sourcePath !== 'string' || !error.sourcePath.trim()) return null
  let sources
  try {
    sources = resolveRuntimeStartupConfigPaths({ cwd, env })
  } catch {
    return null
  }
  if (!samePath(error.sourcePath, sources.user)) return null
  if (samePath(error.sourcePath, sources.project)) return null
  if (sources.explicit && samePath(error.sourcePath, sources.explicit)) return null
  return path.resolve(sources.user)
}

export function isRecoverableUserRuntimeConfigError({
  error,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  return Boolean(resolveRecoverableUserConfigPath({ error, cwd, env }))
}

function targetIdentity(filePath) {
  let parentRealPath
  let stat
  try {
    parentRealPath = fs.realpathSync.native(path.dirname(filePath))
    stat = fs.lstatSync(filePath, { bigint: true })
  } catch (cause) {
    const error = recoveryError(
      'RECOVERY_TARGET_UNSAFE',
      'runtime config target cannot be inspected safely',
      409,
    )
    error.cause = cause
    throw error
  }
  if (!samePath(parentRealPath, path.dirname(filePath))
    || stat.isSymbolicLink()
    || !stat.isFile()) {
    throw recoveryError(
      'RECOVERY_TARGET_UNSAFE',
      'runtime config target must be a regular file in a non-linked directory',
      409,
    )
  }
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  })
}

function sameIdentity(left, right) {
  return Boolean(left && right)
    && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key])
}

function assertTargetIdentity(filePath, expected) {
  let current
  try {
    current = targetIdentity(filePath)
  } catch (error) {
    if (error?.code === 'RECOVERY_TARGET_UNSAFE') {
      throw recoveryError(
        'RECOVERY_TARGET_CHANGED',
        'runtime config target changed after recovery mode started',
        409,
      )
    }
    throw error
  }
  if (!sameIdentity(current, expected)) {
    throw recoveryError(
      'RECOVERY_TARGET_CHANGED',
      'runtime config target changed after recovery mode started',
      409,
    )
  }
}

function assertNoSensitiveMetadata(document) {
  const pending = [document]
  while (pending.length > 0) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_CONFIG_KEY.test(key)) {
        throw recoveryError(
          'RUNTIME_CONFIG_FILE_INVALID',
          'sensitive fields are not allowed in runtime config',
          422,
        )
      }
      if (child && typeof child === 'object') pending.push(child)
    }
  }
}

function validateReplacement(content, filePath) {
  const snapshot = parseRuntimeConfigContent(content, { filePath })
  assertNoSensitiveMetadata(snapshot.document)
  const selfRelocationKey = SELF_RELOCATION_KEYS.find((key) => Object.hasOwn(snapshot.env, key))
  if (selfRelocationKey) {
    throw recoveryError(
      'RUNTIME_CONFIG_FILE_INVALID',
      'user runtime config cannot relocate its own source',
      422,
    )
  }
  validateRuntimePluginConfigDocument(snapshot.document, { sourcePath: filePath })
  return snapshot.content
}

function ownedTemporaryPath(directory, suffix) {
  return path.join(
    directory,
    `.runtime-recovery-${process.pid}-${randomBytes(12).toString('hex')}.${suffix}`,
  )
}

function flushDirectory(directory) {
  let descriptor = null
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch {
    // Windows may reject directory handles. File fsync + same-directory rename
    // still provide the strongest portable behavior available from Node.
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor) } catch { /* best effort */ }
    }
  }
}

function replaceConfigAtomically({ filePath, expectedIdentity, content }) {
  const directory = path.dirname(filePath)
  const tempPath = ownedTemporaryPath(directory, 'tmp')
  const backupFilename = `runtime.broken-${Date.now()}-${randomBytes(8).toString('hex')}.json`
  const backupPath = path.join(directory, backupFilename)
  let descriptor = null
  let backupCreated = false
  let replacementCommitted = false
  try {
    assertTargetIdentity(filePath, expectedIdentity)
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null

    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL)
    backupCreated = true
    assertTargetIdentity(filePath, expectedIdentity)
    fs.renameSync(tempPath, filePath)
    replacementCommitted = true
    flushDirectory(directory)
    return backupFilename
  } catch (error) {
    if (error?.code === 'RECOVERY_TARGET_CHANGED'
      || error?.code === 'RECOVERY_TARGET_UNSAFE') throw error
    const wrapped = recoveryError(
      'RECOVERY_WRITE_FAILED',
      'runtime config replacement failed',
      500,
    )
    wrapped.cause = error
    throw wrapped
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor) } catch { /* best effort */ }
    }
    if (!replacementCommitted) {
      try { fs.unlinkSync(tempPath) } catch { /* best effort */ }
      if (backupCreated) {
        try { fs.unlinkSync(backupPath) } catch { /* best effort */ }
      }
    }
  }
}

function isLoopbackPeer(address) {
  const value = String(address || '').toLowerCase()
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function requestHost(request) {
  const value = String(request.headers.host || '').trim().toLowerCase()
  if (!value || /[\\/@\s]/u.test(value)) return null
  try {
    const parsed = new URL(`http://${value}`)
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null
    return value
  } catch {
    return null
  }
}

function equalToken(left, right) {
  const expected = Buffer.from(String(left || ''), 'utf8')
  const actual = Buffer.from(String(right || ''), 'utf8')
  return expected.length === actual.length
    && expected.length > 0
    && timingSafeEqual(expected, actual)
}

function assertMutationRequest(request, recoveryToken) {
  if (!isLoopbackPeer(request.socket?.remoteAddress) || !requestHost(request)) {
    throw recoveryError('RECOVERY_FORBIDDEN', 'recovery is loopback-only', 403)
  }
  const origin = String(request.headers.origin || '').trim().toLowerCase()
  if (origin && origin !== `http://${requestHost(request)}`) {
    throw recoveryError('RECOVERY_ORIGIN_INVALID', 'recovery request origin is invalid', 403)
  }
  if (!equalToken(recoveryToken, request.headers['x-gugo-recovery-token'])) {
    throw recoveryError('RECOVERY_TOKEN_INVALID', 'recovery token is invalid', 403)
  }
}

function assertSafeRequest(request) {
  if (!isLoopbackPeer(request.socket?.remoteAddress) || !requestHost(request)) {
    throw recoveryError('RECOVERY_FORBIDDEN', 'recovery is loopback-only', 403)
  }
}

async function readBoundedBody(request) {
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RUNTIME_CONFIG_BYTES) {
    request.resume()
    throw recoveryError(
      'RUNTIME_CONFIG_FILE_TOO_LARGE',
      'runtime config replacement is too large',
      413,
    )
  }
  const chunks = []
  let size = 0
  let oversized = false
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_RUNTIME_CONFIG_BYTES) {
      oversized = true
      continue
    }
    chunks.push(chunk)
  }
  if (oversized) {
    throw recoveryError(
      'RUNTIME_CONFIG_FILE_TOO_LARGE',
      'runtime config replacement is too large',
      413,
    )
  }
  return Buffer.concat(chunks, size)
}

function securityHeaders(extra = {}) {
  return {
    'cache-control': 'no-store, max-age=0',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extra,
  }
}

function writeJson(response, statusCode, body, { head = false, headers = {} } = {}) {
  const content = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(statusCode, securityHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(content.length),
    ...headers,
  }))
  response.end(head ? undefined : content)
}

function publicError(error) {
  const runtimeConfigError = toPublicRuntimeConfigHttpError(error)
  if (runtimeConfigError) return runtimeConfigError
  const definition = PUBLIC_RECOVERY_ERRORS[String(error?.code || '')]
    || PUBLIC_RECOVERY_ERRORS.RECOVERY_WRITE_FAILED
  return {
    statusCode: definition.statusCode,
    body: {
      ok: false,
      error: {
        code: definition === PUBLIC_RECOVERY_ERRORS.RECOVERY_WRITE_FAILED
          ? 'RECOVERY_WRITE_FAILED'
          : String(error.code),
        message: definition.message,
      },
    },
  }
}

function writeError(response, error, options = {}) {
  const result = publicError(error)
  writeJson(response, result.statusCode, result.body, options)
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function recoveryPage(recoveryToken) {
  const nonce = randomBytes(18).toString('base64url')
  const token = escapeHtml(recoveryToken)
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Gugo 配置恢复</title>
  <style nonce="${nonce}">
    :root{color-scheme:dark;font-family:Inter,"Microsoft YaHei",sans-serif;background:#0b0d10;color:#f5f7fa}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}
    main{width:min(760px,100%);background:#141820;border:1px solid #293140;border-radius:18px;padding:28px;box-shadow:0 24px 70px #0008}
    h1{font-size:24px;margin:0 0 10px}p{color:#b9c2d0;line-height:1.65}code{color:#9bd1ff}
    textarea{width:100%;min-height:290px;box-sizing:border-box;margin:14px 0;padding:16px;border-radius:12px;border:1px solid #354157;background:#090b0f;color:#eaf2ff;font:14px/1.55 ui-monospace,Consolas,monospace;resize:vertical}
    .actions{display:flex;gap:10px;flex-wrap:wrap}button{border:0;border-radius:10px;padding:11px 17px;font-weight:700;cursor:pointer;background:#4c8dff;color:white}button.secondary{background:#2a3240}button:disabled{opacity:.55;cursor:wait}
    #status{min-height:24px;margin-top:14px;color:#9bd1ff}small{display:block;color:#8590a0;margin-top:16px}
  </style>
</head>
<body data-recovery-token="${token}">
  <main>
    <h1>Gugo 无法读取 <code>runtime.json</code></h1>
    <p>主服务尚未启动。请修正下方配置并保存，或重置为最小配置。损坏的原文件会先在同目录备份；保存后请重启 Gugo。</p>
    <textarea id="config" spellcheck="false">{
  "env": {}
}
</textarea>
    <div class="actions">
      <button id="save" type="button">验证并保存</button>
      <button id="reset" class="secondary" type="button">重置为最小配置</button>
    </div>
    <div id="status" role="status" aria-live="polite"></div>
    <small>恢复服务仅监听 127.0.0.1，不会继续启动业务 API、插件、任务或 Agent；已打开的数据库会先关闭。</small>
  </main>
  <script nonce="${nonce}">
    const token = document.body.dataset.recoveryToken
    const status = document.querySelector('#status')
    const buttons = [...document.querySelectorAll('button')]
    const request = async (url, options) => {
      buttons.forEach((button) => { button.disabled = true })
      status.textContent = '正在验证…'
      try {
        const response = await fetch(url, {
          ...options,
          headers: { ...(options.headers || {}), 'x-gugo-recovery-token': token },
        })
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error?.message || '保存失败')
        status.textContent = '配置已安全保存。请重启 Gugo。'
      } catch (error) {
        status.textContent = error?.message || '保存失败'
      } finally {
        buttons.forEach((button) => { button.disabled = false })
      }
    }
    document.querySelector('#save').addEventListener('click', () => request('/api/recovery/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: document.querySelector('#config').value,
    }))
    document.querySelector('#reset').addEventListener('click', () => {
      if (confirm('确认重置为最小配置？损坏文件仍会保留备份。')) {
        request('/api/recovery/reset', { method: 'POST' })
      }
    })
  </script>
</body>
</html>`
  return { html: Buffer.from(html, 'utf8'), nonce }
}

function writeRecoveryPage(response, { recoveryToken, head = false }) {
  const page = recoveryPage(recoveryToken)
  response.writeHead(200, securityHeaders({
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(page.html.length),
    'content-security-policy': `default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'nonce-${page.nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  }))
  response.end(head ? undefined : page.html)
}

export function createRuntimeConfigRecoveryServer({
  startupError,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const filePath = resolveRecoverableUserConfigPath({ error: startupError, cwd, env })
  if (!filePath) throw startupError
  const initialIdentity = targetIdentity(filePath)
  const recoveryToken = randomBytes(32).toString('base64url')
  const publicStartupError = toPublicRuntimeConfigHttpError(startupError)
  if (!publicStartupError) throw startupError

  const server = http.createServer(async (request, response) => {
    const method = String(request.method || 'GET').toUpperCase()
    let pathname
    try {
      pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
      assertSafeRequest(request)

      if (pathname === '/' && ['GET', 'HEAD'].includes(method)) {
        writeRecoveryPage(response, { recoveryToken, head: method === 'HEAD' })
        return
      }
      if (pathname === '/api/recovery/status' && ['GET', 'HEAD'].includes(method)) {
        writeJson(response, 200, {
          ok: true,
          mode: RUNTIME_CONFIG_RECOVERY_MODE,
          protocolVersion: RUNTIME_CONFIG_RECOVERY_PROTOCOL_VERSION,
          filename: 'runtime.json',
          error: publicStartupError.body.error,
          restartRequired: true,
        }, { head: method === 'HEAD' })
        return
      }
      if (pathname === '/api/recovery/config') {
        if (method !== 'PUT') {
          throw recoveryError('RECOVERY_METHOD_NOT_ALLOWED', 'method not allowed', 405)
        }
        assertMutationRequest(request, recoveryToken)
        if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          throw recoveryError('RECOVERY_CONTENT_TYPE_INVALID', 'JSON content type required', 415)
        }
        const content = validateReplacement(await readBoundedBody(request), filePath)
        const backupFilename = replaceConfigAtomically({
          filePath,
          expectedIdentity: initialIdentity,
          content,
        })
        writeJson(response, 200, { ok: true, restartRequired: true, backupFilename })
        return
      }
      if (pathname === '/api/recovery/reset') {
        if (method !== 'POST') {
          throw recoveryError('RECOVERY_METHOD_NOT_ALLOWED', 'method not allowed', 405)
        }
        assertMutationRequest(request, recoveryToken)
        const content = validateReplacement(Buffer.from('{\n  "env": {}\n}\n', 'utf8'), filePath)
        const backupFilename = replaceConfigAtomically({
          filePath,
          expectedIdentity: initialIdentity,
          content,
        })
        writeJson(response, 200, { ok: true, restartRequired: true, backupFilename })
        return
      }
      throw recoveryError('RECOVERY_NOT_FOUND', 'not found', 404)
    } catch (error) {
      if (!response.headersSent) writeError(response, error)
      else response.destroy()
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  return server
}

export async function startRuntimeConfigRecoveryServer({
  startupError,
  cwd = process.cwd(),
  env = process.env,
  port = Number(env.SERVER_PORT || 5173),
} = {}) {
  const server = createRuntimeConfigRecoveryServer({ startupError, cwd, env })
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  console.error(
    `[server] runtime.json recovery is available at http://127.0.0.1:${address.port}/; restart after saving.`,
  )
  return server
}
