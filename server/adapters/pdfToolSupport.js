import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import {
  PDFDocument,
  PDFName,
  PDFSignature,
  StandardFonts,
} from 'pdf-lib'
import { resolveForFileTool } from './fsShellTools.js'

const DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_TEXT_PAGES = 200
const DEFAULT_MAX_TEXT_CHARACTERS = 1_000_000
const DEFAULT_MAX_TEXT_ITEMS = 50_000
const DEFAULT_RENDER_DPI = 144
const MIN_RENDER_DPI = 36
const MAX_RENDER_DPI = 300
const MAX_RENDER_PAGES = 100
const MAX_RENDER_DIMENSION = 32_768
const MAX_RENDER_PAGE_PIXELS = 40_000_000
const MAX_RENDER_TOTAL_PIXELS = 200_000_000
const CJK_FONT_URL = new URL('../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url)
const PDFJS_STANDARD_FONT_DATA_URL = `${path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/pdfjs-dist/standard_fonts',
)}${path.sep}`
const SUPPORTED_OPERATIONS = new Set(['merge', 'split', 'rotate', 'watermark', 'overlay_text', 'fill_form'])

let cjkFontBytes
let pdfJsPromise

// pdf-lib still consumes Fontkit's legacy encodeStream() subset API. Fontkit
// v2 fixed CJK subset output but now exposes encode() instead, so bridge the
// one removed method without disabling glyph subsetting.
const pdfLibFontkit = {
  create(...args) {
    const font = fontkit.create(...args)
    const createSubset = font.createSubset.bind(font)
    font.createSubset = () => {
      const subset = createSubset()
      subset.encodeStream = () => Readable.from([subset.encode()])
      return subset
    }
    return font
  },
}

function pdfError(message, statusCode = 400, code = 'PDF_TOOL_ERROR', details = {}) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  Object.assign(error, details)
  return error
}

function throwIfPdfAborted(signal) {
  if (!signal?.aborted) return
  const error = pdfError('PDF operation cancelled', 499, 'ABORT_ERR')
  error.name = 'AbortError'
  error.cancelled = true
  throw error
}

function positiveIntegerLimit(names, fallback, label = '数值') {
  const configuredName = names.find((name) => process.env[name]?.trim())
  if (!configuredName) return fallback
  const value = Number(process.env[configuredName])
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw pdfError(
      `${configuredName} 必须是正整数${label}`,
      500,
      'PDF_LIMIT_CONFIG_INVALID',
    )
  }
  return value
}

function positiveByteLimit(names, fallback) {
  return positiveIntegerLimit(names, fallback, '字节数')
}

function inputByteLimit() {
  return positiveByteLimit(['PDF_TOOL_MAX_INPUT_BYTES', 'PDF_MAX_INPUT_BYTES'], DEFAULT_MAX_INPUT_BYTES)
}

function outputByteLimit() {
  return positiveByteLimit(['PDF_TOOL_MAX_OUTPUT_BYTES', 'PDF_MAX_OUTPUT_BYTES'], DEFAULT_MAX_OUTPUT_BYTES)
}

function textPageLimit() {
  return positiveIntegerLimit(['PDF_TEXT_MAX_PAGES'], DEFAULT_MAX_TEXT_PAGES, '页数')
}

function textCharacterLimit() {
  return positiveIntegerLimit(['PDF_TEXT_MAX_CHARACTERS'], DEFAULT_MAX_TEXT_CHARACTERS, '字符数')
}

function textItemLimit() {
  return positiveIntegerLimit(['PDF_TEXT_MAX_ITEMS'], DEFAULT_MAX_TEXT_ITEMS, '文本项数')
}

function readCjkFontBytes() {
  if (cjkFontBytes) return cjkFontBytes
  try {
    cjkFontBytes = fs.readFileSync(CJK_FONT_URL)
    return cjkFontBytes
  } catch (cause) {
    throw pdfError(
      '内置中文字体缺失或无法读取，无法绘制中文 PDF 文本。请重新安装完整应用。',
      500,
      'PDF_CJK_FONT_UNAVAILABLE',
      { cause },
    )
  }
}

async function embedUnicodeFont(document) {
  try {
    document.registerFontkit(pdfLibFontkit)
    return await document.embedFont(readCjkFontBytes(), { subset: true })
  } catch (cause) {
    throw pdfError(
      '内置中文字体嵌入失败，无法绘制中文 PDF 文本。',
      500,
      'PDF_CJK_FONT_EMBED_FAILED',
      { cause },
    )
  }
}

async function embedTextFont(document, texts) {
  const standardFont = await document.embedFont(StandardFonts.Helvetica)
  try {
    for (const text of texts) standardFont.encodeText(String(text ?? ''))
    return standardFont
  } catch {
    return embedUnicodeFont(document)
  }
}

