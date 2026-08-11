import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib'
import { resolveForFileTool } from './fsShellTools.js'

const DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_TEXT_PAGES = 200
const DEFAULT_MAX_TEXT_CHARACTERS = 1_000_000
const DEFAULT_MAX_TEXT_ITEMS = 50_000
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

function normalizePathKey(value) {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
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

function assertOutputSize(bytes, displayPath) {
  const size = bytes.byteLength
  const maxBytes = outputByteLimit()
  if (size > maxBytes) {
    throw pdfError(
      `PDF output is too large (${size} bytes; limit ${maxBytes}): ${displayPath}`,
      413,
      'PDF_OUTPUT_TOO_LARGE',
      { size, maxBytes, path: displayPath },
    )
  }
  return size
}

function stageOutput(output, bytes) {
  fs.mkdirSync(path.dirname(output.fullPath), { recursive: true })
  const tempPath = path.join(
    path.dirname(output.fullPath),
    `.${path.basename(output.fullPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let descriptor
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    return tempPath
  } catch (cause) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* best effort cleanup */ }
    }
    try { fs.unlinkSync(tempPath) } catch { /* best effort cleanup */ }
    throw pdfError(`Unable to stage PDF output: ${output.path}`, 500, 'PDF_OUTPUT_WRITE_FAILED', { cause })
  }
}

function writeOutputsAtomically(items, { overwrite = false } = {}) {
  const seen = new Set()
  for (const item of items) {
    const key = normalizePathKey(item.output.fullPath)
    if (seen.has(key)) {
      throw pdfError(`Duplicate PDF output path: ${item.output.path}`, 400, 'PDF_DUPLICATE_OUTPUT')
    }
    seen.add(key)
    assertOutputSize(item.bytes, item.output.path)
  }

  const staged = []
  try {
    for (const item of items) {
      staged.push({ ...item, tempPath: stageOutput(item.output, item.bytes) })
    }
  } catch (cause) {
    for (const item of staged) {
      try { fs.unlinkSync(item.tempPath) } catch { /* best effort cleanup */ }
    }
    throw cause
  }
  const published = []
  try {
    for (const item of staged) {
      if (overwrite) {
        fs.renameSync(item.tempPath, item.output.fullPath)
      } else {
        // Linking a fully written sibling temp file publishes it atomically and
        // fails with EEXIST instead of racing into an accidental overwrite.
        fs.linkSync(item.tempPath, item.output.fullPath)
        fs.unlinkSync(item.tempPath)
      }
      published.push(item)
    }
  } catch (cause) {
    if (!overwrite) {
      for (const item of published) {
        try { fs.unlinkSync(item.output.fullPath) } catch { /* best effort rollback */ }
      }
    }
    const failed = staged.find((item) => fs.existsSync(item.tempPath)) || staged[published.length]
    throw pdfError(
      `Unable to publish PDF output atomically: ${failed?.output?.path || 'unknown output'}`,
      cause?.code === 'EEXIST' ? 409 : 500,
      cause?.code === 'EEXIST' ? 'PDF_OUTPUT_EXISTS' : 'PDF_OUTPUT_WRITE_FAILED',
      { cause },
    )
  } finally {
    for (const item of staged) {
      try { fs.unlinkSync(item.tempPath) } catch { /* already moved or best effort cleanup */ }
    }
  }

  return staged.map((item) => ({
    path: item.output.path,
    scope: item.output.scope,
    size: item.bytes.byteLength,
    ...(item.pageCount == null ? {} : { pageCount: item.pageCount }),
    ...(item.pages == null ? {} : { pages: item.pages }),
  }))
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

function metadataDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null
}

function inspectPage(page, index) {
  const { width, height } = page.getSize()
  return {
    page: index + 1,
    width,
    height,
    rotation: page.getRotation().angle,
  }
}

async function pdfInfo(args, { userId = null } = {}) {
  const input = readPdfInput(args?.path || args?.input, { userId })
  let loaded
  try {
    loaded = await loadPdf(input)
  } catch (error) {
    if (error?.code !== 'PDF_ENCRYPTED') throw error
    return {
      ok: true,
      path: input.path,
      scope: input.scope,
      size: input.size,
      encrypted: true,
      supported: false,
      limitations: ['Encrypted PDFs must be decrypted before inspection or transformation.'],
    }
  }
  const { document } = loaded
  const form = inspectForm(document)
  const limitations = []
  if (form.hasXfa) limitations.push('XFA forms are detected but cannot be read, modified, or preserved by pdf-lib.')
  if (form.signatures.length) limitations.push('Digital signatures cannot be preserved; transformations are rejected.')
  return {
    ok: true,
    path: input.path,
    scope: input.scope,
    size: input.size,
    encrypted: false,
    supported: !form.hasXfa && !form.signatures.length,
    pageCount: document.getPageCount(),
    pages: document.getPages().map(inspectPage),
    metadata: {
      title: document.getTitle() ?? null,
      author: document.getAuthor() ?? null,
      subject: document.getSubject() ?? null,
      keywords: document.getKeywords() ?? null,
      creator: document.getCreator() ?? null,
      producer: document.getProducer() ?? null,
      creationDate: metadataDate(document.getCreationDate()),
      modificationDate: metadataDate(document.getModificationDate()),
    },
    form: {
      interactive: form.fields.length > 0,
      hasXfa: form.hasXfa,
      fields: form.fields,
      signatures: form.signatures,
    },
    limitations,
  }
}

function roundedCoordinate(value) {
  return Number(Number(value).toFixed(3))
}

function pdfTextItemBox(item, styles) {
  const transform = Array.isArray(item.transform) ? item.transform.map(Number) : []
  if (transform.length !== 6 || transform.some((value) => !Number.isFinite(value))) return null
  const [a, b, c, d, originX, originY] = transform
  const angle = Math.atan2(b, a)
  const directionX = Math.cos(angle)
  const directionY = Math.sin(angle)
  const normalX = -directionY
  const normalY = directionX
  const style = styles?.[item.fontName] || {}
  const fontHeight = Math.max(Math.hypot(c, d), Number(item.height) || 0)
  const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.8
  const descent = Number.isFinite(style.descent) ? style.descent : -0.2
  const lower = fontHeight * Math.min(descent, ascent)
  const upper = fontHeight * Math.max(descent, ascent)
  const advance = Math.max(0, Number(item.width) || 0)
  const points = [
    [originX + (normalX * lower), originY + (normalY * lower)],
    [originX + (normalX * upper), originY + (normalY * upper)],
    [originX + (directionX * advance) + (normalX * lower), originY + (directionY * advance) + (normalY * lower)],
    [originX + (directionX * advance) + (normalX * upper), originY + (directionY * advance) + (normalY * upper)],
  ]
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    text: item.str,
    x: roundedCoordinate(x),
    y: roundedCoordinate(y),
    width: roundedCoordinate(Math.max(...xs) - x),
    height: roundedCoordinate(Math.max(...ys) - y),
    rotation: roundedCoordinate((angle * 180) / Math.PI),
    direction: item.dir || null,
    fontName: item.fontName || null,
    hasEOL: item.hasEOL === true,
  }
}

function pdfTextParseError(inputPath, cause) {
  const name = String(cause?.name || '')
  const message = String(cause?.message || '')
  if (name === 'PasswordException' || /password/i.test(message)) {
    return pdfError(
      `PDF 已加密，无法提取文本：${inputPath}。请先解密文件。`,
      422,
      'PDF_ENCRYPTED',
      { path: inputPath, encrypted: true, cause },
    )
  }
  return pdfError(
    `无法提取 PDF 文本：${inputPath}。${message || '文件结构无效或不受支持。'}`,
    422,
    'PDF_TEXT_PARSE_FAILED',
    { path: inputPath, cause },
  )
}

async function pdfText(args, { userId = null } = {}) {
  const input = readPdfInput(args?.path || args?.input, { userId })
  const includeItems = args?.includeItems !== false && args?.include_items !== false
  const maxPages = textPageLimit()
  const maxCharacters = textCharacterLimit()
  const maxItems = textItemLimit()
  let loadingTask
  let document
  try {
    const pdfjs = await loadPdfJs()
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(input.bytes),
      disableWorker: true,
      isEvalSupported: false,
      standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
      useWorkerFetch: false,
    })
    document = await loadingTask.promise
    const pages = selectedPages(args || {}, document.numPages, { defaultAll: true, label: 'pdf_text' })
    if (pages.length > maxPages) {
      throw pdfError(
        `请求提取 ${pages.length} 页，超过 PDF 文本提取上限 ${maxPages} 页。请用 pages/ranges 分批读取。`,
        413,
        'PDF_TEXT_PAGE_LIMIT_EXCEEDED',
        { pages: pages.length, maxPages },
      )
    }
    const extractedPages = []
    let characterCount = 0
    let itemCount = 0
    for (const pageNumber of pages) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent({ disableNormalization: false })
      let text = ''
      const items = []
      for (const rawItem of content.items) {
        if (typeof rawItem?.str !== 'string') continue
        itemCount += 1
        if (itemCount > maxItems) {
          throw pdfError(
            `PDF 文本项数量超过上限 ${maxItems}。请用 pages/ranges 分批读取。`,
            413,
            'PDF_TEXT_ITEM_LIMIT_EXCEEDED',
            { items: itemCount, maxItems },
          )
        }
        const fragment = `${rawItem.str}${rawItem.hasEOL ? '\n' : ''}`
        text += fragment
        characterCount += fragment.length
        if (characterCount > maxCharacters) {
          throw pdfError(
            `PDF 文本字符数超过上限 ${maxCharacters}。请用 pages/ranges 分批读取。`,
            413,
            'PDF_TEXT_CHARACTER_LIMIT_EXCEEDED',
            { characters: characterCount, maxCharacters },
          )
        }
        if (includeItems && rawItem.str) {
          const item = pdfTextItemBox(rawItem, content.styles)
          if (item) items.push(item)
        }
      }
      const viewport = page.getViewport({ scale: 1 })
      const [viewX1, viewY1, viewX2, viewY2] = page.view.map(Number)
      extractedPages.push({
        page: pageNumber,
        // Text item transforms use the unrotated PDF user space. Keep these
        // dimensions in that same space so item rectangles can be passed to
        // pdf_transform.overlay_text even when the page has /Rotate=90/270.
        width: roundedCoordinate(Math.abs(viewX2 - viewX1)),
        height: roundedCoordinate(Math.abs(viewY2 - viewY1)),
        rotation: viewport.rotation,
        text,
        ...(includeItems ? { items } : {}),
      })
      page.cleanup()
    }
    return {
      ok: true,
      path: input.path,
      scope: input.scope,
      pageCount: document.numPages,
      pages: extractedPages,
      characterCount,
      itemCount,
      coordinateSystem: 'PDF points (1/72 inch), bottom-left origin; item rectangles are axis-aligned bounds.',
      limitations: ['Image-only/scanned pages require OCR; pdf_text does not perform OCR.'],
    }
  } catch (cause) {
    if (cause?.code) throw cause
    throw pdfTextParseError(input.path, cause)
  } finally {
    try { await document?.destroy() } catch { /* best effort cleanup */ }
    try { await loadingTask?.destroy() } catch { /* best effort cleanup */ }
  }
}

async function mergePdfs(args, context) {
  if (!Array.isArray(args.inputs) || args.inputs.length < 1) {
    throw pdfError('merge requires a non-empty inputs array', 400, 'PDF_INPUTS_REQUIRED')
  }
  const inputs = await Promise.all(args.inputs.map(async (entry, index) => {
    const rawPath = typeof entry === 'string' ? entry : entry?.path || entry?.input
    if (!rawPath) throw pdfError(`inputs[${index}] requires a path`, 400, 'PDF_INVALID_ARGUMENT')
    return loadPdf(readPdfInput(rawPath, context))
  }))
  for (const input of inputs) assertTransformable(input.document, input.path, { allowForms: false })
  const outputDocument = await PDFDocument.create()
  for (const input of inputs) {
    const copied = await outputDocument.copyPages(input.document, input.document.getPageIndices())
    copied.forEach((page) => outputDocument.addPage(page))
  }
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  const bytes = await outputDocument.save({ useObjectStreams: true })
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: outputDocument.getPageCount() }],
    { overwrite: args.overwrite === true },
  )
  return { ok: true, operation: 'merge', inputs: inputs.map((item) => item.path), outputs }
}

async function splitPdf(args, context) {
  const input = await loadPdf(readPdfInput(args.input || args.path, context))
  assertTransformable(input.document, input.path, { allowForms: false })
  const definitions = normalizeSplitOutputs(args, input.document.getPageCount())
  const outputItems = []
  for (const definition of definitions) {
    const outputDocument = await PDFDocument.create()
    const copied = await outputDocument.copyPages(input.document, definition.pages.map((page) => page - 1))
    copied.forEach((page) => outputDocument.addPage(page))
    const output = resolveOutput(definition.path, { ...context, overwrite: args.overwrite === true })
    outputItems.push({
      output,
      bytes: await outputDocument.save({ useObjectStreams: true }),
      pageCount: definition.pages.length,
      pages: definition.pages,
    })
  }
  const outputs = writeOutputsAtomically(outputItems, { overwrite: args.overwrite === true })
  return { ok: true, operation: 'split', input: input.path, outputs }
}

function normalizeRightAngle(value) {
  const angle = Number(value)
  if (!Number.isFinite(angle) || !Number.isInteger(angle) || angle % 90 !== 0) {
    throw pdfError('degrees must be an integer multiple of 90', 400, 'PDF_INVALID_ROTATION')
  }
  return ((angle % 360) + 360) % 360
}

async function rotatePdf(args, context) {
  const input = await loadPdf(readPdfInput(args.input || args.path, context))
  assertTransformable(input.document, input.path)
  const amount = normalizeRightAngle(args.degrees)
  const pages = selectedPages(args, input.document.getPageCount(), { defaultAll: true })
  pages.forEach((pageNumber) => {
    const page = input.document.getPage(pageNumber - 1)
    const next = (page.getRotation().angle + amount) % 360
    page.setRotation(degrees(next))
  })
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  const bytes = await input.document.save({ useObjectStreams: true, updateFieldAppearances: false })
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: input.document.getPageCount(), pages }],
    { overwrite: args.overwrite === true },
  )
  return { ok: true, operation: 'rotate', input: input.path, degrees: amount, pages, outputs }
}

function finiteNumber(value, fallback, name, { min = -Infinity, max = Infinity, minExclusive = false } = {}) {
  const candidate = value == null ? fallback : Number(value)
  const aboveMin = minExclusive ? candidate > min : candidate >= min
  if (!Number.isFinite(candidate) || !aboveMin || candidate > max) {
    throw pdfError(`${name} must be ${minExclusive ? 'greater than' : 'at least'} ${min} and at most ${max}`, 400, 'PDF_INVALID_ARGUMENT')
  }
  return candidate
}

function centeredRotatedTextBaseline(font, text, fontSize, rotation, pageWidth, pageHeight) {
  const textWidth = font.widthOfTextAtSize(text, fontSize)
  const heightWithDescender = font.heightAtSize(fontSize, { descender: true })
  const ascent = font.heightAtSize(fontSize, { descender: false })
  const descentDepth = Math.max(0, heightWithDescender - ascent)
  const radians = (rotation * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const localCenterX = textWidth / 2
  const localCenterY = (ascent - descentDepth) / 2
  return {
    x: (pageWidth / 2) - ((localCenterX * cosine) - (localCenterY * sine)),
    y: (pageHeight / 2) - ((localCenterX * sine) + (localCenterY * cosine)),
    textWidth,
    textHeight: heightWithDescender,
  }
}

async function watermarkPdf(args, context) {
  const input = await loadPdf(readPdfInput(args.input || args.path, context))
  assertTransformable(input.document, input.path)
  const text = requireString(args.text, 'watermark text')
  const opacity = finiteNumber(args.opacity, 0.25, 'opacity', { min: 0, max: 1, minExclusive: true })
  const fontSize = finiteNumber(args.fontSize ?? args.font_size, 36, 'fontSize', { min: 0, max: 1000, minExclusive: true })
  const rotation = finiteNumber(args.rotation, 45, 'rotation', { min: -3600, max: 3600 })
  const pages = selectedPages(args, input.document.getPageCount(), { defaultAll: true })
  const font = await embedTextFont(input.document, [text])
  pages.forEach((pageNumber) => {
    const page = input.document.getPage(pageNumber - 1)
    const { width, height } = page.getSize()
    const placement = centeredRotatedTextBaseline(font, text, fontSize, rotation, width, height)
    page.drawText(text, {
      x: placement.x,
      y: placement.y,
      size: fontSize,
      font,
      color: rgb(0.45, 0.45, 0.45),
      opacity,
      rotate: degrees(rotation),
    })
  })
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  const bytes = await input.document.save({ useObjectStreams: true, updateFieldAppearances: false })
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: input.document.getPageCount(), pages }],
    { overwrite: args.overwrite === true },
  )
  return { ok: true, operation: 'watermark', input: input.path, text, pages, outputs }
}

function parseHexColor(value, fallback, name) {
  const candidate = value == null || value === '' ? fallback : String(value).trim()
  const match = candidate.match(/^#([0-9a-f]{6})$/iu)
  if (!match) throw pdfError(`${name} must be a #RRGGBB color`, 400, 'PDF_INVALID_ARGUMENT')
  const packed = Number.parseInt(match[1], 16)
  return rgb(
    ((packed >> 16) & 0xff) / 255,
    ((packed >> 8) & 0xff) / 255,
    (packed & 0xff) / 255,
  )
}

async function overlayTextPdf(args, context) {
  const input = await loadPdf(readPdfInput(args.input || args.path, context))
  assertTransformable(input.document, input.path)
  if (!Array.isArray(args.patches) || !args.patches.length || args.patches.length > 200) {
    throw pdfError('overlay_text requires between 1 and 200 patches', 400, 'PDF_TEXT_PATCHES_REQUIRED')
  }
  const patchTexts = args.patches.map((patch) => patch?.text ?? '')
  const font = await embedTextFont(input.document, patchTexts)
  const applied = args.patches.map((rawPatch, index) => {
    if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
      throw pdfError(`patches[${index}] must be an object`, 400, 'PDF_INVALID_ARGUMENT')
    }
    const pageNumber = parsePageNumber(rawPatch.page, input.document.getPageCount(), `patches[${index}].page`)
    const page = input.document.getPage(pageNumber - 1)
    const pageSize = page.getSize()
    const x = finiteNumber(rawPatch.x, undefined, `patches[${index}].x`, { min: 0, max: pageSize.width })
    const y = finiteNumber(rawPatch.y, undefined, `patches[${index}].y`, { min: 0, max: pageSize.height })
    const width = finiteNumber(rawPatch.width, undefined, `patches[${index}].width`, {
      min: 0,
      max: pageSize.width,
      minExclusive: true,
    })
    const height = finiteNumber(rawPatch.height, undefined, `patches[${index}].height`, {
      min: 0,
      max: pageSize.height,
      minExclusive: true,
    })
    if (x + width > pageSize.width || y + height > pageSize.height) {
      throw pdfError(`patches[${index}] rectangle exceeds page ${pageNumber}`, 400, 'PDF_TEXT_PATCH_OUT_OF_BOUNDS')
    }
    const text = requireString(rawPatch.text, `patches[${index}].text`)
    if (/\r|\n/u.test(text)) {
      throw pdfError(`patches[${index}].text must be one line`, 400, 'PDF_TEXT_PATCH_MULTILINE_UNSUPPORTED')
    }
    const fontSize = finiteNumber(rawPatch.fontSize ?? rawPatch.font_size, 12, `patches[${index}].fontSize`, {
      min: 0,
      max: 1000,
      minExclusive: true,
    })
    const padding = finiteNumber(rawPatch.padding, 2, `patches[${index}].padding`, {
      min: 0,
      max: Math.min(width, height) / 2,
    })
    const opacity = finiteNumber(rawPatch.opacity, 1, `patches[${index}].opacity`, {
      min: 0,
      max: 1,
      minExclusive: true,
    })
    const backgroundOpacity = finiteNumber(
      rawPatch.backgroundOpacity ?? rawPatch.background_opacity,
      1,
      `patches[${index}].backgroundOpacity`,
      { min: 0, max: 1, minExclusive: true },
    )
    const textWidth = font.widthOfTextAtSize(text, fontSize)
    const textHeight = font.heightAtSize(fontSize, { descender: true })
    if (textWidth > width - (padding * 2) || textHeight > height - (padding * 2)) {
      throw pdfError(
        `patches[${index}].text does not fit its rectangle; enlarge it or reduce fontSize`,
        400,
        'PDF_TEXT_PATCH_DOES_NOT_FIT',
      )
    }
    const cover = rawPatch.cover !== false
    if (cover) {
      page.drawRectangle({
        x,
        y,
        width,
        height,
        color: parseHexColor(rawPatch.backgroundColor ?? rawPatch.background_color, '#FFFFFF', `patches[${index}].backgroundColor`),
        opacity: backgroundOpacity,
      })
    }
    page.drawText(text, {
      x: x + padding,
      y: y + ((height - textHeight) / 2),
      size: fontSize,
      font,
      color: parseHexColor(rawPatch.color, '#000000', `patches[${index}].color`),
      opacity,
    })
    return { page: pageNumber, x, y, width, height, text }
  })
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  let bytes
  try {
    bytes = await input.document.save({ useObjectStreams: true, updateFieldAppearances: false })
  } catch (cause) {
    throw pdfError(`Unable to save text overlay: ${cause?.message || 'save failed'}`, 422, 'PDF_TEXT_PATCH_SAVE_FAILED', { cause })
  }
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: input.document.getPageCount(), pages: [...new Set(applied.map((patch) => patch.page))] }],
    { overwrite: args.overwrite === true },
  )
  return { ok: true, operation: 'overlay_text', input: input.path, patches: applied, outputs }
}

