import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_TRANSFORM_TIMEOUT_MS,
  MAX_CONCAT_INPUTS,
  MEDIA_OPERATIONS,
  commitOutput,
  normalizeTimeout,
  processFailure,
  resolveInput,
  resolveMediaBinary,
  resolveOutput,
  resolveSafeOutputMuxer,
  runBinary,
  samePath,
  toolError,
  uniqueSiblingPath,
  writeConcatList,
} from './mediaToolRuntime.js'
import {
  buildTransformArgs,
  concatCompatibilityIssue,
  concatMode,
  validateTransformParameters,
} from './mediaTransformPlan.js'

export { MEDIA_TOOL_SPECS } from './mediaToolSpecs.js'

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
  return { ok: true, path: input.displayPath, size: input.size, probe }
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
      failure.code = failure.code === 'MEDIA_PROCESS_FAILED' ? failureCode : failure.code
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

function resolveRawInputs(operation, args) {
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
  return rawInputs
}

async function prepareTransformMetadata(operation, inputs, context, timeout, selectedConcatMode) {
  let concatMetadata = null
  let inputMetadata = null
  if (operation === 'concat') {
    const probeResult = await probeTransformInputs(inputs, context, timeout, {
      purpose: '拼接',
      failureCode: 'MEDIA_CONCAT_PROBE_FAILED',
    })
    if (!probeResult.ok) return { failure: probeResult }
    concatMetadata = probeResult.metadata
    if (selectedConcatMode === 'copy') {
      const issue = concatCompatibilityIssue(concatMetadata)
      if (issue) {
        return {
          failure: {
            ok: false,
            code: 'MEDIA_CONCAT_INCOMPATIBLE',
            error: `无法直接无损拼接：${issue}`,
            hint: '请设置 concat_mode="reencode" 重新编码拼接；也可以先把所有片段转为相同编码、分辨率与音频参数。',
          },
        }
      }
    }
  }
  if (operation === 'change_speed') {
    const probeResult = await probeTransformInputs(inputs, context, timeout, {
      purpose: '变速',
      failureCode: 'MEDIA_SPEED_PROBE_FAILED',
    })
    if (!probeResult.ok) return { failure: probeResult }
    inputMetadata = probeResult.metadata[0]
  }
  return { concatMetadata, inputMetadata, failure: null }
}

async function transformMedia(args, context) {
  const operation = String(args?.operation || '').trim()
  if (!MEDIA_OPERATIONS.includes(operation)) {
    throw toolError(`operation must be one of: ${MEDIA_OPERATIONS.join(', ')}`)
  }
  // Reject malformed pure arguments before filesystem or optional-binary access.
  validateTransformParameters(operation, args)
  const overwrite = args?.overwrite === true
  const rawInputs = resolveRawInputs(operation, args)
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
    const metadata = await prepareTransformMetadata(operation, inputs, context, timeout, selectedConcatMode)
    if (metadata.failure) return metadata.failure
    if (concatListPath) writeConcatList(concatListPath, inputs)
    if (subtitleTempPath) fs.copyFileSync(inputs[1].fullPath, subtitleTempPath, fs.constants.COPYFILE_EXCL)
    const commandArgs = buildTransformArgs(operation, args, inputs, tempOutput, {
      concatListPath,
      concatMetadata: metadata.concatMetadata,
      inputMetadata: metadata.inputMetadata,
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
      return processFailure(result, executable, { operation, concatMode: selectedConcatMode })
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
