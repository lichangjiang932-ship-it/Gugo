import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import { resolveForFileTool } from './fsShellTools.js'

const require = createRequire(import.meta.url)

export const MEDIA_OPERATIONS = Object.freeze([
  'trim',
  'transcode',
  'extract_frame',
  'extract_audio',
  'change_speed',
  'generate_gif',
  'add_subtitles',
  'concat',
  'adjust_audio',
  'denoise_audio',
])

export const DEFAULT_PROBE_TIMEOUT_MS = 30_000
export const DEFAULT_TRANSFORM_TIMEOUT_MS = 10 * 60_000
export const MAX_TIMEOUT_MS = 30 * 60_000
export const MAX_CONCAT_INPUTS = 100
export const MIN_PLAYBACK_SPEED = 0.25
export const MAX_PLAYBACK_SPEED = 4
export const MAX_GIF_DURATION_SECONDS = 120

const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024
const PROCESS_KILL_GRACE_MS = 1_000

const OUTPUT_EXTENSION_MUXERS = Object.freeze({
  '.mp4': 'mp4',
  '.m4v': 'mp4',
  '.m4a': 'mp4',
  '.mov': 'mov',
  '.mkv': 'matroska',
  '.mka': 'matroska',
  '.webm': 'webm',
  '.avi': 'avi',
  '.mpg': 'mpeg',
  '.mpeg': 'mpeg',
  '.ts': 'mpegts',
  '.mp3': 'mp3',
  '.wav': 'wav',
  '.flac': 'flac',
  '.aac': 'adts',
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.ogv': 'ogg',
  '.opus': 'opus',
  '.gif': 'gif',
  '.png': 'apng',
  '.apng': 'apng',
  '.jpg': 'singlejpeg',
  '.jpeg': 'singlejpeg',
  '.webp': 'webp',
})

export const EXPLICIT_SINGLE_FILE_MUXERS = Object.freeze({
  mp4: 'mp4',
  mov: 'mov',
  matroska: 'matroska',
  mkv: 'matroska',
  webm: 'webm',
  avi: 'avi',
  mpeg: 'mpeg',
  mpegts: 'mpegts',
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  adts: 'adts',
  aac: 'adts',
  ogg: 'ogg',
  opus: 'opus',
  gif: 'gif',
  png: 'apng',
  apng: 'apng',
  jpg: 'singlejpeg',
  jpeg: 'singlejpeg',
  singlejpeg: 'singlejpeg',
  webp: 'webp',
})

export function toolError(message, {
  code = 'MEDIA_INVALID_ARGUMENT',
  statusCode = 400,
  retryable = false,
  hint = null,
} = {}) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  error.retryable = retryable
  if (hint) error.hint = hint
  return error
}