function setFormField(field, value) {
  if (field instanceof PDFTextField) {
    field.setText(value == null ? '' : String(value))
    return
  }
  if (field instanceof PDFCheckBox) {
    if (typeof value !== 'boolean') {
      throw pdfError(`Checkbox field ${field.getName()} requires a boolean`, 400, 'PDF_INVALID_FIELD_VALUE')
    }
    if (value) field.check()
    else field.uncheck()
    return
  }
  if (field instanceof PDFRadioGroup) {
    if (value == null || value === '') field.clear()
    else field.select(String(value))
    return
  }
  if (field instanceof PDFDropdown) {
    if (value == null || value === '') field.clear()
    else field.select(String(value))
    return
  }
  if (field instanceof PDFOptionList) {
    if (value == null || (Array.isArray(value) && !value.length)) field.clear()
    else field.select(Array.isArray(value) ? value.map(String) : String(value))
    return
  }
  if (field instanceof PDFSignature) {
    throw pdfError(`Signature field ${field.getName()} cannot be filled`, 422, 'PDF_SIGNATURE_UNSUPPORTED')
  }
  throw pdfError(
    `Unsupported form field type ${field.constructor?.name || 'PDFField'}: ${field.getName()}`,
    422,
    'PDF_FORM_FIELD_UNSUPPORTED',
  )
}

