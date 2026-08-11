import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

import { resolveForFileTool } from './fsShellTools.js'

const MAX_INPUT_BYTES = 1024 * 1024 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024
const MAX_INPUT_PIXELS = 100_000_000
const MAX_OUTPUT_PIXELS = 100_000_000
const MAX_DIMENSION = 32_768

const OUTPUT_FORMAT_BY_EXTENSION = Object.freeze({
  '.avif': 'avif',
  '.gif': 'gif',
  '.jpeg': 'jpeg',
  '.jpg': 'jpeg',
  '.png': 'png',
  '.tif': 'tiff',
  '.tiff': 'tiff',
  '.webp': 'webp',
})

const RESIZE_FITS = new Set(['cover', 'contain', 'fill', 'inside', 'outside'])
const RESIZE_POSITIONS = new Set([
  'center', 'top', 'right top', 'right', 'right bottom', 'bottom',
  'left bottom', 'left', 'left top', 'north', 'northeast', 'east',
  'southeast', 'south', 'southwest', 'west', 'northwest', 'centre',
  'entropy', 'attention',
])

function spec(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } }
}

const resizeSchema = {
  type: 'object',
  properties: {
    width: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION },
    height: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION },
    fit: { type: 'string', enum: [...RESIZE_FITS] },
    position: { type: 'string', enum: [...RESIZE_POSITIONS] },
    without_enlargement: { type: 'boolean' },
  },
  anyOf: [{ required: ['width'] }, { required: ['height'] }],
  additionalProperties: false,
}

const cropSchema = {
  type: 'object',
  properties: {
    left: { type: 'integer', minimum: 0 },
    top: { type: 'integer', minimum: 0 },
    width: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION },
    height: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION },
  },
  required: ['left', 'top', 'width', 'height'],
  additionalProperties: false,
}

