import fs from 'node:fs'
import path from 'node:path'

export const WINDOWS_CONTROL_FRAME_MAGIC = 'GUGOCTRL'
export const WINDOWS_CONTROL_FRAME_VERSION = 1
export const WINDOWS_CONTROL_FRAME_MAX_PAYLOAD_BYTES = 1024 * 1024
export const WINDOWS_ENV_VALUE_MAX_LENGTH = 8_000

const CONTROL_MAGIC_BYTES = Buffer.from(WINDOWS_CONTROL_FRAME_MAGIC, 'ascii')
const CONTROL_HEADER_BYTES = CONTROL_MAGIC_BYTES.length + 1 + 4
const PERSISTENT_ENV_DENYLIST = new Set([
  'ERRORLEVEL',
  'CD',
  'CMDCMDLINE',
  'CMDEXTVERSION',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_PATH',
])
const INTERNAL_ENV_PREFIX = '__GUGO_'

function environmentEntries(environment) {
  if (!environment) return []
  if (environment instanceof Map) return [...environment.entries()]
  return Object.entries(environment)
}

function environmentKey(value) {
  return String(value).toUpperCase()
}

function assignEnvironment(target, keyIndex, rawKey, rawValue) {
  const key = String(rawKey)
  if (!key) return
  const normalizedKey = environmentKey(key)
  const previousKey = keyIndex.get(normalizedKey)
  if (previousKey !== undefined && previousKey !== key) delete target[previousKey]
  if (rawValue === undefined || rawValue === null) {
    keyIndex.delete(normalizedKey)
    return
  }
  target[key] = String(rawValue)
  keyIndex.set(normalizedKey, key)
}

export function mergeWindowsEnvironment(baseEnvironment = {}, overlayEnvironment = {}) {
  const merged = {}
  const keyIndex = new Map()
  for (const [key, value] of environmentEntries(baseEnvironment)) {
    assignEnvironment(merged, keyIndex, key, value)
  }
  for (const [key, value] of environmentEntries(overlayEnvironment)) {
    assignEnvironment(merged, keyIndex, key, value)
  }
  return merged
}

function persistentEnvironmentKeyAllowed(rawKey) {
  const key = String(rawKey || '')
  if (!key || key.startsWith('=')) return false
  const normalizedKey = environmentKey(key)
  return !PERSISTENT_ENV_DENYLIST.has(normalizedKey)
    && !normalizedKey.startsWith(INTERNAL_ENV_PREFIX)
}

export function filterWindowsPersistentEnvironment(environment = {}) {
  const filtered = {}
  const keyIndex = new Map()
  for (const [key, value] of environmentEntries(environment)) {
    if (!persistentEnvironmentKeyAllowed(key)) continue
    assignEnvironment(filtered, keyIndex, key, value)
  }
  return filtered
}

export function restoreWindowsEphemeralEnvironment(
  reportedEnvironment = {},
  previousEnvironment = {},
  ephemeralEnvironment = {},
) {
  const restored = mergeWindowsEnvironment({}, reportedEnvironment)
  const restoredIndex = new Map(Object.keys(restored).map((key) => [environmentKey(key), key]))
  const previousIndex = new Map(
    environmentEntries(previousEnvironment)
      .map(([key, value]) => [environmentKey(key), [String(key), value]]),
  )
  for (const [ephemeralKey] of environmentEntries(ephemeralEnvironment)) {
    const normalizedKey = environmentKey(ephemeralKey)
    const currentKey = restoredIndex.get(normalizedKey)
    if (currentKey !== undefined) delete restored[currentKey]
    restoredIndex.delete(normalizedKey)
    const previous = previousIndex.get(normalizedKey)
    if (previous && previous[1] !== undefined && previous[1] !== null) {
      assignEnvironment(restored, restoredIndex, previous[0], previous[1])
    }
  }
  return filterWindowsPersistentEnvironment(restored)
}