async function fillFormPdf(args, context) {
  const input = await loadPdf(readPdfInput(args.input || args.path, context))
  const inspected = assertTransformable(input.document, input.path)
  if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields)) {
    throw pdfError('fill_form requires a fields object', 400, 'PDF_FIELDS_REQUIRED')
  }
  const entries = Object.entries(args.fields)
  if (!entries.length) throw pdfError('fill_form fields must not be empty', 400, 'PDF_FIELDS_REQUIRED')
  if (!inspected.fields.length) {
    throw pdfError('PDF does not contain interactive AcroForm fields', 422, 'PDF_FORM_NOT_FOUND')
  }
  const form = input.document.getForm()
  for (const [name, value] of entries) {
    const field = form.getFieldMaybe(name)
    if (!field) throw pdfError(`PDF form field not found: ${name}`, 404, 'PDF_FORM_FIELD_NOT_FOUND')
    try {
      setFormField(field, value)
    } catch (cause) {
      if (cause?.code) throw cause
      throw pdfError(
        `Unable to set PDF form field ${name}: ${cause?.message || 'invalid value'}`,
        422,
        'PDF_INVALID_FIELD_VALUE',
        { cause },
      )
    }
  }
  const flatten = args.flatten === true
  const appearanceFont = await embedTextFont(
    input.document,
    entries.flatMap(([, value]) => Array.isArray(value) ? value.map(String) : [String(value ?? '')]),
  )
  try {
    form.updateFieldAppearances(appearanceFont)
    if (flatten) form.flatten({ updateFieldAppearances: false })
  } catch (cause) {
    throw pdfError(
      `无法生成 PDF 表单字段外观：${cause?.message || '字段值或表单结构不受支持。'}`,
      422,
      'PDF_FORM_APPEARANCE_UNSUPPORTED',
      { cause },
    )
  }
  const output = resolveOutput(args.output, { ...context, overwrite: args.overwrite === true })
  let bytes
  try {
    bytes = await input.document.save({ useObjectStreams: true, updateFieldAppearances: false })
  } catch (cause) {
    throw pdfError(
      `无法保存已填写的 PDF 表单：${cause?.message || '保存失败。'}`,
      422,
      'PDF_FORM_APPEARANCE_UNSUPPORTED',
      { cause },
    )
  }
  const outputs = writeOutputsAtomically(
    [{ output, bytes, pageCount: input.document.getPageCount() }],
    { overwrite: args.overwrite === true },
  )
  return {
    ok: true,
    operation: 'fill_form',
    input: input.path,
    fields: entries.map(([name]) => name),
    flattened: flatten,
    interactiveFormPreserved: !flatten,
    outputs,
  }
}