export const IMAGE_TOOL_SPECS = Object.freeze([
  spec(
    'image_info',
    'Read image metadata from the workspace, an authorized local path, or attachment:// without loading the file through read_file.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image path or attachment:// URI.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  ),
  spec(
    'image_transform',
    'Transform an image with bounded server-side processing. Supports crop, resize, rotate, flip/flop, grayscale, blur, sharpen, normalize, and format conversion. Output is written atomically and is never overwritten unless overwrite=true.',
    {
      type: 'object',
      properties: {
        input_path: { type: 'string', description: 'Source image path or attachment:// URI.' },
        output_path: { type: 'string', description: 'Authorized writable destination with a supported image extension.' },
        resize: resizeSchema,
        crop: cropSchema,
        rotate: { type: 'number', minimum: -360, maximum: 360 },
        flip: { type: 'boolean' },
        flop: { type: 'boolean' },
        grayscale: { type: 'boolean' },
        blur: { oneOf: [{ type: 'boolean' }, { type: 'number', minimum: 0.3, maximum: 1000 }] },
        sharpen: { oneOf: [{ type: 'boolean' }, { type: 'number', exclusiveMinimum: 0, maximum: 10000 }] },
        normalize: { type: 'boolean' },
        format: { type: 'string', enum: ['avif', 'gif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp'] },
        quality: { type: 'integer', minimum: 1, maximum: 100 },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['input_path', 'output_path'],
      additionalProperties: false,
    },
  ),
])

function imageError(message, statusCode = 400, code = 'IMAGE_TOOL_FAILED') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function abortError() {
  const error = imageError('图片处理已取消', 499, 'ABORT_ERR')
  error.name = 'AbortError'
  error.cancelled = true
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw imageError(`${label} 必须是对象`, 400, 'IMAGE_ARGUMENT_INVALID')
  }
  return value
}

function optionalBoolean(value, label) {
  if (value == null) return false
  if (typeof value !== 'boolean') {
    throw imageError(`${label} 必须是布尔值`, 400, 'IMAGE_ARGUMENT_INVALID')
  }
  return value
}

function optionalNumber(value, label, { min, max, integer = false } = {}) {
  if (value == null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
    throw imageError(`${label} 超出允许范围`, 400, 'IMAGE_ARGUMENT_INVALID')
  }
  return number
}

function normalizeFormat(value) {
  if (value == null || value === '') return null
  const normalized = String(value).trim().toLowerCase()
  if (normalized === 'jpg') return 'jpeg'
  if (normalized === 'tif') return 'tiff'
  if (!['avif', 'gif', 'jpeg', 'png', 'tiff', 'webp'].includes(normalized)) {
    throw imageError(`不支持的输出格式: ${value}`, 400, 'IMAGE_FORMAT_UNSUPPORTED')
  }
  return normalized
}

function resolveOutputFormat(outputPath, requestedFormat) {
  const extension = path.extname(outputPath).toLowerCase()
  const extensionFormat = OUTPUT_FORMAT_BY_EXTENSION[extension]
  if (!extensionFormat) {
    throw imageError(`输出扩展名不受支持: ${extension || '(无扩展名)'}`, 400, 'IMAGE_FORMAT_UNSUPPORTED')
  }
  const format = normalizeFormat(requestedFormat) || extensionFormat
  if (format !== extensionFormat) {
    throw imageError(
      `输出格式 ${format} 与扩展名 ${extension} 不匹配`,
      400,
      'IMAGE_FORMAT_EXTENSION_MISMATCH',
    )
  }
  return format
}

function normalizeResize(args) {
  const inlineKeys = ['width', 'height', 'fit', 'position', 'without_enlargement']
  const hasInline = inlineKeys.some((key) => args[key] != null)
  if (args.resize != null && hasInline) {
    throw imageError('resize 不能与顶层 width/height/fit 同时使用', 400, 'IMAGE_ARGUMENT_INVALID')
  }
  if (args.resize == null && !hasInline) return null
  const resize = requireObject(args.resize ?? {
    width: args.width,
    height: args.height,
    fit: args.fit,
    position: args.position,
    without_enlargement: args.without_enlargement,
  }, 'resize')
  const width = optionalNumber(resize.width, 'resize.width', { min: 1, max: MAX_DIMENSION, integer: true })
  const height = optionalNumber(resize.height, 'resize.height', { min: 1, max: MAX_DIMENSION, integer: true })
  if (width == null && height == null) {
    throw imageError('resize 至少需要 width 或 height', 400, 'IMAGE_ARGUMENT_INVALID')
  }
  if (width != null && height != null && width * height > MAX_OUTPUT_PIXELS) {
    throw imageError('resize 输出像素超过限制', 413, 'IMAGE_PIXEL_LIMIT_EXCEEDED')
  }
  const fit = resize.fit == null ? 'cover' : String(resize.fit).toLowerCase()
  if (!RESIZE_FITS.has(fit)) throw imageError(`不支持的 resize.fit: ${fit}`, 400, 'IMAGE_ARGUMENT_INVALID')
  const position = resize.position == null ? 'center' : String(resize.position).toLowerCase()
  if (!RESIZE_POSITIONS.has(position)) {
    throw imageError(`不支持的 resize.position: ${position}`, 400, 'IMAGE_ARGUMENT_INVALID')
  }
  const withoutEnlargement = resize.without_enlargement == null
    ? false
    : optionalBoolean(resize.without_enlargement, 'resize.without_enlargement')
  return { width, height, fit, position, withoutEnlargement }
}

function normalizeCrop(value) {
  if (value == null) return null
  const crop = requireObject(value, 'crop')
  const left = optionalNumber(crop.left, 'crop.left', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })
  const top = optionalNumber(crop.top, 'crop.top', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })
  const width = optionalNumber(crop.width, 'crop.width', { min: 1, max: MAX_DIMENSION, integer: true })
  const height = optionalNumber(crop.height, 'crop.height', { min: 1, max: MAX_DIMENSION, integer: true })
  if ([left, top, width, height].some((item) => item == null)) {
    throw imageError('crop 需要 left、top、width、height', 400, 'IMAGE_ARGUMENT_INVALID')
  }
  if (width * height > MAX_OUTPUT_PIXELS) {
    throw imageError('crop 输出像素超过限制', 413, 'IMAGE_PIXEL_LIMIT_EXCEEDED')
  }
  return { left, top, width, height }
}

function normalizeTransformArgs(args = {}) {
  requireObject(args, 'arguments')
  const inputPath = String(args.input_path || '').trim()
  const outputPath = String(args.output_path || '').trim()
  if (!inputPath) throw imageError('input_path 必填', 400, 'IMAGE_INPUT_REQUIRED')
  if (!outputPath) throw imageError('output_path 必填', 400, 'IMAGE_OUTPUT_REQUIRED')
  const rotate = optionalNumber(args.rotate, 'rotate', { min: -360, max: 360 })
  const blur = args.blur == null || args.blur === false
    ? null
    : args.blur === true
      ? true
      : optionalNumber(args.blur, 'blur', { min: 0.3, max: 1000 })
  const sharpen = args.sharpen == null || args.sharpen === false
    ? null
    : args.sharpen === true
      ? true
      : optionalNumber(args.sharpen, 'sharpen', { min: Number.EPSILON, max: 10000 })
  const quality = optionalNumber(args.quality, 'quality', { min: 1, max: 100, integer: true })
  return {
    inputPath,
    outputPath,
    resize: normalizeResize(args),
    crop: normalizeCrop(args.crop),
    rotate,
    flip: optionalBoolean(args.flip, 'flip'),
    flop: optionalBoolean(args.flop, 'flop'),
    grayscale: optionalBoolean(args.grayscale, 'grayscale'),
    blur,
    sharpen,
    normalize: optionalBoolean(args.normalize, 'normalize'),
    format: args.format,
    quality,
    overwrite: optionalBoolean(args.overwrite, 'overwrite'),
  }
}

