import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

import { isToolPermittedForUser } from '../db.js'
import { assertSafeOutboundUrl } from '../utils/outboundNetworkGuard.js'
import {
  bashExecTool,
  resolveForFileTool,
  resolveForShellCwd,
  writeFileTool,
} from './fsShellTools.js'
import { dispatchApplyPatchTool } from '../utils/applyPatch.js'
import { writeLimiter } from '../utils/rateLimiter.js'

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000
const MAX_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
const HARD_DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024
const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TEST_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_DOCKER_TIMEOUT_MS = 5 * 60 * 1000
const MAX_DOCKER_TIMEOUT_MS = 30 * 60 * 1000
const MAX_REDIRECTS = 5

function toolError(message, statusCode = 400, code = 'CODING_TOOL_FAILED', hint = null) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  if (hint) error.hint = hint
  return error
}

function assertToolPermitted(userId, toolName) {
  if (userId && !isToolPermittedForUser(userId, toolName)) {
    throw toolError(`工具 ${toolName} 已被该用户在权限中心关闭`, 403, 'TOOL_DISABLED')
  }
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function redactForwardedEnvValues(result, envKeys, sourceEnv = process.env) {
  const secrets = [...new Set((Array.isArray(envKeys) ? envKeys : [])
    .map((key) => sourceEnv[String(key || '')])
    .filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((left, right) => right.length - left.length)
  if (secrets.length === 0) return result

  const seen = new WeakMap()
  const redact = (value) => {
    if (typeof value === 'string') {
      return secrets.reduce(
        (text, secret) => text.split(secret).join('[REDACTED_ENV]'),
        value,
      )
    }
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value
    if (seen.has(value)) return seen.get(value)
    const copy = Array.isArray(value) ? [] : {}
    seen.set(value, copy)
    for (const [key, nested] of Object.entries(value)) copy[key] = redact(nested)
    return copy
  }
  return redact(result)
}

function quoteCommandArg(value, platform = process.platform) {
  const text = String(value ?? '')
  if (platform === 'win32') return `"${text.replace(/"/g, '""')}"`
  return `'${text.replace(/'/g, `'"'"'`)}'`
}

function inferTestCommand(cwd, requestedFramework = 'auto') {
  const framework = String(requestedFramework || 'auto').trim().toLowerCase()
  const exists = (name) => fs.existsSync(path.join(cwd, name))
  const packageJsonPath = path.join(cwd, 'package.json')
  let packageJson = null
  if (exists('package.json')) {
    try { packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) } catch { /* invalid package.json is reported by the runner */ }
  }

  if (framework === 'npm' || (framework === 'auto' && packageJson?.scripts?.test)) {
    return { framework: 'npm', command: 'npm test' }
  }
  if (framework === 'pytest' || (framework === 'auto' && [
    'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'requirements.txt',
  ].some(exists))) {
    return { framework: 'pytest', command: 'python -m pytest' }
  }
  if (framework === 'cargo' || (framework === 'auto' && exists('Cargo.toml'))) {
    return { framework: 'cargo', command: 'cargo test' }
  }
  if (framework === 'go' || (framework === 'auto' && exists('go.mod'))) {
    return { framework: 'go', command: 'go test ./...' }
  }
  if (framework === 'maven' || (framework === 'auto' && exists('pom.xml'))) {
    return { framework: 'maven', command: 'mvn test' }
  }
  if (framework === 'gradle' || (framework === 'auto' && (exists('gradlew') || exists('gradlew.bat') || exists('build.gradle')))) {
    const wrapper = process.platform === 'win32' && exists('gradlew.bat')
      ? 'gradlew.bat'
      : (exists('gradlew') ? './gradlew' : 'gradle')
    return { framework: 'gradle', command: `${wrapper} test` }
  }
  if (framework !== 'auto') {
    throw toolError(`不支持的测试框架: ${framework}`, 400, 'TEST_FRAMEWORK_UNSUPPORTED')
  }
  throw toolError(
    '无法自动识别测试框架；请传入 command，或指定 npm/pytest/cargo/go/maven/gradle。',
    400,
    'TEST_FRAMEWORK_NOT_DETECTED',
  )
}

export async function runCommandTool({
  command,
  cmd,
  cwd,
  timeout_ms,
  expected_outputs = [],
  env_keys = [],
  userId = null,
  signal = null,
} = {}) {
  assertToolPermitted(userId, 'run_command')
  const selected = typeof command === 'string' && command.trim()
    ? command.trim()
    : (typeof cmd === 'string' ? cmd.trim() : '')
  if (!selected) throw toolError('command 必填', 400, 'COMMAND_REQUIRED')
  const result = await bashExecTool({
    command: selected,
    cwd,
    timeout_ms,
    expected_outputs,
    env_keys,
    userId,
    signal,
  }, {
    permissionToolName: 'run_command',
  })
  return redactForwardedEnvValues(result, env_keys)
}

function normalizeLinePatch(text, { startLine, endLine, replacement }) {
  const original = String(text)
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingEol = /\r?\n$/u.test(original)
  const normalized = original.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (hadTrailingEol) lines.pop()
  const start = Number(startLine)
  const end = Number(endLine)
  if (!Number.isInteger(start) || start < 1 || start > lines.length + 1) {
    throw toolError(`start_line 必须在 1 到 ${lines.length + 1} 之间`, 400, 'PATCH_LINE_RANGE_INVALID')
  }
  if (!Number.isInteger(end) || end < start - 1 || end > lines.length) {
    throw toolError(`end_line 必须在 ${start - 1} 到 ${lines.length} 之间`, 400, 'PATCH_LINE_RANGE_INVALID')
  }
  if (typeof replacement !== 'string') {
    throw toolError('replacement 必须是字符串', 400, 'PATCH_REPLACEMENT_INVALID')
  }
  const replacementNormalized = replacement.replace(/\r\n/g, '\n')
  const replacementLines = replacementNormalized === '' ? [] : replacementNormalized.split('\n')
  if (replacementLines.at(-1) === '') replacementLines.pop()
  const nextLines = [
    ...lines.slice(0, start - 1),
    ...replacementLines,
    ...lines.slice(end),
  ]
  return `${nextLines.join(eol)}${hadTrailingEol ? eol : ''}`
}

export async function patchFileTool({
  patch,
  dry_run = false,
  path: rawPath,
  start_line,
  end_line,
  replacement,
  expected_sha256,
  userId = null,
} = {}) {
  assertToolPermitted(userId, 'patch_file')
  if (typeof patch === 'string' && patch.trim()) {
    return dispatchApplyPatchTool('apply_patch', { patch, dry_run }, { userId })
  }
  const resolved = resolveForFileTool(rawPath, { userId, write: true })
  const stat = fs.statSync(resolved.fullPath)
  if (!stat.isFile()) throw toolError('path 必须是普通文件', 400, 'PATCH_FILE_REQUIRED')
  const original = fs.readFileSync(resolved.fullPath, 'utf8')
  const digest = createHash('sha256').update(original).digest('hex')
  const expected = String(expected_sha256 || '').trim().toLowerCase()
  if (expected && !/^[0-9a-f]{64}$/u.test(expected)) {
    throw toolError('expected_sha256 必须是 64 位十六进制字符串', 400, 'PATCH_CHECKSUM_INVALID')
  }
  if (expected && digest !== expected) {
    throw toolError('文件已在读取后发生变化或版本不匹配，请重新读取后再修改', 409, 'PATCH_FILE_CHANGED')
  }
  const next = normalizeLinePatch(original, {
    startLine: start_line,
    endLine: end_line,
    replacement,
  })
  if (next === original) throw toolError('patch_file 没有产生任何变化', 400, 'PATCH_NO_CHANGES')
  if (dry_run === true) {
    return {
      ok: true,
      dryRun: true,
      path: resolved.displayPath,
      scope: resolved.source,
      beforeSha256: digest,
      afterSha256: createHash('sha256').update(next).digest('hex'),
      replacedLines: Math.max(0, Number(end_line) - Number(start_line) + 1),
      replacementLines: replacement === '' ? 0 : replacement.replace(/\r\n/g, '\n').split('\n').filter((line, index, all) => index < all.length - 1 || line !== '').length,
    }
  }
  const result = await writeFileTool({
    path: resolved.fullPath,
    content: next,
    userId,
  }, {
    permissionToolName: 'patch_file',
  })
  return {
    ...result,
    beforeSha256: digest,
    afterSha256: createHash('sha256').update(next).digest('hex'),
  }
}

function parseTestSummary(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`
  const summary = {}
  const node = text.match(/# tests\s+(\d+)[\s\S]*?# pass\s+(\d+)[\s\S]*?# fail\s+(\d+)/iu)
  const pytestPassed = text.match(/\b(\d+) passed\b/iu)
  const pytestFailed = text.match(/\b(\d+) failed\b/iu)
  const pytestSkipped = text.match(/\b(\d+) skipped\b/iu)
  const coverage = text.match(/(?:All files|TOTAL)\s*\|?\s*(\d+(?:\.\d+)?)%?/iu)
  if (node) {
    summary.total = Number(node[1])
    summary.passed = Number(node[2])
    summary.failed = Number(node[3])
  } else if (pytestPassed || pytestFailed || pytestSkipped) {
    summary.passed = Number(pytestPassed?.[1] || 0)
    summary.failed = Number(pytestFailed?.[1] || 0)
    summary.skipped = Number(pytestSkipped?.[1] || 0)
    summary.total = summary.passed + summary.failed + summary.skipped
  }
  if (coverage) summary.coveragePercent = Number(coverage[1])
  return summary
}

export async function runTestTool({
  command,
  framework = 'auto',
  cwd: rawCwd,
  timeout_ms,
  env_keys = [],
  userId = null,
  signal = null,
} = {}) {
  assertToolPermitted(userId, 'run_test')
  const resolved = resolveForShellCwd(rawCwd, { userId })
  if (!fs.statSync(resolved.fullPath).isDirectory()) {
    throw toolError('cwd 必须是目录', 400, 'TEST_CWD_NOT_DIRECTORY')
  }
  const selected = typeof command === 'string' && command.trim()
    ? { framework: String(framework || 'custom'), command: command.trim() }
    : inferTestCommand(resolved.fullPath, framework)
  const timeout = clampInteger(timeout_ms, DEFAULT_TEST_TIMEOUT_MS, 1000, MAX_TEST_TIMEOUT_MS)
  const result = await bashExecTool({
    command: selected.command,
    cwd: resolved.fullPath,
    timeout_ms: timeout,
    expected_outputs: [],
    env_keys,
    userId,
    signal,
  }, {
    permissionToolName: 'run_test',
  })
  const safeResult = redactForwardedEnvValues(result, env_keys)
  return {
    ...safeResult,
    passed: result.ok === true && result.exitCode === 0,
    framework: selected.framework,
    command: selected.command,
    summary: parseTestSummary(result.stdout, result.stderr),
  }
}

function executableFile(candidate, platform = process.platform) {
  try {
    if (!fs.statSync(candidate).isFile()) return false
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findDockerCli({
  env: sourceEnv = process.env,
  platform = process.platform,
  isExecutable = (candidate) => executableFile(candidate, platform),
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const pathValue = String(sourceEnv.PATH || sourceEnv.Path || sourceEnv.path || '')
  const pathEntries = pathValue
    .split(pathApi.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  const executableNames = platform === 'win32'
    ? ['docker.exe', 'docker.cmd', 'docker.bat', 'docker.com']
    : ['docker']
  for (const directory of pathEntries) {
    for (const name of executableNames) {
      if (isExecutable(pathApi.join(directory, name))) return 'docker'
    }
  }

  if (platform !== 'win32') return null
  const programDirectories = [
    sourceEnv.ProgramFiles,
    sourceEnv.ProgramW6432,
    sourceEnv['ProgramFiles(x86)'],
  ].filter(Boolean)
  const commonCandidates = [
    ...programDirectories.map((directory) => pathApi.join(
      directory,
      'Docker',
      'Docker',
      'resources',
      'bin',
      'docker.exe',
    )),
    sourceEnv.ProgramData
      ? pathApi.join(sourceEnv.ProgramData, 'DockerDesktop', 'version-bin', 'docker.exe')
      : null,
  ].filter(Boolean)
  return commonCandidates.find((candidate) => isExecutable(candidate)) || null
}

function dockerCommand({
  dockerCli = 'docker',
  container,
  command,
  workdir,
  env = {},
  containerOs = 'linux',
  platform = process.platform,
}) {
  const name = String(container || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name)) {
    throw toolError('container 必须是有效的 Docker 容器名或 ID', 400, 'DOCKER_CONTAINER_INVALID')
  }
  const normalizedContainerOs = String(containerOs || 'linux').trim().toLowerCase()
  if (!['linux', 'windows'].includes(normalizedContainerOs)) {
    throw toolError('container_os 必须是 linux 或 windows', 400, 'DOCKER_CONTAINER_OS_INVALID')
  }
  const executable = String(dockerCli || '').trim()
  if (!executable) throw toolError('Docker CLI 不可用', 503, 'DOCKER_NOT_AVAILABLE')
  const fixed = (value) => (/^[A-Za-z0-9_.:/\\-]+$/u.test(value)
    ? value
    : quoteCommandArg(value, platform))
  const argv = [fixed(executable), 'exec']
  if (workdir) argv.push('-w', quoteCommandArg(String(workdir), platform))
  for (const [key, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw toolError(`无效的 Docker 环境变量名: ${key}`, 400, 'DOCKER_ENV_INVALID')
    }
    argv.push('-e', quoteCommandArg(`${key}=${String(value)}`, platform))
  }
  argv.push(name)
  if (Array.isArray(command)) {
    if (!command.length || command.some((value) => typeof value !== 'string' || !value)) {
      throw toolError('command 数组必须包含非空字符串', 400, 'DOCKER_COMMAND_INVALID')
    }
    argv.push(...command.map((value) => quoteCommandArg(value, platform)))
  } else if (typeof command === 'string' && command.trim()) {
    if (normalizedContainerOs === 'windows') {
      argv.push('cmd.exe', '/d', '/s', '/c', quoteCommandArg(command.trim(), platform))
    } else {
      argv.push('/bin/sh', '-lc', quoteCommandArg(command.trim(), platform))
    }
  } else {
    throw toolError('command 必填', 400, 'DOCKER_COMMAND_REQUIRED')
  }
  const commandLine = argv.join(' ')
  // cmd.exe /s /c strips the first and last quote from its command string.
  // Keep one outer pair so quoted executables (for example Docker Desktop
  // under Program Files) and quoted trailing arguments survive that pass.
  return platform === 'win32' ? `"${commandLine}"` : commandLine
}

export async function dockerExecTool({
  container,
  command,
  workdir,
  env,
  container_os = 'linux',
  env_keys = [],
  cwd: rawCwd,
  timeout_ms,
  expected_outputs = [],
  userId = null,
  signal = null,
} = {}, {
  findDockerCliImpl = findDockerCli,
  platform = process.platform,
} = {}) {
  assertToolPermitted(userId, 'docker_exec')
  const dockerCli = findDockerCliImpl({ platform })
  if (!dockerCli) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '未检测到 Docker CLI。',
      code: 'DOCKER_NOT_AVAILABLE',
      hint: '请安装 Docker Desktop/Engine，并确保 docker CLI 位于 PATH 或标准安装目录。',
    }
  }
  if (dockerCli !== 'docker') {
    try {
      resolveForFileTool(dockerCli, { userId, write: false })
    } catch {
      const pathApi = platform === 'win32' ? path.win32 : path.posix
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '已检测到 Docker CLI，但其目录不在 PATH 或当前授权范围中。',
        code: 'DOCKER_NOT_AVAILABLE',
        detectedPath: dockerCli,
        hint: `请将 ${pathApi.dirname(dockerCli)} 加入 PATH 后重试。`,
      }
    }
  }
  const timeout = clampInteger(timeout_ms, DEFAULT_DOCKER_TIMEOUT_MS, 1000, MAX_DOCKER_TIMEOUT_MS)
  const result = await bashExecTool({
    command: dockerCommand({
      dockerCli,
      container,
      command,
      workdir,
      env,
      containerOs: container_os,
      platform,
    }),
    cwd: rawCwd,
    timeout_ms: timeout,
    expected_outputs,
    env_keys,
    userId,
    signal,
  }, {
    permissionToolName: 'docker_exec',
  })
  const safeResult = redactForwardedEnvValues(result, env_keys)
  if (result.ok === false && /(?:not recognized|not found|ENOENT).*docker|docker.*(?:not recognized|not found)/iu.test(`${result.stderr}\n${result.error}`)) {
    return {
      ...safeResult,
      code: 'DOCKER_NOT_AVAILABLE',
      hint: '请安装并启动 Docker Desktop/Engine；工具会在下一次调用时自动复用系统 docker CLI。',
    }
  }
  return { ...safeResult, container: String(container || '').trim() }
}

function requestDownload(target, { headers = {}, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:'
    const transport = isHttps ? https : http
    const lockedIp = target.lockedIp || (net.isIP(target.hostname) ? target.hostname : null)
    const options = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Gugo-Coding-Agent/1.0',
        Accept: '*/*',
        ...headers,
        Host: target.host,
      },
    }
    if (lockedIp) {
      const family = net.isIPv6(lockedIp) ? 6 : 4
      options.lookup = (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [{ address: lockedIp, family }])
        else callback(null, lockedIp, family)
      }
      if (isHttps) options.servername = target.hostname
    }
    const request = transport.request(options, resolve)
    const abort = () => request.destroy(toolError('下载已取消', 499, 'DOWNLOAD_CANCELLED'))
    request.setTimeout(timeoutMs, () => request.destroy(toolError('下载超时', 408, 'DOWNLOAD_TIMEOUT')))
    request.once('error', reject)
    request.once('close', () => signal?.removeEventListener('abort', abort))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    request.end()
  })
}

async function openDownloadResponse(url, options) {
  let current = String(url || '').trim()
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const target = await (options.validateUrl || assertSafeOutboundUrl)(current)
    const response = await (options.requestImpl || requestDownload)(target, options)
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers?.location) {
      response.resume?.()
      if (redirect >= MAX_REDIRECTS) {
        throw toolError('下载重定向次数过多', 502, 'DOWNLOAD_REDIRECT_LIMIT')
      }
      current = new URL(response.headers.location, target).toString()
      continue
    }
    return { response, finalUrl: target.toString() }
  }
  throw toolError('下载重定向次数过多', 502, 'DOWNLOAD_REDIRECT_LIMIT')
}

function configuredDownloadLimit() {
  return clampInteger(
    process.env.FILE_DOWNLOAD_MAX_BYTES,
    DEFAULT_DOWNLOAD_MAX_BYTES,
    1,
    HARD_DOWNLOAD_MAX_BYTES,
  )
}

async function commitDownloadedFile(tempPath, destination, overwrite) {
  if (overwrite) {
    // tempPath lives beside destination, so rename is a same-volume atomic
    // replacement on supported filesystems (including Windows MoveFileEx).
    await fs.promises.rename(tempPath, destination)
    return
  }
  try {
    // A same-directory hard link is an atomic, exclusive commit: exactly one
    // concurrent downloader can create destination and readers never observe
    // a partially copied file. The caller removes the temporary link.
    await fs.promises.link(tempPath, destination)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw toolError(
        '目标文件已存在；确认需要覆盖后传 overwrite=true',
        409,
        'DOWNLOAD_TARGET_EXISTS',
      )
    }
    throw error
  }
}

export async function fileDownloadTool({
  url,
  path: rawPath,
  overwrite = false,
  sha256,
  headers = {},
  timeout_ms,
  max_bytes,
} = {}, {
  userId = null,
  signal = null,
  validateUrl = assertSafeOutboundUrl,
  requestImpl = requestDownload,
} = {}) {
  assertToolPermitted(userId, 'file_download')
  if (typeof url !== 'string' || !url.trim()) {
    throw toolError('url 必填', 400, 'DOWNLOAD_URL_REQUIRED')
  }
  const expected = String(sha256 || '').trim().toLowerCase()
  if (expected && !/^[0-9a-f]{64}$/u.test(expected)) {
    throw toolError('sha256 必须是 64 位十六进制字符串', 400, 'DOWNLOAD_CHECKSUM_INVALID')
  }
  if (headers == null || typeof headers !== 'object' || Array.isArray(headers)) {
    throw toolError('headers 必须是对象', 400, 'DOWNLOAD_HEADERS_INVALID')
  }
  for (const key of Object.keys(headers)) {
    if (/^(?:authorization|cookie|proxy-authorization)$/iu.test(key)) {
      throw toolError(`不允许通过 file_download 发送敏感请求头: ${key}`, 400, 'DOWNLOAD_HEADER_DENIED')
    }
  }
  if (userId && !writeLimiter.tryConsume(userId, 'write')) {
    throw toolError('文件写入限流：超过 120 次/分钟', 429, 'DOWNLOAD_RATE_LIMITED')
  }
  const resolved = resolveForFileTool(rawPath, { userId, write: true, allowMissing: true })
  const destination = resolved.fullPath
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const timeoutMs = clampInteger(timeout_ms, DEFAULT_DOWNLOAD_TIMEOUT_MS, 1000, MAX_DOWNLOAD_TIMEOUT_MS)
  const maxBytes = clampInteger(max_bytes, configuredDownloadLimit(), 1, configuredDownloadLimit())
  const tempPath = path.join(
    path.dirname(destination),
    `.gugo-download-${process.pid}-${randomBytes(8).toString('hex')}.part`,
  )
  let response = null
  try {
    const opened = await openDownloadResponse(url, {
      headers,
      timeoutMs,
      signal,
      validateUrl,
      requestImpl,
    })
    response = opened.response
    const status = Number(response.statusCode || 0)
    if (status < 200 || status >= 300) {
      response.resume?.()
      throw toolError(`下载失败：HTTP ${status}`, 502, 'DOWNLOAD_HTTP_ERROR')
    }
    const declaredLength = Number(response.headers?.['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.destroy?.()
      throw toolError(`远程文件超过大小上限 ${maxBytes} 字节`, 413, 'DOWNLOAD_TOO_LARGE')
    }
    const hash = createHash('sha256')
    let bytes = 0
    const file = await fs.promises.open(tempPath, 'wx')
    try {
      for await (const chunk of response) {
        if (signal?.aborted) throw toolError('下载已取消', 499, 'DOWNLOAD_CANCELLED')
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > maxBytes) throw toolError(`远程文件超过大小上限 ${maxBytes} 字节`, 413, 'DOWNLOAD_TOO_LARGE')
        hash.update(buffer)
        await file.write(buffer)
      }
    } catch (error) {
      response.destroy?.()
      throw error
    } finally {
      await file.close()
    }
    const digest = hash.digest('hex')
    if (expected && digest !== expected) {
      throw toolError('下载文件 SHA-256 校验失败', 422, 'DOWNLOAD_CHECKSUM_MISMATCH')
    }
    await commitDownloadedFile(tempPath, destination, overwrite === true)
    return {
      ok: true,
      path: resolved.displayPath,
      scope: resolved.source,
      bytes,
      sha256: digest,
      contentType: String(response.headers?.['content-type'] || ''),
      finalUrl: opened.finalUrl,
      changedPaths: [resolved.displayPath],
    }
  } finally {
    response?.destroy?.()
    try { await fs.promises.rm(tempPath, { force: true }) } catch { /* best-effort cleanup */ }
  }
}

export async function dispatchCodingAgentTool(name, args = {}, context = {}) {
  switch (name) {
    case 'run_command': return runCommandTool({ ...args, userId: context.userId, signal: context.signal })
    case 'patch_file': return patchFileTool({ ...args, userId: context.userId })
    case 'run_test': return runTestTool({ ...args, userId: context.userId, signal: context.signal })
    case 'docker_exec': return dockerExecTool({ ...args, userId: context.userId, signal: context.signal })
    case 'file_download': return fileDownloadTool(args, context)
    default: throw toolError(`未知 coding 工具: ${name}`, 404, 'CODING_TOOL_NOT_FOUND')
  }
}

export const CODING_AGENT_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command in the authorized workspace with timeout, cancellation, process-tree cleanup, stdout, stderr, and exit code. Use this for Python, Node, npm, PowerShell, builds, and arbitrary project commands. Declare files that should change in expected_outputs. env_keys can forward named host credentials only after high-risk approval; credential values are never accepted in arguments or added to structured results.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cmd: { type: 'string', description: 'Compatibility alias for command.' },
          cwd: { type: 'string', description: 'Workspace-relative or authorized absolute working directory.' },
          timeout_ms: { type: 'integer', minimum: 1000 },
          expected_outputs: { type: 'array', items: { type: 'string' }, description: 'Files expected to be created or modified; omit for read-only commands.' },
          env_keys: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, uniqueItems: true, maxItems: 32, description: 'Host environment variable names to forward after high-risk approval. Pass names only; values are neither accepted here nor added to structured results. Gugo service/model credentials are always prohibited.' },
        },
        anyOf: [{ required: ['command'] }, { required: ['cmd'] }],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Safely patch files either with a Codex-style atomic patch string or by replacing an exact inclusive line range. Supports dry-run and an optional SHA-256 precondition to prevent stale writes.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Codex patch text beginning with *** Begin Patch.' },
          path: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 0 },
          replacement: { type: 'string' },
          expected_sha256: { type: 'string' },
          dry_run: { type: 'boolean', default: false },
        },
        anyOf: [
          { required: ['patch'] },
          { required: ['path', 'start_line', 'end_line', 'replacement'] },
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_test',
      description: 'Run project tests in the authorized workspace and return pass/fail, exit code, stdout/stderr, and a parsed summary. Auto-detects npm, pytest, Cargo, Go, Maven, or Gradle; a custom command is allowed when needed. env_keys can forward named host credentials only after high-risk approval; credential values are never accepted in arguments or added to structured results.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Optional custom test command. Omit to auto-detect.' },
          framework: { type: 'string', enum: ['auto', 'npm', 'pytest', 'cargo', 'go', 'maven', 'gradle', 'custom'], default: 'auto' },
          cwd: { type: 'string', description: 'Workspace-relative or authorized absolute project directory.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_TEST_TIMEOUT_MS },
          env_keys: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, uniqueItems: true, maxItems: 32, description: 'Host environment variable names to forward after high-risk approval. Pass names only; values are neither accepted here nor added to structured results. Gugo service/model credentials are always prohibited.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docker_exec',
      description: 'Execute a command in an existing Docker container through the system Docker CLI. Returns stdout, stderr, exit code, timeout, and cancellation state. Requires shell authorization and per-call approval. env configures explicit variables inside the container; env_keys separately forwards named host credentials to the Docker CLI only after high-risk approval, without accepting or adding their values to structured results.',
      parameters: {
        type: 'object',
        properties: {
          container: { type: 'string', description: 'Docker container name or ID.' },
          command: {
            oneOf: [
              { type: 'string', description: 'Command interpreted by /bin/sh -lc (cmd.exe /c for Windows containers).' },
              { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Exact executable and argument array.' },
            ],
          },
          workdir: { type: 'string', description: 'Optional working directory inside the container.' },
          env: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
          container_os: { type: 'string', enum: ['linux', 'windows'], default: 'linux', description: 'Container OS used only for string commands; arrays remain exact argv.' },
          env_keys: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, uniqueItems: true, maxItems: 32, description: 'Host environment variable names for the Docker CLI after high-risk approval. This is separate from container env; pass names only and values are never added to structured results. Gugo service/model credentials are always prohibited.' },
          cwd: { type: 'string', description: 'Authorized host directory used only to launch docker.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_DOCKER_TIMEOUT_MS },
          expected_outputs: { type: 'array', items: { type: 'string' }, description: 'Optional authorized host files expected to change through mounted volumes.' },
        },
        required: ['container', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_download',
      description: 'Download an HTTP/HTTPS binary file directly into an authorized local path with streaming, redirect/SSRF protection, an atomic write, size limit, and optional SHA-256 verification. Unlike fetch_url, this preserves binary data and supports large files.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          path: { type: 'string', description: 'Workspace-relative or authorized absolute destination file.' },
          overwrite: { type: 'boolean', default: false },
          sha256: { type: 'string', description: 'Optional expected lowercase/uppercase SHA-256 hex digest.' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional non-sensitive request headers.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_DOWNLOAD_TIMEOUT_MS },
          max_bytes: { type: 'integer', minimum: 1, maximum: HARD_DOWNLOAD_MAX_BYTES },
        },
        required: ['url', 'path'],
      },
    },
  },
]

export const _internals = {
  inferTestCommand,
  parseTestSummary,
  normalizeLinePatch,
  redactForwardedEnvValues,
  dockerCommand,
  findDockerCli,
  commitDownloadedFile,
  requestDownload,
  openDownloadResponse,
}