function loadPdfJs() {
  pdfJsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfJsPromise
}

function encryptedPdfError(inputPath, cause) {
  return pdfError(
    `Encrypted PDF is not supported: ${inputPath}. Decrypt it with its password before using PDF tools.`,
    422,
    'PDF_ENCRYPTED',
    { path: inputPath, encrypted: true, cause },
  )
}

function isEncryptedPdfError(error) {
  return error?.name === 'EncryptedPDFError'
    || /encrypted pdf/i.test(String(error?.message || ''))
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw pdfError(`${name} is required`, 400, 'PDF_INVALID_ARGUMENT')
  }
  return value.trim()
}

function readPdfInput(rawPath, { userId = null } = {}) {
  const requestedPath = requireString(rawPath, 'input path')
  const resolved = resolveForFileTool(requestedPath, { userId })
  let stat
  try {
    stat = fs.statSync(resolved.fullPath)
  } catch (cause) {
    throw pdfError(`Unable to read PDF: ${resolved.displayPath}`, 404, 'PDF_INPUT_NOT_FOUND', { cause })
  }
  if (!stat.isFile()) {
    throw pdfError(`PDF input is not a file: ${resolved.displayPath}`, 400, 'PDF_INPUT_NOT_FILE')
  }
  const maxBytes = inputByteLimit()
  if (stat.size > maxBytes) {
    throw pdfError(
      `PDF input is too large (${stat.size} bytes; limit ${maxBytes}): ${resolved.displayPath}`,
      413,
      'PDF_INPUT_TOO_LARGE',
      { size: stat.size, maxBytes, path: resolved.displayPath },
    )
  }
  const bytes = fs.readFileSync(resolved.fullPath)
  return {
    bytes,
    size: stat.size,
    fullPath: resolved.fullPath,
    path: resolved.displayPath,
    scope: resolved.source,
  }
}

async function loadPdf(input) {
  try {
    const document = await PDFDocument.load(input.bytes, { updateMetadata: false })
    return { ...input, document }
  } catch (cause) {
    if (isEncryptedPdfError(cause)) throw encryptedPdfError(input.path, cause)
    throw pdfError(
      `Invalid or unsupported PDF: ${input.path}. ${cause?.message || 'Unable to parse the document.'}`,
      422,
      'PDF_INVALID',
      { path: input.path, cause },
    )
  }
}

function hasXfa(document) {
  const acroForm = document.catalog.getAcroForm()
  return Boolean(acroForm?.dict?.has(PDFName.of('XFA')))
}

function inspectForm(document, { includeFields = true } = {}) {
  const xfa = hasXfa(document)
  if (xfa) {
    return { hasXfa: true, fields: [], signatures: [] }
  }
  const acroForm = document.catalog.getAcroForm()
  if (!acroForm) return { hasXfa: false, fields: [], signatures: [] }
  let fields
  try {
    fields = document.getForm().getFields()
  } catch (cause) {
    throw pdfError(
      `Unable to inspect AcroForm fields: ${cause?.message || 'unsupported form structure'}`,
      422,
      'PDF_FORM_UNSUPPORTED',
      { cause },
    )
  }
  const signatures = fields
    .filter((field) => field instanceof PDFSignature || field?.constructor?.name === 'PDFSignature')
    .map((field) => field.getName())
  return {
    hasXfa: false,
    fields: includeFields
      ? fields.map((field) => ({ name: field.getName(), type: field.constructor?.name || 'PDFField' }))
      : fields,
    signatures,
  }
}

function assertTransformable(document, inputPath, { allowForms = true } = {}) {
  const form = inspectForm(document, { includeFields: false })
  if (form.hasXfa) {
    throw pdfError(
      `XFA PDFs cannot be transformed safely: ${inputPath}. pdf-lib cannot read, modify, or preserve XFA forms.`,
      422,
      'PDF_XFA_UNSUPPORTED',
      { path: inputPath, hasXfa: true },
    )
  }
  if (form.signatures.length) {
    throw pdfError(
      `Digitally signed PDFs cannot be transformed safely: ${inputPath}. Any rewrite would invalidate the signature.`,
      422,
      'PDF_SIGNATURE_UNSUPPORTED',
      { path: inputPath, signatures: form.signatures },
    )
  }
  if (!allowForms && form.fields.length) {
    throw pdfError(
      `This operation cannot preserve interactive AcroForm fields in ${inputPath}. Fill and flatten the form first, or use rotate/watermark/fill_form.`,
      422,
      'PDF_FORM_COPY_UNSUPPORTED',
      { path: inputPath, fields: form.fields.map((field) => field.getName()) },
    )
  }
  return form
}