function createPipeline(inputPath) {
  return sharp(inputPath, {
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  })
}

async function awaitSharp(pipeline, operation, signal) {
  throwIfAborted(signal)
  const task = Promise.resolve().then(operation)
  if (!signal) return task
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => {
      try { pipeline.destroy(abortError()) } catch { /* sharp may already be closed */ }
      finish(reject, abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    task.then((value) => finish(resolve, value), (error) => finish(reject, error))
  })
}

function mapProcessingError(error, action) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return error
  if (error?.statusCode) return error
  const mapped = imageError(`${action}失败: ${error?.message || String(error)}`, 422, 'IMAGE_PROCESSING_FAILED')
  mapped.cause = error
  return mapped
}

async function resolveReadableImage(rawPath, userId) {
  const resolved = resolveForFileTool(rawPath, { userId, write: false })
  const stat = await fs.promises.stat(resolved.fullPath)
  if (!stat.isFile()) throw imageError('输入路径不是文件', 400, 'IMAGE_INPUT_NOT_FILE')
  if (stat.size <= 0) throw imageError('输入图片为空', 400, 'IMAGE_INPUT_EMPTY')
  if (stat.size > MAX_INPUT_BYTES) {
    throw imageError(`输入图片超过 ${MAX_INPUT_BYTES} 字节限制`, 413, 'IMAGE_INPUT_TOO_LARGE')
  }
  return { resolved, stat }
}

async function imageInfo(args, { userId, signal }) {
  const rawPath = String(args?.path || '').trim()
  if (!rawPath) throw imageError('path 必填', 400, 'IMAGE_INPUT_REQUIRED')
  throwIfAborted(signal)
  const { resolved, stat } = await resolveReadableImage(rawPath, userId)
  const pipeline = createPipeline(resolved.fullPath)
  let metadata
  try {
    metadata = await awaitSharp(pipeline, () => pipeline.metadata(), signal)
  } catch (error) {
    throw mapProcessingError(error, '读取图片元数据')
  } finally {
    pipeline.destroy()
  }
  throwIfAborted(signal)
  return {
    ok: true,
    path: resolved.displayPath,
    scope: resolved.source,
    bytes: stat.size,
    format: metadata.format || null,
    width: metadata.width || null,
    height: metadata.height || null,
    space: metadata.space || null,
    channels: metadata.channels || null,
    depth: metadata.depth || null,
    density: metadata.density || null,
    orientation: metadata.orientation || null,
    pages: metadata.pages || 1,
    pageHeight: metadata.pageHeight || null,
    loop: metadata.loop ?? null,
    delay: metadata.delay || null,
    hasAlpha: !!metadata.hasAlpha,
    hasProfile: !!metadata.hasProfile,
    isProgressive: !!metadata.isProgressive,
    chromaSubsampling: metadata.chromaSubsampling || null,
  }
}

function applyFormat(pipeline, format, quality) {
  const options = quality == null ? {} : { quality }
  if (format === 'jpeg') return pipeline.jpeg(options)
  if (format === 'png') return pipeline.png(options)
  if (format === 'webp') return pipeline.webp(options)
  if (format === 'avif') return pipeline.avif(options)
  if (format === 'tiff') return pipeline.tiff(options)
  if (format === 'gif') {
    if (quality != null) {
      throw imageError('GIF 输出不支持 quality 参数', 400, 'IMAGE_QUALITY_UNSUPPORTED')
    }
    return pipeline.gif()
  }
  throw imageError(`不支持的输出格式: ${format}`, 400, 'IMAGE_FORMAT_UNSUPPORTED')
}

function temporaryOutputPath(outputPath) {
  return path.join(path.dirname(outputPath), `.gugo-image-${crypto.randomUUID()}.tmp`)
}