function isExecutableFile(candidate) {
  if (!candidate) return false
  try {
    const stat = fs.statSync(candidate)
    if (!stat.isFile()) return false
    fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function pathExtensions(command) {
  if (process.platform !== 'win32') return ['']
  if (path.extname(command)) return ['']
  const configured = String(process.env.PATHEXT || '.EXE;.COM')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => /^\.(?:exe|com)$/i.test(item))
  return configured.length ? configured : ['.EXE', '.COM']
}

function findOnPath(command) {
  const raw = String(command || '').trim().replace(/^"|"$/g, '')
  if (!raw) return null
  if (path.isAbsolute(raw) || raw.includes('/') || raw.includes('\\')) {
    return isExecutableFile(raw) ? path.resolve(raw) : null
  }
  const pathValue = process.env.PATH || process.env.Path || ''
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '')
    if (!directory) continue
    for (const extension of pathExtensions(raw)) {
      const candidate = path.join(directory, `${raw}${extension}`)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

function packageBinary(kind) {
  const packages = kind === 'ffmpeg'
    ? ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']
    : ['ffprobe-static', '@ffprobe-installer/ffprobe']
  for (const packageName of packages) {
    try {
      const loaded = require(packageName)
      const candidate = typeof loaded === 'string'
        ? loaded
        : loaded?.path || loaded?.default?.path || loaded?.default
      if (typeof candidate === 'string' && isExecutableFile(candidate)) return candidate
    } catch {
      // Optional package is absent or unsupported on this platform.
    }
  }
  return null
}

export function resolveMediaBinary(kind) {
  const upper = kind.toUpperCase()
  const configured = String(process.env[`GUGO_${upper}_PATH`] || '').trim()
  const configuredPath = configured ? findOnPath(configured) : null
  if (configuredPath) return configuredPath

  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath.trim() : ''
  if (resourcesPath) {
    const names = process.platform === 'win32' ? [`${kind}.exe`, kind] : [kind]
    for (const name of names) {
      const candidate = path.join(resourcesPath, 'bin', name)
      if (isExecutableFile(candidate)) return candidate
    }
  }

  const packaged = packageBinary(kind)
  if (packaged) return packaged
  const fromPath = findOnPath(kind)
  if (fromPath) return fromPath

  throw toolError(`${kind} executable was not found`, {
    code: 'MEDIA_BINARY_NOT_FOUND',
    statusCode: 503,
    hint: `Set GUGO_${upper}_PATH, bundle ${kind} under process.resourcesPath/bin, install an optional static package, or add ${kind} to PATH.`,
  })
}

export function normalizeTimeout(value, fallback) {
  if (value == null || value === '') return fallback
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS) {
    throw toolError(`timeout_ms must be between 1000 and ${MAX_TIMEOUT_MS}`)
  }
  return Math.floor(timeout)
}

export function finiteNumber(value, name, {
  required = false,
  defaultValue = undefined,
  min = -Infinity,
  max = Infinity,
  minExclusive = false,
} = {}) {
  if (value == null || value === '') {
    if (required) throw toolError(`${name} is required`)
    return defaultValue
  }
  const number = Number(value)
  const belowMinimum = minExclusive ? number <= min : number < min
  if (!Number.isFinite(number) || belowMinimum || number > max) {
    const lower = minExclusive ? `greater than ${min}` : `at least ${min}`
    throw toolError(`${name} must be a finite number ${lower} and at most ${max}`)
  }
  return number
}

export function finiteInteger(value, name, options = {}) {
  const number = finiteNumber(value, name, options)
  if (number == null) return number
  if (!Number.isInteger(number)) throw toolError(`${name} 必须是整数`)
  return number
}

export function safeToken(value, name) {
  if (value == null || value === '') return null
  const token = String(value).trim()
  if (!token || token.startsWith('-') || !/^[a-zA-Z0-9_.:+-]{1,80}$/.test(token)) {
    throw toolError(`${name} contains unsupported characters`)
  }
  return token
}

export function resolveSafeOutputMuxer(outputPath, requestedFormat) {
  const extension = path.extname(outputPath).toLowerCase()
  const hasRequestedFormat = requestedFormat != null && String(requestedFormat).trim() !== ''
  if (extension) {
    if (hasRequestedFormat) {
      throw toolError('output_path 已有扩展名时不允许再设置 format', {
        code: 'MEDIA_FORMAT_WITH_EXTENSION',
        hint: '请删除 format，让工具根据受支持的输出扩展名选择安全的单文件封装格式。',
      })
    }
    if (!Object.hasOwn(OUTPUT_EXTENSION_MUXERS, extension)) {
      throw toolError(`不支持或不安全的媒体输出扩展名：${extension}`, {
        code: 'MEDIA_OUTPUT_EXTENSION_UNSUPPORTED',
        hint: `允许的扩展名：${Object.keys(OUTPUT_EXTENSION_MUXERS).join(', ')}`,
      })
    }
    return OUTPUT_EXTENSION_MUXERS[extension]
  }

  if (!hasRequestedFormat) {
    throw toolError('output_path 没有扩展名时必须设置安全的单文件 format', {
      code: 'MEDIA_OUTPUT_FORMAT_REQUIRED',
      hint: `允许的 format：${Object.keys(EXPLICIT_SINGLE_FILE_MUXERS).join(', ')}`,
    })
  }
  const requested = safeToken(requestedFormat, 'format').toLowerCase()
  if (!Object.hasOwn(EXPLICIT_SINGLE_FILE_MUXERS, requested)) {
    throw toolError(`format=${requested} 不是允许的单文件封装格式`, {
      code: 'MEDIA_OUTPUT_MUXER_UNSAFE',
      hint: `tee、hls、dash、segment、fifo、image2 等多输出或流式 muxer 已禁用。允许的 format：${Object.keys(EXPLICIT_SINGLE_FILE_MUXERS).join(', ')}`,
    })
  }
  return EXPLICIT_SINGLE_FILE_MUXERS[requested]
}

export function samePath(left, right) {
  const a = path.normalize(path.resolve(left))
  const b = path.normalize(path.resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function resolveInput(rawPath, userId) {
  const resolved = resolveForFileTool(rawPath, { userId, write: false })
  let stat
  try { stat = fs.statSync(resolved.fullPath) } catch {
    throw toolError(`input does not exist: ${rawPath}`, { code: 'MEDIA_INPUT_NOT_FOUND', statusCode: 404 })
  }
  if (!stat.isFile()) throw toolError(`input is not a file: ${rawPath}`, { code: 'MEDIA_INPUT_NOT_FILE' })
  return { ...resolved, size: stat.size }
}

export function resolveOutput(rawPath, { userId, overwrite }) {
  const resolved = resolveForFileTool(rawPath, { userId, write: true, allowMissing: true })
  if (fs.existsSync(resolved.fullPath)) {
    const stat = fs.statSync(resolved.fullPath)
    if (!stat.isFile()) throw toolError(`output is not a file: ${rawPath}`, { code: 'MEDIA_OUTPUT_NOT_FILE' })
    if (!overwrite) {
      throw toolError(`output already exists: ${rawPath}`, {
        code: 'MEDIA_OUTPUT_EXISTS',
        statusCode: 409,
        hint: 'Choose a new output_path or explicitly set overwrite=true.',
      })
    }
  }
  return resolved
}

export function uniqueSiblingPath(outputPath, label, extension = '') {
  const directory = path.dirname(outputPath)
  const base = path.basename(outputPath, path.extname(outputPath)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'media'
  const token = crypto.randomBytes(8).toString('hex')
  return path.join(directory, `.${base}.${process.pid}.${token}.${label}${extension}`)
}

function appendLimited(chunks, chunk, state) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const remaining = MAX_PROCESS_OUTPUT_BYTES - state.bytes
  if (remaining <= 0) {
    state.limited = true
    return
  }
  const accepted = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer
  chunks.push(accepted)
  state.bytes += accepted.length
  if (accepted.length !== buffer.length) state.limited = true
}

export function runBinary(executable, args, {
  cwd,
  signal = null,
  timeout,
  onOutput = null,
} = {}) {
  if (signal?.aborted) {
    return Promise.resolve({
      stdout: '', stderr: '', code: null, aborted: true, timedOut: false, outputLimited: false,
    })
  }

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: sanitizeChildEnv(),
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdoutChunks = []
    const stderrChunks = []
    const outputState = { bytes: 0, limited: false }
    let settled = false
    let timedOut = false
    let aborted = false
    let forceKillTimer = null

    const kill = (force = false) => {
      if (settled || child.pid == null) return
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            env: sanitizeChildEnv(),
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
          })
          killer.on('error', () => {
            try { child.kill('SIGKILL') } catch { /* already exited */ }
          })
          killer.unref()
        } else {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
        }
      } catch {
        try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* already exited */ }
      }
      if (!force && !forceKillTimer) {
        forceKillTimer = setTimeout(() => kill(true), PROCESS_KILL_GRACE_MS)
        forceKillTimer.unref?.()
      }
    }

    const collect = (chunks, which) => (chunk) => {
      if (typeof onOutput === 'function') {
        try { onOutput({ stream: which, chunk: String(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) }) } catch { /* best-effort */ }
      }
      appendLimited(chunks, chunk, outputState)
      if (outputState.limited) kill()
    }
    child.stdout?.on('data', collect(stdoutChunks, 'stdout'))
    child.stderr?.on('data', collect(stderrChunks, 'stderr'))

    const abortListener = () => {
      aborted = true
      kill()
    }
    signal?.addEventListener('abort', abortListener, { once: true })

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeout)
    timeoutTimer.unref?.()

    const finish = (code, spawnError = null) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      signal?.removeEventListener('abort', abortListener)
      if (spawnError) appendLimited(stderrChunks, Buffer.from(spawnError.message || String(spawnError)), outputState)
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code: typeof code === 'number' ? code : null,
        aborted,
        timedOut,
        outputLimited: outputState.limited,
      })
    }

    child.once('error', (error) => finish(null, error))
    child.once('close', (code) => finish(code))
  })
}