export function normalizeWindowsEphemeralEnvironment(environment = {}) {
  const normalized = {}
  for (const [key, value] of Object.entries(environment || {})) {
    const text = String(value).replace(/[\r\n]+/gu, ' ')
    if (text.length > WINDOWS_ENV_VALUE_MAX_LENGTH) {
      const error = new Error(
        `环境变量 ${key || '<unknown>'} 超过 Windows 持久 Shell 的 ${WINDOWS_ENV_VALUE_MAX_LENGTH} 字符安全上限`,
      )
      error.code = 'SHELL_ENV_VALUE_TOO_LONG'
      throw error
    }
    normalized[key] = text
  }
  return normalized
}

function protocolError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function validateControlPayload(payload, expectedToken, expectedExitCode) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw protocolError('SHELL_CONTROL_PAYLOAD_INVALID', 'Windows Shell 控制帧负载必须是对象')
  }
  const keys = Object.keys(payload).sort()
  if (keys.join('\0') !== ['cwd', 'env', 'exitCode', 'token'].join('\0')) {
    throw protocolError('SHELL_CONTROL_PAYLOAD_INVALID', 'Windows Shell 控制帧字段不完整或包含未知字段')
  }
  if (typeof payload.token !== 'string' || !payload.token || payload.token.length > 256) {
    throw protocolError('SHELL_CONTROL_PAYLOAD_INVALID', 'Windows Shell 控制帧 token 无效')
  }
  if (expectedToken !== undefined && payload.token !== expectedToken) {
    throw protocolError('SHELL_CONTROL_TOKEN_MISMATCH', 'Windows Shell 控制帧 token 不匹配')
  }
  if (!Number.isSafeInteger(payload.exitCode)) {
    throw protocolError('SHELL_CONTROL_PAYLOAD_INVALID', 'Windows Shell 控制帧退出码无效')
  }
  if (expectedExitCode !== undefined && payload.exitCode !== expectedExitCode) {
    throw protocolError('SHELL_CONTROL_EXIT_CODE_MISMATCH', 'Windows Shell 控制帧退出码与子进程不一致')
  }
  if (typeof payload.cwd !== 'string' || !payload.cwd || payload.cwd.includes('\0')) {
    throw protocolError('SHELL_CONTROL_PAYLOAD_INVALID', 'Windows Shell 控制帧 cwd 无效')
  }
  if (!payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) {
    throw protocolError('SHELL_CONTROL_PAYLOAD_INVALID', 'Windows Shell 控制帧 env 无效')
  }
  for (const [key, value] of Object.entries(payload.env)) {
    if (!key || key.includes('\0') || typeof value !== 'string' || value.includes('\0')) {
      throw protocolError('SHELL_CONTROL_PAYLOAD_INVALID', 'Windows Shell 控制帧包含无效环境变量')
    }
  }
  return payload
}

export function encodeWindowsControlFrame(payload, {
  maxPayloadBytes = WINDOWS_CONTROL_FRAME_MAX_PAYLOAD_BYTES,
} = {}) {
  validateControlPayload(payload)
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
  if (payloadBytes.length > maxPayloadBytes) {
    throw protocolError('SHELL_CONTROL_FRAME_TOO_LARGE', 'Windows Shell 控制帧超过安全上限')
  }
  const frame = Buffer.allocUnsafe(CONTROL_HEADER_BYTES + payloadBytes.length)
  CONTROL_MAGIC_BYTES.copy(frame, 0)
  frame[CONTROL_MAGIC_BYTES.length] = WINDOWS_CONTROL_FRAME_VERSION
  frame.writeUInt32BE(payloadBytes.length, CONTROL_MAGIC_BYTES.length + 1)
  payloadBytes.copy(frame, CONTROL_HEADER_BYTES)
  return frame
}

