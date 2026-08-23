import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import { resolveForFileTool } from './fsShellTools.js'

const require = createRequire(import.meta.url)

const MEDIA_OPERATIONS = Object.freeze([
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

const DEFAULT_PROBE_TIMEOUT_MS = 30_000
const DEFAULT_TRANSFORM_TIMEOUT_MS = 10 * 60_000
const MAX_TIMEOUT_MS = 30 * 60_000
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_CONCAT_INPUTS = 100
const PROCESS_KILL_GRACE_MS = 1_000
const MIN_PLAYBACK_SPEED = 0.25
const MAX_PLAYBACK_SPEED = 4
const MAX_GIF_DURATION_SECONDS = 120

// Only muxers that produce exactly one ordinary file are permitted. Forcing a
// known muxer is important even when an extension is present: otherwise FFmpeg
// can infer HLS/DASH/segment/image2 and leave side files outside the atomic temp
// output contract.
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

const EXPLICIT_SINGLE_FILE_MUXERS = Object.freeze({
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

function toolError(message, {
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

function resolveMediaBinary(kind) {
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

function normalizeTimeout(value, fallback) {
  if (value == null || value === '') return fallback
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS) {
    throw toolError(`timeout_ms must be between 1000 and ${MAX_TIMEOUT_MS}`)
  }
  return Math.floor(timeout)
}

function finiteNumber(value, name, {
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

function finiteInteger(value, name, options = {}) {
  const number = finiteNumber(value, name, options)
  if (number == null) return number
  if (!Number.isInteger(number)) throw toolError(`${name} 必须是整数`)
  return number
}

function safeToken(value, name) {
  if (value == null || value === '') return null
  const token = String(value).trim()
  if (!token || token.startsWith('-') || !/^[a-zA-Z0-9_.:+-]{1,80}$/.test(token)) {
    throw toolError(`${name} contains unsupported characters`)
  }
  return token
}

function resolveSafeOutputMuxer(outputPath, requestedFormat) {
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

function samePath(left, right) {
  const a = path.normalize(path.resolve(left))
  const b = path.normalize(path.resolve(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function resolveInput(rawPath, userId) {
  const resolved = resolveForFileTool(rawPath, { userId, write: false })
  let stat
  try { stat = fs.statSync(resolved.fullPath) } catch {
    throw toolError(`input does not exist: ${rawPath}`, { code: 'MEDIA_INPUT_NOT_FOUND', statusCode: 404 })
  }
  if (!stat.isFile()) throw toolError(`input is not a file: ${rawPath}`, { code: 'MEDIA_INPUT_NOT_FILE' })
  return { ...resolved, size: stat.size }
}

function resolveOutput(rawPath, { userId, overwrite }) {
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

function uniqueSiblingPath(outputPath, label, extension = '') {
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

function runBinary(executable, args, {
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

function processFailure(result, executable, {
  operation = null,
  concatMode = 'copy',
} = {}) {
  if (result.aborted) {
    return { ok: false, cancelled: true, code: 'MEDIA_CANCELLED', error: '媒体处理已取消' }
  }
  if (result.timedOut) {
    return { ok: false, timedOut: true, code: 'MEDIA_TIMEOUT', error: '媒体处理超时' }
  }
  if (result.outputLimited) {
    return {
      ok: false,
      code: 'MEDIA_OUTPUT_LIMIT',
      error: `媒体进程输出超过 ${MAX_PROCESS_OUTPUT_BYTES} 字节上限`,
    }
  }
  const detail = String(result.stderr || result.stdout || '').trim()
  const failure = {
    ok: false,
    code: result.code == null ? 'MEDIA_BINARY_START_FAILED' : 'MEDIA_PROCESS_FAILED',
    error: detail || `${path.basename(executable)} 异常退出（代码 ${result.code}）`,
    exitCode: result.code,
  }
  if (operation === 'concat' && concatMode === 'copy') {
    failure.error = detail
      ? `媒体无法直接无损拼接。FFmpeg 详情：${detail}`
      : '媒体无法直接无损拼接'
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
  if (/[\0\r\n]/.test(normalized)) {
    throw toolError('concat input path contains unsupported control characters')
  }
  return `'${normalized.replaceAll("'", "'\\''")}'`
}

function writeConcatList(listPath, inputs) {
  const contents = [
    'ffconcat version 1.0',
    ...inputs.map((input) => `file ${escapeConcatPath(input.fullPath)}`),
    '',
  ].join('\n')
  fs.writeFileSync(listPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}

function commitOutput(tempPath, outputPath, overwrite) {
  if (overwrite) {
    fs.renameSync(tempPath, outputPath)
    return
  }
  try {
    // Linking a complete same-directory temp file is an atomic no-overwrite commit.
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

function codecArgs(args) {
  const result = []
  const videoCodec = safeToken(args.video_codec, 'video_codec')
  const audioCodec = safeToken(args.audio_codec, 'audio_codec')
  const videoBitrate = safeToken(args.video_bitrate, 'video_bitrate')
  const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
  if (videoCodec) result.push('-c:v', videoCodec)
  if (audioCodec) result.push('-c:a', audioCodec)
  if (videoBitrate) result.push('-b:v', videoBitrate)
  if (audioBitrate) result.push('-b:a', audioBitrate)
  return result
}

function concatMode(args) {
  const mode = String(args?.concat_mode || 'copy').trim().toLowerCase()
  if (!['copy', 'reencode'].includes(mode)) {
    throw toolError('concat_mode 必须是 copy 或 reencode')
  }
  return mode
}

function requireReencodingCodec(value, name) {
  const codec = safeToken(value, name)
  if (codec === 'copy') {
    throw toolError(`${name}=copy 不能用于需要滤镜处理的操作`)
  }
  return codec
}

function buildAtempoChain(speed) {
  const factors = []
  let remainder = speed
  while (remainder < 0.5 - Number.EPSILON) {
    factors.push(0.5)
    remainder /= 0.5
  }
  while (remainder > 2 + Number.EPSILON) {
    factors.push(2)
    remainder /= 2
  }
  factors.push(Number(remainder.toFixed(8)))
  return factors.map((factor) => `atempo=${factor}`).join(',')
}

function firstStream(metadata, type) {
  return metadata?.streams?.find((stream) => stream?.codec_type === type) || null
}

function parseFrameRate(value) {
  const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(String(value || ''))
  if (!match) return null
  const numerator = Number(match[1])
  const denominator = Number(match[2])
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  const rate = numerator / denominator
  return rate > 0 && rate <= 240 ? rate : null
}

function streamCopySignature(metadata) {
  return (metadata?.streams || [])
    .filter((stream) => stream?.codec_type === 'video' || stream?.codec_type === 'audio')
    .map((stream) => stream.codec_type === 'video'
      ? {
          type: 'video',
          codec: stream.codec_name || null,
          profile: stream.profile || null,
          width: Number(stream.width) || null,
          height: Number(stream.height) || null,
          pixelFormat: stream.pix_fmt || null,
        }
      : {
          type: 'audio',
          codec: stream.codec_name || null,
          profile: stream.profile || null,
          sampleRate: Number(stream.sample_rate) || null,
          channels: Number(stream.channels) || null,
          layout: stream.channel_layout || null,
        })
}

function concatCompatibilityIssue(metadataList) {
  const reference = JSON.stringify(streamCopySignature(metadataList[0]))
  if (reference === '[]') return '输入文件中没有可拼接的视频或音频流'
  for (let index = 1; index < metadataList.length; index += 1) {
    if (JSON.stringify(streamCopySignature(metadataList[index])) !== reference) {
      return `第 ${index + 1} 个片段的编码或流参数与第 1 个片段不一致`
    }
  }
  return null
}

function validateTransformParameters(operation, args) {
  normalizeTimeout(args?.timeout_ms, DEFAULT_TRANSFORM_TIMEOUT_MS)
  if (operation === 'trim') {
    finiteNumber(args.start_seconds, 'start_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    finiteNumber(args.duration_seconds, 'duration_seconds', {
      required: true,
      min: 0,
      minExclusive: true,
      max: 86_400,
    })
  } else if (operation === 'transcode') {
    codecArgs(args)
  } else if (operation === 'extract_frame') {
    finiteNumber(args.at_seconds, 'at_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    finiteNumber(args.width, 'width', { min: 1, max: 16_384 })
    finiteNumber(args.height, 'height', { min: 1, max: 16_384 })
  } else if (operation === 'extract_audio') {
    finiteInteger(args.audio_stream_index, 'audio_stream_index', { defaultValue: 0, min: 0, max: 63 })
    safeToken(args.audio_codec, 'audio_codec')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  } else if (operation === 'change_speed') {
    finiteNumber(args.speed, 'speed', {
      required: true,
      min: MIN_PLAYBACK_SPEED,
      max: MAX_PLAYBACK_SPEED,
    })
    requireReencodingCodec(args.video_codec, 'video_codec')
    requireReencodingCodec(args.audio_codec, 'audio_codec')
    safeToken(args.video_bitrate, 'video_bitrate')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  } else if (operation === 'generate_gif') {
    finiteNumber(args.start_seconds, 'start_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    finiteNumber(args.duration_seconds, 'duration_seconds', {
      required: true,
      min: 0,
      minExclusive: true,
      max: MAX_GIF_DURATION_SECONDS,
    })
    finiteNumber(args.fps, 'fps', { defaultValue: 12, min: 1, max: 60 })
    finiteInteger(args.width, 'width', { defaultValue: 480, min: 16, max: 4096 })
  } else if (operation === 'add_subtitles') {
    requireReencodingCodec(args.video_codec, 'video_codec')
    safeToken(args.audio_codec, 'audio_codec')
    safeToken(args.video_bitrate, 'video_bitrate')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  } else if (operation === 'concat') {
    const mode = concatMode(args)
    if (mode === 'reencode') {
      requireReencodingCodec(args.video_codec, 'video_codec')
      requireReencodingCodec(args.audio_codec, 'audio_codec')
      safeToken(args.video_bitrate, 'video_bitrate')
      safeToken(args.audio_bitrate, 'audio_bitrate')
    }
  } else if (operation === 'adjust_audio') {
    finiteNumber(args.volume, 'volume', { required: true, min: 0, max: 10 })
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    if (audioCodec === 'copy') throw toolError('audio_codec=copy cannot be used with adjust_audio')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  } else if (operation === 'denoise_audio') {
    finiteNumber(args.noise_reduction_db, 'noise_reduction_db', { defaultValue: 12, min: 0.01, max: 40 })
    finiteNumber(args.noise_floor_db, 'noise_floor_db', { defaultValue: -50, min: -80, max: -20 })
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    if (audioCodec === 'copy') throw toolError('audio_codec=copy cannot be used with denoise_audio')
    safeToken(args.audio_bitrate, 'audio_bitrate')
  }
}

function concatTopology(metadataList) {
  const hasVideo = metadataList.map((metadata) => Boolean(firstStream(metadata, 'video')))
  const hasAudio = metadataList.map((metadata) => Boolean(firstStream(metadata, 'audio')))
  if (!hasVideo.some(Boolean) && !hasAudio.some(Boolean)) {
    throw toolError('输入文件中没有可拼接的视频或音频流', { code: 'MEDIA_CONCAT_NO_STREAMS' })
  }
  if (hasVideo.some((value) => value !== hasVideo[0]) || hasAudio.some((value) => value !== hasAudio[0])) {
    throw toolError('重新编码拼接要求所有片段具有一致的视频/音频流类型', {
      code: 'MEDIA_CONCAT_STREAM_MISMATCH',
      hint: '请先为缺少音轨或视频轨的片段补齐相同类型的流，再执行 concat_mode="reencode"。',
    })
  }
  return { hasVideo: hasVideo[0], hasAudio: hasAudio[0] }
}

function buildReencodeConcatArgs(command, args, inputs, metadataList) {
  const topology = concatTopology(metadataList)
  for (const input of inputs) command.push('-i', input.fullPath)

  const filters = []
  const orderedLabels = []
  let width = null
  let height = null
  if (topology.hasVideo) {
    const video = firstStream(metadataList[0], 'video')
    width = Math.floor(Number(video?.width) || 0)
    height = Math.floor(Number(video?.height) || 0)
    if (width < 2 || height < 2) throw toolError('无法读取首个片段的视频尺寸')
    // Common encoders require even dimensions. Preserve the first clip's canvas.
    width -= width % 2
    height -= height % 2
  }

  for (let index = 0; index < inputs.length; index += 1) {
    if (topology.hasVideo) {
      filters.push(
        `[${index}:v:0]settb=AVTB,setpts=PTS-STARTPTS,`
        + `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
        + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`,
      )
      orderedLabels.push(`[v${index}]`)
    }
    if (topology.hasAudio) {
      filters.push(
        `[${index}:a:0]aresample=48000,`
        + 'aformat=sample_rates=48000:channel_layouts=stereo,'
        + `asetpts=PTS-STARTPTS[a${index}]`,
      )
      orderedLabels.push(`[a${index}]`)
    }
  }

  const outputs = []
  if (topology.hasVideo) outputs.push('[vout]')
  if (topology.hasAudio) outputs.push('[aout]')
  filters.push(
    `${orderedLabels.join('')}concat=n=${inputs.length}:v=${topology.hasVideo ? 1 : 0}:a=${topology.hasAudio ? 1 : 0}`
    + outputs.join(''),
  )
  command.push('-filter_complex', filters.join(';'))
  if (topology.hasVideo) command.push('-map', '[vout]')
  if (topology.hasAudio) command.push('-map', '[aout]')

  const videoCodec = requireReencodingCodec(args.video_codec, 'video_codec')
  const audioCodec = requireReencodingCodec(args.audio_codec, 'audio_codec')
  const videoBitrate = safeToken(args.video_bitrate, 'video_bitrate')
  const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
  if (topology.hasVideo && videoCodec) command.push('-c:v', videoCodec)
  if (topology.hasAudio && audioCodec) command.push('-c:a', audioCodec)
  if (topology.hasVideo && videoBitrate) command.push('-b:v', videoBitrate)
  if (topology.hasAudio && audioBitrate) command.push('-b:a', audioBitrate)
}

function buildTransformArgs(operation, args, inputs, tempOutput, {
  concatListPath = null,
  concatMetadata = null,
  inputMetadata = null,
  outputMuxer,
  subtitleFilterName = null,
} = {}) {
  const command = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n']
  if (operation === 'trim') {
    const start = finiteNumber(args.start_seconds, 'start_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    const duration = finiteNumber(args.duration_seconds, 'duration_seconds', {
      required: true,
      min: 0,
      minExclusive: true,
      max: 86_400,
    })
    command.push('-ss', String(start), '-i', inputs[0].fullPath, '-t', String(duration), '-map', '0?', '-c', 'copy')
  } else if (operation === 'transcode') {
    command.push('-i', inputs[0].fullPath, '-map', '0:v?', '-map', '0:a?', '-map', '0:s?', ...codecArgs(args))
  } else if (operation === 'extract_frame') {
    const at = finiteNumber(args.at_seconds, 'at_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    command.push('-ss', String(at), '-i', inputs[0].fullPath, '-frames:v', '1')
    const width = finiteNumber(args.width, 'width', { min: 1, max: 16_384 })
    const height = finiteNumber(args.height, 'height', { min: 1, max: 16_384 })
    if (width != null || height != null) {
      const resolvedWidth = width == null ? -1 : Math.floor(width)
      const resolvedHeight = height == null ? -1 : Math.floor(height)
      command.push('-vf', `scale=${resolvedWidth}:${resolvedHeight}`)
    }
  } else if (operation === 'extract_audio') {
    const streamIndex = finiteInteger(args.audio_stream_index, 'audio_stream_index', {
      defaultValue: 0,
      min: 0,
      max: 63,
    })
    command.push('-i', inputs[0].fullPath, '-map', `0:a:${streamIndex}`, '-vn', '-sn', '-dn')
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    if (audioCodec) command.push('-c:a', audioCodec)
    if (audioBitrate) command.push('-b:a', audioBitrate)
  } else if (operation === 'change_speed') {
    const speed = finiteNumber(args.speed, 'speed', {
      required: true,
      min: MIN_PLAYBACK_SPEED,
      max: MAX_PLAYBACK_SPEED,
    })
    const videoCodec = requireReencodingCodec(args.video_codec, 'video_codec')
    const audioCodec = requireReencodingCodec(args.audio_codec, 'audio_codec')
    const video = firstStream(inputMetadata, 'video')
    const audio = firstStream(inputMetadata, 'audio')
    if (!video && !audio) throw toolError('输入文件中没有可变速的视频或音频流')
    command.push('-i', inputs[0].fullPath)
    if (video) {
      command.push('-map', '0:v:0', '-vf', `setpts=(PTS-STARTPTS)/${speed}`)
      const sourceFrameRate = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate)
      if (sourceFrameRate) {
        command.push('-r', String(Number((Math.min(sourceFrameRate * speed, 240)).toFixed(8))))
      }
    }
    if (audio) {
      command.push('-map', '0:a:0', '-af', `${buildAtempoChain(speed)},asetpts=PTS-STARTPTS`)
    }
    if (videoCodec) command.push('-c:v', videoCodec)
    if (audioCodec) command.push('-c:a', audioCodec)
    const videoBitrate = safeToken(args.video_bitrate, 'video_bitrate')
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    if (videoBitrate) command.push('-b:v', videoBitrate)
    if (audioBitrate) command.push('-b:a', audioBitrate)
  } else if (operation === 'generate_gif') {
    const start = finiteNumber(args.start_seconds, 'start_seconds', { defaultValue: 0, min: 0, max: 86_400 })
    const duration = finiteNumber(args.duration_seconds, 'duration_seconds', {
      required: true,
      min: 0,
      minExclusive: true,
      max: MAX_GIF_DURATION_SECONDS,
    })
    const fps = finiteNumber(args.fps, 'fps', { defaultValue: 12, min: 1, max: 60 })
    const width = finiteInteger(args.width, 'width', { defaultValue: 480, min: 16, max: 4096 })
    command.push(
      '-ss', String(start),
      '-i', inputs[0].fullPath,
      '-t', String(duration),
      '-an',
      '-filter_complex',
      `[0:v:0]fps=${fps},scale=${width}:-1:flags=lanczos,split[v0][v1];`
        + '[v0]palettegen=stats_mode=diff[p];[v1][p]paletteuse=dither=sierra2_4a',
      '-loop', '0',
    )
  } else if (operation === 'add_subtitles') {
    if (!subtitleFilterName) throw toolError('字幕临时文件未准备完成')
    const videoCodec = requireReencodingCodec(args.video_codec, 'video_codec')
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    const videoBitrate = safeToken(args.video_bitrate, 'video_bitrate')
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    command.push(
      '-i', inputs[0].fullPath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-sn',
      '-vf', `subtitles=filename='${subtitleFilterName}'`,
    )
    if (videoCodec) command.push('-c:v', videoCodec)
    if (audioCodec) command.push('-c:a', audioCodec)
    else command.push('-c:a', 'copy')
    if (videoBitrate) command.push('-b:v', videoBitrate)
    if (audioBitrate) command.push('-b:a', audioBitrate)
  } else if (operation === 'concat') {
    if (concatMode(args) === 'copy') {
      command.push('-f', 'concat', '-safe', '0', '-i', concatListPath, '-map', '0?', '-c', 'copy')
    } else {
      buildReencodeConcatArgs(command, args, inputs, concatMetadata)
    }
  } else if (operation === 'adjust_audio') {
    const volume = finiteNumber(args.volume, 'volume', { required: true, min: 0, max: 10 })
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    if (audioCodec === 'copy') throw toolError('audio_codec=copy cannot be used with adjust_audio')
    command.push('-i', inputs[0].fullPath, '-map', '0?', '-c:v', 'copy', '-filter:a', `volume=${volume}`)
    if (audioCodec) command.push('-c:a', audioCodec)
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    if (audioBitrate) command.push('-b:a', audioBitrate)
  } else if (operation === 'denoise_audio') {
    const reduction = finiteNumber(args.noise_reduction_db, 'noise_reduction_db', {
      defaultValue: 12,
      min: 0.01,
      max: 40,
    })
    const noiseFloor = finiteNumber(args.noise_floor_db, 'noise_floor_db', {
      defaultValue: -50,
      min: -80,
      max: -20,
    })
    const audioCodec = safeToken(args.audio_codec, 'audio_codec')
    if (audioCodec === 'copy') throw toolError('audio_codec=copy cannot be used with denoise_audio')
    command.push(
      '-i', inputs[0].fullPath,
      '-map', '0?',
      '-c:v', 'copy',
      '-filter:a', `afftdn=nr=${reduction}:nf=${noiseFloor}`,
    )
    if (audioCodec) command.push('-c:a', audioCodec)
    const audioBitrate = safeToken(args.audio_bitrate, 'audio_bitrate')
    if (audioBitrate) command.push('-b:a', audioBitrate)
  }
  if (!outputMuxer) throw toolError('未解析到安全的单文件输出格式')
  command.push('-f', outputMuxer, tempOutput)
  return command
}

async function probeMedia(args, context) {
  const input = resolveInput(args?.input_path, context.userId)
  const executable = resolveMediaBinary('ffprobe')
  const timeout = normalizeTimeout(args?.timeout_ms, DEFAULT_PROBE_TIMEOUT_MS)
  const result = await runBinary(executable, [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    '-of', 'json',
    input.fullPath,
  ], {
    cwd: path.dirname(input.fullPath),
    signal: context.signal,
    timeout,
  })
  if (result.code !== 0 || result.aborted || result.timedOut || result.outputLimited) {
    return processFailure(result, executable)
  }
  let probe
  try {
    probe = JSON.parse(result.stdout)
  } catch {
    return { ok: false, code: 'MEDIA_PROBE_INVALID_JSON', error: 'ffprobe returned invalid JSON' }
  }
  return {
    ok: true,
    path: input.displayPath,
    size: input.size,
    probe,
  }
}

async function probeTransformInputs(inputs, context, timeout, {
  purpose = '媒体处理',
  failureCode = 'MEDIA_TRANSFORM_PROBE_FAILED',
} = {}) {
  const executable = resolveMediaBinary('ffprobe')
  const metadata = []
  for (const input of inputs) {
    const result = await runBinary(executable, [
      '-v', 'error',
      '-show_streams',
      '-of', 'json',
      input.fullPath,
    ], {
      cwd: path.dirname(input.fullPath),
      signal: context.signal,
      timeout: Math.min(timeout, DEFAULT_PROBE_TIMEOUT_MS),
    })
    if (result.code !== 0 || result.aborted || result.timedOut || result.outputLimited) {
      const failure = processFailure(result, executable)
      failure.code = failure.code === 'MEDIA_PROCESS_FAILED'
        ? failureCode
        : failure.code
      failure.error = `${purpose}前无法探测文件 ${input.displayPath}：${failure.error}`
      failure.hint = '请确认文件未损坏，且 ffprobe 可以读取该媒体格式。'
      return failure
    }
    try {
      metadata.push(JSON.parse(result.stdout))
    } catch {
      return {
        ok: false,
        code: `${failureCode}_INVALID_JSON`,
        error: `ffprobe 未能返回有效的媒体信息：${input.displayPath}`,
      }
    }
  }
  return { ok: true, metadata }
}

async function transformMedia(args, context) {
  const operation = String(args?.operation || '').trim()
  if (!MEDIA_OPERATIONS.includes(operation)) {
    throw toolError(`operation must be one of: ${MEDIA_OPERATIONS.join(', ')}`)
  }
  // Validate every pure argument before touching the filesystem or resolving
  // FFmpeg/ffprobe. Otherwise a malformed request can be misreported as a
  // missing binary on machines where the media sidecars are not installed.
  validateTransformParameters(operation, args)
  const overwrite = args?.overwrite === true
  const rawInputs = operation === 'concat'
    ? args?.input_paths
    : operation === 'add_subtitles'
      ? [args?.input_path, args?.subtitle_path]
      : [args?.input_path]
  if (!Array.isArray(rawInputs) || rawInputs.some((item) => typeof item !== 'string' || !item.trim())) {
    if (operation === 'concat') throw toolError('concat 操作需要 input_paths')
    if (operation === 'add_subtitles') throw toolError('add_subtitles 操作需要 input_path 和 subtitle_path')
    throw toolError('input_path 为必填项')
  }
  if (operation === 'concat' && (rawInputs.length < 2 || rawInputs.length > MAX_CONCAT_INPUTS)) {
    throw toolError(`concat requires between 2 and ${MAX_CONCAT_INPUTS} input_paths`)
  }
  const inputs = rawInputs.map((item) => resolveInput(item, context.userId))
  if (operation === 'add_subtitles' && !['.srt', '.ass'].includes(path.extname(inputs[1].fullPath).toLowerCase())) {
    throw toolError('subtitle_path 目前仅支持 UTF-8 SRT 或 ASS 字幕', {
      code: 'MEDIA_SUBTITLE_FORMAT_UNSUPPORTED',
    })
  }
  const output = resolveOutput(args?.output_path, { userId: context.userId, overwrite })
  for (const input of inputs) {
    if (samePath(input.fullPath, output.fullPath)) {
      throw toolError('output_path must differ from every input path', { code: 'MEDIA_OUTPUT_EQUALS_INPUT' })
    }
  }

  const outputExtension = path.extname(output.fullPath)
  const outputMuxer = resolveSafeOutputMuxer(output.fullPath, args?.format)
  if (operation === 'generate_gif' && outputMuxer !== 'gif') {
    throw toolError('generate_gif 必须输出 .gif，或在无扩展名时设置 format="gif"')
  }
  fs.mkdirSync(path.dirname(output.fullPath), { recursive: true })
  const tempOutput = uniqueSiblingPath(output.fullPath, 'tmp', outputExtension)
  const selectedConcatMode = operation === 'concat' ? concatMode(args) : null
  const concatListPath = operation === 'concat' && selectedConcatMode === 'copy'
    ? uniqueSiblingPath(output.fullPath, 'concat', '.txt')
    : null
  const subtitleTempPath = operation === 'add_subtitles'
    ? uniqueSiblingPath(output.fullPath, 'subtitles', path.extname(inputs[1].fullPath).toLowerCase())
    : null
  const executable = resolveMediaBinary('ffmpeg')
  const timeout = normalizeTimeout(args?.timeout_ms, DEFAULT_TRANSFORM_TIMEOUT_MS)

  try {
    let concatMetadata = null
    let inputMetadata = null
    if (operation === 'concat') {
      const probeResult = await probeTransformInputs(inputs, context, timeout, {
        purpose: '拼接',
        failureCode: 'MEDIA_CONCAT_PROBE_FAILED',
      })
      if (!probeResult.ok) return probeResult
      concatMetadata = probeResult.metadata
      if (selectedConcatMode === 'copy') {
        const issue = concatCompatibilityIssue(concatMetadata)
        if (issue) {
          return {
            ok: false,
            code: 'MEDIA_CONCAT_INCOMPATIBLE',
            error: `无法直接无损拼接：${issue}`,
            hint: '请设置 concat_mode="reencode" 重新编码拼接；也可以先把所有片段转为相同编码、分辨率与音频参数。',
          }
        }
      }
    }
    if (operation === 'change_speed') {
      const probeResult = await probeTransformInputs(inputs, context, timeout, {
        purpose: '变速',
        failureCode: 'MEDIA_SPEED_PROBE_FAILED',
      })
      if (!probeResult.ok) return probeResult
      inputMetadata = probeResult.metadata[0]
    }
    if (concatListPath) writeConcatList(concatListPath, inputs)
    if (subtitleTempPath) {
      fs.copyFileSync(inputs[1].fullPath, subtitleTempPath, fs.constants.COPYFILE_EXCL)
    }
    const commandArgs = buildTransformArgs(operation, args, inputs, tempOutput, {
      concatListPath,
      concatMetadata,
      inputMetadata,
      outputMuxer,
      subtitleFilterName: subtitleTempPath ? path.basename(subtitleTempPath) : null,
    })
    const result = await runBinary(executable, commandArgs, {
      cwd: path.dirname(output.fullPath),
      signal: context.signal,
      timeout,
      onOutput: context.onOutput,
    })
    if (result.code !== 0 || result.aborted || result.timedOut || result.outputLimited) {
      return processFailure(result, executable, {
        operation,
        concatMode: selectedConcatMode,
      })
    }
    let stat
    try { stat = fs.statSync(tempOutput) } catch {
      return { ok: false, code: 'MEDIA_OUTPUT_MISSING', error: 'ffmpeg completed without creating output' }
    }
    if (!stat.isFile() || stat.size === 0) {
      return { ok: false, code: 'MEDIA_OUTPUT_EMPTY', error: 'ffmpeg created an empty output file' }
    }
    commitOutput(tempOutput, output.fullPath, overwrite)
    return {
      ok: true,
      operation,
      inputs: inputs.map((input) => input.displayPath),
      path: output.displayPath,
      fullPath: output.fullPath,
      scope: output.source,
      changedPaths: [output.displayPath],
      output_path: output.displayPath,
      bytes: stat.size,
    }
  } finally {
    for (const cleanupPath of [tempOutput, concatListPath, subtitleTempPath]) {
      if (!cleanupPath) continue
      try { fs.unlinkSync(cleanupPath) } catch { /* already committed or absent */ }
    }
  }
}

export async function dispatchMediaTool(name, args = {}, { userId = null, signal = null, onOutput = null } = {}) {
  if (name === 'media_probe') return probeMedia(args, { userId, signal })
  if (name === 'media_transform') return transformMedia(args, { userId, signal, onOutput })
  throw toolError(`unknown media tool: ${name}`, { code: 'MEDIA_TOOL_UNKNOWN', statusCode: 404 })
}

export const MEDIA_TOOL_SPECS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'media_probe',
      description: 'Inspect an authorized audio or video file with ffprobe and return structured JSON metadata. The input may be a workspace path, an authorized absolute path, or a managed attachment URI.',
      parameters: {
        type: 'object',
        properties: {
          input_path: { type: 'string', description: 'Authorized media path or managed attachment URI.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_PROBE_TIMEOUT_MS },
        },
        required: ['input_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media_transform',
      description: 'Transform authorized media with ffmpeg: trim/transcode, extract audio or frames, change playback speed, generate a palette-optimized GIF, burn in external SRT/ASS subtitles, concatenate, adjust volume, or denoise audio. Writes to a same-directory temporary file and commits only a complete output. Existing files are preserved unless overwrite=true.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: MEDIA_OPERATIONS },
          input_path: { type: 'string', description: 'Single media input used by every operation except concat.' },
          input_paths: {
            type: 'array',
            minItems: 2,
            maxItems: MAX_CONCAT_INPUTS,
            items: { type: 'string' },
            description: 'Ordered authorized inputs used by concat.',
          },
          subtitle_path: { type: 'string', description: 'Authorized UTF-8 .srt or .ass subtitle path used by add_subtitles. Subtitles are burned into video pixels.' },
          output_path: { type: 'string', description: 'Authorized output path. Must differ from all inputs.' },
          overwrite: { type: 'boolean', default: false },
          start_seconds: { type: 'number', minimum: 0, default: 0, description: 'Start time used by trim and generate_gif.' },
          duration_seconds: { type: 'number', exclusiveMinimum: 0, description: `Required duration for trim and generate_gif; GIF duration is limited to ${MAX_GIF_DURATION_SECONDS} seconds.` },
          at_seconds: { type: 'number', minimum: 0, default: 0, description: 'Frame extraction timestamp.' },
          audio_stream_index: { type: 'integer', minimum: 0, maximum: 63, default: 0, description: 'Zero-based audio stream selected by extract_audio.' },
          speed: { type: 'number', minimum: MIN_PLAYBACK_SPEED, maximum: MAX_PLAYBACK_SPEED, description: 'Required playback speed multiplier for change_speed. Video timestamps and audio tempo are both adjusted.' },
          fps: { type: 'number', minimum: 1, maximum: 60, default: 12, description: 'Frame rate used by generate_gif.' },
          concat_mode: {
            type: 'string',
            enum: ['copy', 'reencode'],
            default: 'copy',
            description: 'copy is fast and lossless but requires matching stream parameters; reencode normalizes video canvas and audio sampling before concatenating.',
          },
          volume: { type: 'number', minimum: 0, maximum: 10, description: 'Required audio volume multiplier.' },
          noise_reduction_db: { type: 'number', minimum: 0.01, maximum: 40, default: 12, description: 'FFT denoising strength for denoise_audio, in dB.' },
          noise_floor_db: { type: 'number', minimum: -80, maximum: -20, default: -50, description: 'Expected noise floor for denoise_audio, in dB.' },
          width: { type: 'integer', minimum: 1, maximum: 16384, description: 'Output width used by extract_frame or generate_gif.' },
          height: { type: 'integer', minimum: 1, maximum: 16384 },
          video_codec: { type: 'string' },
          audio_codec: { type: 'string' },
          video_bitrate: { type: 'string' },
          audio_bitrate: { type: 'string' },
          format: {
            type: 'string',
            enum: Object.keys(EXPLICIT_SINGLE_FILE_MUXERS),
            description: 'Safe single-file ffmpeg muxer used only when output_path has no extension. Do not set format when output_path already has an extension. Streaming/multi-output muxers such as tee, hls, dash, segment, fifo, and image2 are forbidden.',
          },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TRANSFORM_TIMEOUT_MS },
        },
        required: ['operation', 'output_path'],
        anyOf: [
          { required: ['input_path'] },
          { required: ['input_paths'] },
        ],
      },
    },
  },
])