async function pdfTransform(args, context) {
  const operation = String(args?.operation || '').trim().toLowerCase()
  if (!SUPPORTED_OPERATIONS.has(operation)) {
    throw pdfError(
      `operation must be one of: ${[...SUPPORTED_OPERATIONS].join(', ')}`,
      400,
      'PDF_OPERATION_UNSUPPORTED',
    )
  }
  let result
  switch (operation) {
    case 'merge': result = await mergePdfs(args, context); break
    case 'split': result = await splitPdf(args, context); break
    case 'rotate': result = await rotatePdf(args, context); break
    case 'watermark': result = await watermarkPdf(args, context); break
    case 'overlay_text': result = await overlayTextPdf(args, context); break
    case 'fill_form': result = await fillFormPdf(args, context); break
    default: throw pdfError(`Unsupported PDF operation: ${operation}`, 400, 'PDF_OPERATION_UNSUPPORTED')
  }
  const outputs = Array.isArray(result?.outputs) ? result.outputs : []
  const changedPaths = outputs.map((output) => output?.path).filter(Boolean)
  return {
    ...result,
    ...(outputs.length === 1 ? { path: outputs[0].path, scope: outputs[0].scope } : {}),
    changedPaths,
  }
}

export async function dispatchPdfTool(name, args = {}, { userId = null } = {}) {
  switch (name) {
    case 'pdf_info': return pdfInfo(args, { userId })
    case 'pdf_text': return pdfText(args, { userId })
    case 'pdf_transform': return pdfTransform(args, { userId })
    default: throw pdfError(`unknown PDF tool: ${name}`, 404, 'PDF_TOOL_NOT_FOUND')
  }
}