export function parseWindowsControlFrame(frame, {
  expectedToken,
  expectedExitCode,
  maxPayloadBytes = WINDOWS_CONTROL_FRAME_MAX_PAYLOAD_BYTES,
} = {}) {
  if (!Buffer.isBuffer(frame)) {
    throw protocolError('SHELL_CONTROL_FRAME_INVALID', 'Windows Shell 控制帧必须是 Buffer')
  }
  if (frame.length === 0) {
    throw protocolError('SHELL_CONTROL_FRAME_MISSING', 'Windows Shell 未返回控制帧')
  }
  if (frame.length < CONTROL_HEADER_BYTES) {
    throw protocolError('SHELL_CONTROL_FRAME_TRUNCATED', 'Windows Shell 控制帧头被截断')
  }
  if (!frame.subarray(0, CONTROL_MAGIC_BYTES.length).equals(CONTROL_MAGIC_BYTES)) {
    throw protocolError('SHELL_CONTROL_FRAME_MAGIC_INVALID', 'Windows Shell 控制帧 magic 无效')
  }
  if (frame[CONTROL_MAGIC_BYTES.length] !== WINDOWS_CONTROL_FRAME_VERSION) {
    throw protocolError('SHELL_CONTROL_FRAME_VERSION_UNSUPPORTED', 'Windows Shell 控制帧版本不受支持')
  }
  const payloadLength = frame.readUInt32BE(CONTROL_MAGIC_BYTES.length + 1)
  if (payloadLength > maxPayloadBytes) {
    throw protocolError('SHELL_CONTROL_FRAME_TOO_LARGE', 'Windows Shell 控制帧超过安全上限')
  }
  const expectedLength = CONTROL_HEADER_BYTES + payloadLength
  if (frame.length < expectedLength) {
    throw protocolError('SHELL_CONTROL_FRAME_TRUNCATED', 'Windows Shell 控制帧负载被截断')
  }
  if (frame.length > expectedLength) {
    throw protocolError('SHELL_CONTROL_FRAME_TRAILING_DATA', 'Windows Shell 控制帧包含尾随数据')
  }
  let json
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(CONTROL_HEADER_BYTES))
  } catch {
    throw protocolError('SHELL_CONTROL_FRAME_UTF8_INVALID', 'Windows Shell 控制帧不是有效 UTF-8')
  }
  let payload
  try {
    payload = JSON.parse(json)
  } catch {
    throw protocolError('SHELL_CONTROL_FRAME_JSON_INVALID', 'Windows Shell 控制帧不是有效 JSON')
  }
  return validateControlPayload(payload, expectedToken, expectedExitCode)
}

function sameOrInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function canonicalPathKey(value) {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function canonicalizeWindowsSessionCwd(rootPath, candidatePath, { fileSystem = fs } = {}) {
  let canonicalRoot
  let canonicalCwd
  try {
    canonicalRoot = fileSystem.realpathSync(rootPath)
    canonicalCwd = fileSystem.realpathSync(candidatePath)
  } catch {
    throw protocolError('SHELL_CWD_INVALID', 'Windows Shell 返回的当前目录不存在或无法解析')
  }
  if (canonicalPathKey(canonicalRoot) !== canonicalPathKey(rootPath)) {
    throw protocolError('SHELL_ROOT_IDENTITY_CHANGED', 'Windows Shell 授权根已被替换或重定向')
  }
  if (!fileSystem.statSync(canonicalRoot).isDirectory() || !fileSystem.statSync(canonicalCwd).isDirectory()) {
    throw protocolError('SHELL_CWD_INVALID', 'Windows Shell 的授权根和当前目录必须是目录')
  }
  if (!sameOrInside(canonicalRoot, canonicalCwd)) {
    throw protocolError('SHELL_CWD_BOUNDARY_VIOLATION', 'Windows Shell 当前目录越出授权根')
  }
  return canonicalCwd
}

function exitCodeEnvName(token) {
  return `__GUGO_${String(token).toUpperCase()}_EXIT_CODE`
}

export function buildWindowsNodeReporter(token) {
  const exitCodeName = exitCodeEnvName(token)
  const magicBase64 = CONTROL_MAGIC_BYTES.toString('base64')
  return [
    "'use strict'",
    "const fs = require('node:fs')",
    `const token = ${JSON.stringify(String(token))}`,
    `const exitCodeName = ${JSON.stringify(exitCodeName)}`,
    'const exitCodeText = String(process.env[exitCodeName] || "")',
    'if (!/^-?[0-9]+$/.test(exitCodeText)) process.exit(2)',
    'const exitCodeValue = BigInt(exitCodeText)',
    'if (exitCodeValue < -2147483648n || exitCodeValue > 4294967295n) process.exit(2)',
    'const exitCode = Number(BigInt.asUintN(32, exitCodeValue))',
    'const environment = { ...process.env }',
    'for (const key of Object.keys(environment)) {',
    "  if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete environment[key]",
    '}',
    'const payload = Buffer.from(JSON.stringify({ token, exitCode, cwd: process.cwd(), env: environment }), "utf8")',
    `if (payload.length > ${WINDOWS_CONTROL_FRAME_MAX_PAYLOAD_BYTES}) process.exit(3)`,
    `const magic = Buffer.from('${magicBase64}', 'base64')`,
    `const frame = Buffer.allocUnsafe(${CONTROL_HEADER_BYTES} + payload.length)`,
    'magic.copy(frame, 0)',
    `frame[${CONTROL_MAGIC_BYTES.length}] = ${WINDOWS_CONTROL_FRAME_VERSION}`,
    `frame.writeUInt32BE(payload.length, ${CONTROL_MAGIC_BYTES.length + 1})`,
    `payload.copy(frame, ${CONTROL_HEADER_BYTES})`,
    'fs.writeSync(1, frame)',
    'process.exitCode = exitCode > 0x7fffffff ? exitCode - 0x100000000 : exitCode',
    '',
  ].join('\n')
}

function trustedCmdPath(value) {
  const text = String(value || '')
  if (!text || /[\r\n"%^]/u.test(text)) {
    throw protocolError(
      'SHELL_COMMAND_PATH_UNSAFE',
      'Windows Shell 可信命令路径包含 cmd.exe 无法安全引用的字符',
    )
  }
  return `"${text}"`
}

/** The on-disk file contains only untrusted user command text. */
export function buildWindowsUserCommandFile(command) {
  return `${String(command || '').replace(/\r?\n/gu, '\r\n')}\r\n`
}

/** Build trusted stdin lines; the untrusted command receives EOF and no fd3. */
function buildWindowsTrustedInput({ commandFile, token }) {
  const commandPath = trustedCmdPath(commandFile)
  const exitCodeName = exitCodeEnvName(token)
  const nodeRuntime = trustedCmdPath(process.execPath)
  const encodedReporter = Buffer.from(buildWindowsNodeReporter(token), 'utf8').toString('base64')
  return [
    '@echo off',
    'set "ERRORLEVEL="',
    `set "${exitCodeName}="`,
    'setlocal DisableDelayedExpansion',
    'ver > nul',
    `call ${commandPath} < nul 3> nul`,
    'set "ERRORLEVEL="',
    `set "${exitCodeName}=%errorlevel%"`,
    'set "NODE_OPTIONS="',
    'set "NODE_PATH="',
    `set "ELECTRON_RUN_AS_NODE=${process.versions.electron ? '1' : ''}"`,
    `${nodeRuntime} -e "eval(Buffer.from('${encodedReporter}','base64').toString('utf8'))" 2> nul 1>&3`,
    `endlocal&exit /b %${exitCodeName}%`,
  ].join('\r\n') + '\r\n'
}

export function buildWindowsTrustedInvocation({ commandFile, token }) {
  return {
    shellPath: process.env.COMSPEC || 'cmd.exe',
    shellArgs: [
      '/d',
      '/q',
      '/v:off',
      '/s',
      '/k',
      '@echo off & chcp 65001 > nul & prompt $S',
    ],
    stdinInput: buildWindowsTrustedInput({ commandFile, token }),
    windowsVerbatimArguments: true,
  }
}