async function commitAtomic(tempPath, outputPath, overwrite) {
  if (overwrite) {
    await fs.promises.rename(tempPath, outputPath)
    return
  }
  try {
    await fs.promises.link(tempPath, outputPath)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw imageError('输出文件已存在；如需替换请设置 overwrite=true', 409, 'IMAGE_OUTPUT_EXISTS')
    }
    throw error
  }
  // The hard-link creation is the atomic commit. Cleanup of the temporary
  // sibling must not turn an already committed output into a reported failure
  // (Windows antivirus/indexers can briefly retain a handle).
  try { await fs.promises.unlink(tempPath) } catch (error) {
    if (error?.code !== 'ENOENT') { /* best-effort cleanup in the outer finally */ }
  }
}

async function imageTransform(args, { userId, signal }) {
  const options = normalizeTransformArgs(args)
  throwIfAborted(signal)
  const [{ resolved: input, stat: inputStat }, output] = await Promise.all([
    resolveReadableImage(options.inputPath, userId),
    Promise.resolve(resolveForFileTool(options.outputPath, {
      userId,
      write: true,
      allowMissing: true,
    })),
  ])
  const outputPath = output.fullPath
  const format = resolveOutputFormat(outputPath, options.format)
  const outputExists = fs.existsSync(outputPath)
  if (outputExists && !options.overwrite) {
    throw imageError('输出文件已存在；如需替换请设置 overwrite=true', 409, 'IMAGE_OUTPUT_EXISTS')
  }
  if (outputExists && !fs.statSync(outputPath).isFile()) {
    throw imageError('输出路径不是文件', 400, 'IMAGE_OUTPUT_NOT_FILE')
  }
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
  const tempPath = temporaryOutputPath(outputPath)
  const pipeline = createPipeline(input.fullPath)
  try {
    if (options.rotate != null && options.rotate !== 0) pipeline.rotate(options.rotate)
    if (options.flip) pipeline.flip()
    if (options.flop) pipeline.flop()
    if (options.crop) pipeline.extract(options.crop)
    if (options.resize) pipeline.resize(options.resize.width, options.resize.height, {
      fit: options.resize.fit,
      position: options.resize.position,
      withoutEnlargement: options.resize.withoutEnlargement,
    })
    if (options.grayscale) pipeline.grayscale()
    if (options.blur) options.blur === true ? pipeline.blur() : pipeline.blur(options.blur)
    if (options.sharpen) options.sharpen === true ? pipeline.sharpen() : pipeline.sharpen(options.sharpen)
    if (options.normalize) pipeline.normalize()
    applyFormat(pipeline, format, options.quality)

    let info
    try {
      info = await awaitSharp(pipeline, () => pipeline.toFile(tempPath), signal)
    } catch (error) {
      throw mapProcessingError(error, '图片转换')
    }
    throwIfAborted(signal)
    const outputStat = await fs.promises.stat(tempPath)
    if (outputStat.size > MAX_OUTPUT_BYTES) {
      throw imageError(`输出图片超过 ${MAX_OUTPUT_BYTES} 字节限制`, 413, 'IMAGE_OUTPUT_TOO_LARGE')
    }
    if (Number(info.width) * Number(info.height) > MAX_OUTPUT_PIXELS) {
      throw imageError('输出图片像素超过限制', 413, 'IMAGE_PIXEL_LIMIT_EXCEEDED')
    }
    throwIfAborted(signal)
    await commitAtomic(tempPath, outputPath, options.overwrite)
    const finalStat = await fs.promises.stat(outputPath)
    return {
      ok: true,
      inputPath: input.displayPath,
      path: output.displayPath,
      scope: output.source,
      bytes: finalStat.size,
      inputBytes: inputStat.size,
      format: info.format || format,
      width: info.width || null,
      height: info.height || null,
      channels: info.channels || null,
      created: !outputExists,
      overwritten: outputExists,
      changes: [{ path: output.displayPath, status: outputExists ? 'updated' : 'created' }],
    }
  } finally {
    pipeline.destroy()
    try { await fs.promises.unlink(tempPath) } catch (error) {
      if (error?.code !== 'ENOENT') { /* best-effort cleanup */ }
    }
  }
}

export async function dispatchImageTool(name, args = {}, { userId = null, signal = null } = {}) {
  if (name === 'image_info') return imageInfo(args, { userId, signal })
  if (name === 'image_transform') return imageTransform(args, { userId, signal })
  throw imageError(`未知图片工具: ${name}`, 400, 'IMAGE_TOOL_UNKNOWN')
}

export const IMAGE_TOOL_LIMITS = Object.freeze({
  maxInputBytes: MAX_INPUT_BYTES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxInputPixels: MAX_INPUT_PIXELS,
  maxOutputPixels: MAX_OUTPUT_PIXELS,
  maxDimension: MAX_DIMENSION,
})