export function processFailure(result, executable, {
  operation = null,
  concatMode = 'copy',
} = {}) {
  if (result.aborted) return { ok: false, cancelled: true, code: 'MEDIA_CANCELLED', error: '媒体处理已取消' }
  if (result.timedOut) return { ok: false, timedOut: true, code: 'MEDIA_TIMEOUT', error: '媒体处理超时' }
  if (result.outputLimited) {
    return { ok: false, code: 'MEDIA_OUTPUT_LIMIT', error: `媒体进程输出超过 ${MAX_PROCESS_OUTPUT_BYTES} 字节上限` }
  }
  const detail = String(result.stderr || result.stdout || '').trim()
  const failure = {
    ok: false,
    code: result.code == null ? 'MEDIA_BINARY_START_FAILED' : 'MEDIA_PROCESS_FAILED',
    error: detail || `${path.basename(executable)} 异常退出（代码 ${result.code}）`,
    exitCode: result.code,
  }
  if (operation === 'concat' && concatMode === 'copy') {
    failure.error = detail ? `媒体无法直接无损拼接。FFmpeg 详情：${detail}` : '媒体无法直接无损拼接'
    failure.hint = '请确认各片段的视频/音频编码、分辨率和采样参数一致；不一致时设置 concat_mode="reencode" 重新编码拼接。'
  }
  if (operation === 'concat' && concatMode === 'reencode') {
    failure.error = detail ? `媒体重新编码拼接失败。FFmpeg 详情：${detail}` : '媒体重新编码拼接失败'
    failure.hint = '请确认所有片段都具有一致的流类型，并显式指定输出容器支持的 video_codec/audio_codec。'
  }
  if (operation === 'extract_audio') {
    failure.error = detail ? `提取音频失败。FFmpeg 详情：${detail}` : '提取音频失败'
    failure.hint = '请确认输入含有音轨、audio_stream_index 正确，且输出格式支持所选 audio_codec。'
  }
  if (operation === 'change_speed') {
    failure.error = detail ? `媒体变速失败。FFmpeg 详情：${detail}` : '媒体变速失败'
    failure.hint = '请确认输出格式支持所选编码器；需要滤镜处理，因此 video_codec/audio_codec 不能设为 copy。'
  }
  if (operation === 'generate_gif') {
    failure.error = detail ? `生成 GIF 失败。FFmpeg 详情：${detail}` : '生成 GIF 失败'
    failure.hint = '请确认输入含有视频流，并适当减小 duration_seconds、fps 或 width。'
  }
  if (operation === 'add_subtitles') {
    failure.error = detail ? `烧录字幕失败。FFmpeg 详情：${detail}` : '烧录字幕失败'
    failure.hint = '请确认 FFmpeg 已启用 libass、字幕文件为 UTF-8 SRT/ASS，并检查字幕语法和字体可用性。'
  }
  return failure
}

function escapeConcatPath(filePath) {
  const normalized = path.resolve(filePath).replaceAll('\\', '/')
  if (/[\0\r\n]/.test(normalized)) throw toolError('concat input path contains unsupported control characters')
  return `'${normalized.replaceAll("'", "'\\''")}'`
}

export function writeConcatList(listPath, inputs) {
  const contents = [
    'ffconcat version 1.0',
    ...inputs.map((input) => `file ${escapeConcatPath(input.fullPath)}`),
    '',
  ].join('\n')
  fs.writeFileSync(listPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}

export function commitOutput(tempPath, outputPath, overwrite) {
  if (overwrite) {
    fs.renameSync(tempPath, outputPath)
    return
  }
  try {
    fs.linkSync(tempPath, outputPath)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw toolError(`output already exists: ${outputPath}`, {
        code: 'MEDIA_OUTPUT_EXISTS',
        statusCode: 409,
      })
    }
    throw error
  }
  fs.unlinkSync(tempPath)
}