function resolveOutput(rawPath, { userId = null, overwrite = false } = {}) {
  const requestedPath = requireString(rawPath, 'output path')
  const resolved = resolveForFileTool(requestedPath, { userId, write: true, allowMissing: true })
  if (fs.existsSync(resolved.fullPath)) {
    const stat = fs.statSync(resolved.fullPath)
    if (!stat.isFile()) {
      throw pdfError(`PDF output is not a file path: ${resolved.displayPath}`, 400, 'PDF_OUTPUT_NOT_FILE')
    }
    if (!overwrite) {
      throw pdfError(
        `Output already exists: ${resolved.displayPath}. Set overwrite=true to replace it.`,
        409,
        'PDF_OUTPUT_EXISTS',
        { path: resolved.displayPath },
      )
    }
  }
  return {
    fullPath: resolved.fullPath,
    path: resolved.displayPath,
    scope: resolved.source,
  }
}

function parsePageNumber(value, pageCount, label) {
  const page = Number(value)
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw pdfError(`${label} must be an integer from 1 to ${pageCount}`, 400, 'PDF_PAGE_OUT_OF_RANGE')
  }
  return page
}

function expandRange(range, pageCount, label) {
  let start
  let end
  if (typeof range === 'string') {
    const match = range.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/u)
    if (!match) throw pdfError(`${label} must look like "2" or "2-5"`, 400, 'PDF_INVALID_RANGE')
    start = parsePageNumber(match[1], pageCount, `${label} start`)
    end = parsePageNumber(match[2] ?? match[1], pageCount, `${label} end`)
  } else if (range && typeof range === 'object' && !Array.isArray(range)) {
    start = parsePageNumber(range.start, pageCount, `${label}.start`)
    end = parsePageNumber(range.end ?? range.start, pageCount, `${label}.end`)
  } else {
    throw pdfError(`${label} must be a range string or {start,end}`, 400, 'PDF_INVALID_RANGE')
  }
  if (start > end) throw pdfError(`${label} start must not exceed end`, 400, 'PDF_INVALID_RANGE')
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

function selectedPages({ pages, ranges }, pageCount, { defaultAll = false, label = 'selection' } = {}) {
  const result = []
  if (pages != null) {
    if (!Array.isArray(pages)) throw pdfError(`${label}.pages must be an array`, 400, 'PDF_INVALID_PAGES')
    pages.forEach((page, index) => result.push(parsePageNumber(page, pageCount, `${label}.pages[${index}]`)))
  }
  if (ranges != null) {
    if (!Array.isArray(ranges)) throw pdfError(`${label}.ranges must be an array`, 400, 'PDF_INVALID_RANGES')
    ranges.forEach((range, index) => result.push(...expandRange(range, pageCount, `${label}.ranges[${index}]`)))
  }
  if (!result.length && defaultAll) {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }
  if (!result.length) throw pdfError(`${label} requires pages and/or ranges`, 400, 'PDF_EMPTY_PAGE_SELECTION')
  return [...new Set(result)]
}

function normalizeSplitOutputs(args, pageCount) {
  let rawOutputs = args.outputs
  if (rawOutputs == null) {
    const rangedOutputs = Array.isArray(args.ranges)
      ? args.ranges.filter((range) => range && typeof range === 'object' && (range.output || range.path))
      : []
    if (rangedOutputs.length && rangedOutputs.length === args.ranges.length) {
      rawOutputs = rangedOutputs.map((range) => ({
        path: range.path || range.output,
        ranges: [{ start: range.start, end: range.end }],
      }))
    } else if (args.output) {
      rawOutputs = [{ path: args.output, pages: args.pages, ranges: args.ranges }]
    }
  }
  if (!Array.isArray(rawOutputs) || !rawOutputs.length) {
    throw pdfError('split requires outputs (or one output with pages/ranges)', 400, 'PDF_SPLIT_OUTPUTS_REQUIRED')
  }
  return rawOutputs.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw pdfError(`outputs[${index}] must be an object`, 400, 'PDF_INVALID_ARGUMENT')
    }
    return {
      path: entry.path || entry.output,
      pages: selectedPages(entry, pageCount, { label: `outputs[${index}]` }),
    }
  })
}

export {
  DEFAULT_RENDER_DPI,
  MAX_RENDER_DIMENSION,
  MAX_RENDER_DPI,
  MAX_RENDER_PAGE_PIXELS,
  MAX_RENDER_PAGES,
  MAX_RENDER_TOTAL_PIXELS,
  MIN_RENDER_DPI,
  PDFJS_STANDARD_FONT_DATA_URL,
  SUPPORTED_OPERATIONS,
  assertTransformable,
  embedTextFont,
  inspectForm,
  loadPdf,
  loadPdfJs,
  normalizeSplitOutputs,
  outputByteLimit,
  parsePageNumber,
  pdfError,
  readPdfInput,
  requireString,
  resolveOutput,
  selectedPages,
  textCharacterLimit,
  textItemLimit,
  textPageLimit,
  throwIfPdfAborted,
}