const pageSelectionProperties = {
  pages: {
    type: 'array',
    items: { type: 'integer', minimum: 1 },
    description: 'Optional 1-based page numbers. Defaults to all pages for rotate/watermark.',
  },
  ranges: {
    type: 'array',
    items: {
      anyOf: [
        { type: 'string', description: 'Inclusive 1-based range such as "2-5".' },
        {
          type: 'object',
          properties: {
            start: { type: 'integer', minimum: 1 },
            end: { type: 'integer', minimum: 1 },
          },
          required: ['start'],
        },
      ],
    },
  },
}

export const PDF_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'pdf_info',
      description: 'Inspect a PDF without the 5 MB text-file limit. Reports pages, metadata, AcroForm fields, encryption, XFA, and digital-signature limitations.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative or user-authorized PDF path.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pdf_text',
      description: 'Extract selectable PDF text page by page, including Unicode/Chinese text and optional text-item coordinates. Coordinates are axis-aligned PDF-point bounds with a bottom-left origin, suitable as a starting point for overlay_text. Does not OCR scanned/image-only pages. Enforces server page, character, and item limits; use pages/ranges to read large PDFs in batches.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative or user-authorized PDF path.' },
          ...pageSelectionProperties,
          includeItems: { type: 'boolean', description: 'Defaults true. Set false to omit coordinate items and return page text only.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pdf_transform',
      description: 'Merge, split, rotate, add Unicode/Chinese watermarks, cover-and-redraw one-line Unicode text by coordinates, or fill PDF forms with Unicode/Chinese values. overlay_text paints an axis-aligned rectangle and a new line; it does not edit/reflow the original text stream. Writes atomically, never overwrites by default, rejects encrypted/XFA/signed PDFs, and preserves AcroForms unless fill_form flatten=true.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: [...SUPPORTED_OPERATIONS] },
          input: { type: 'string', description: 'Input PDF for every operation except merge.' },
          inputs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Input PDFs in merge order.',
          },
          output: { type: 'string', description: 'Output path for merge/rotate/watermark/fill_form or a single split selection.' },
          outputs: {
            type: 'array',
            description: 'For split, one output per independent page selection.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                ...pageSelectionProperties,
              },
              required: ['path'],
            },
          },
          ...pageSelectionProperties,
          degrees: { type: 'integer', description: 'Clockwise relative rotation, in multiples of 90.' },
          text: { type: 'string', description: 'Watermark text.' },
          opacity: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
          fontSize: { type: 'number', exclusiveMinimum: 0 },
          rotation: { type: 'number', description: 'Watermark text rotation in degrees.' },
          patches: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            description: 'For overlay_text, rectangles in PDF points using a bottom-left origin. Existing content is covered with white by default, then one line of Unicode text (including Chinese) is drawn. pdf_text item bounds can be used as a starting point but should be visually verified.',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer', minimum: 1 },
                x: { type: 'number', minimum: 0 },
                y: { type: 'number', minimum: 0 },
                width: { type: 'number', exclusiveMinimum: 0 },
                height: { type: 'number', exclusiveMinimum: 0 },
                text: { type: 'string', minLength: 1 },
                fontSize: { type: 'number', exclusiveMinimum: 0 },
                padding: { type: 'number', minimum: 0 },
                color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
                backgroundColor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
                opacity: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
                backgroundOpacity: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
                cover: { type: 'boolean', description: 'Defaults true. Set false to add text without covering the rectangle.' },
              },
              required: ['page', 'x', 'y', 'width', 'height', 'text'],
              additionalProperties: false,
            },
          },
          fields: {
            type: 'object',
            description: 'fill_form map of fully-qualified field names to text, boolean, option, or option-array values.',
            additionalProperties: true,
          },
          flatten: { type: 'boolean', description: 'Only for fill_form. Defaults false so fields remain interactive.' },
          overwrite: { type: 'boolean', description: 'Defaults false. Set true explicitly to replace an existing output.' },
        },
        required: ['operation'],
      },
    },
  },
]
