import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createCanvas } from '@napi-rs/canvas'
import sharp from 'sharp'
import { resolveForFileTool } from './fsShellSupport.js'
import {
  loadPdfJs, PDFJS_STANDARD_FONT_DATA_URL, readPdfInput, selectedPages, pdfError,
  throwIfPdfAborted, MAX_RENDER_PAGE_PIXELS, MAX_RENDER_TOTAL_PIXELS,
} from './pdfToolSupport.js'
import { issuePdfLayoutReceipt } from '../utils/pdfLayoutReceipt.js'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const text = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim()

function fail(message, details = {}) {
  throw pdfError(message, 422, 'PDF_LAYOUT_VERIFICATION_FAILED', details)
}

function inRectangle(item, rectangle) {
  const values = [item.x, item.y, item.width, item.height,
    rectangle.x, rectangle.y, rectangle.width, rectangle.height]
  return values.every(Number.isFinite)
    && item.width >= 0 && item.height >= 0
    && item.x >= rectangle.x - 1 && item.y >= rectangle.y - 1
    && item.x + item.width <= rectangle.x + rectangle.width + 1
    && item.y + item.height <= rectangle.y + rectangle.height + 1
}

async function renderer(input, signal) {
  const pdfjs = await loadPdfJs()
  const task = pdfjs.getDocument({
    data: new Uint8Array(input.bytes), disableWorker: true, isEvalSupported: false,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL, useWorkerFetch: false,
  })
  const document = await task.promise
  let pixels = 0
  return {
    async page(number, scale = 1) {
      throwIfPdfAborted(signal)
      const page = await document.getPage(number)
      const viewport = page.getViewport({ scale })
      const width = Math.ceil(viewport.width)
      const height = Math.ceil(viewport.height)
      pixels += width * height
      if (width * height > MAX_RENDER_PAGE_PIXELS || pixels > MAX_RENDER_TOTAL_PIXELS) {
        fail('PDF layout rendering exceeds the existing image resource limits.')
      }
      const canvas = createCanvas(width, height)
      const context = canvas.getContext('2d')
      await page.render({ canvasContext: context, viewport }).promise
      throwIfPdfAborted(signal)
      const image = context.getImageData(0, 0, width, height)
      page.cleanup()
      return { width, height, pixels: Buffer.from(image.data) }
    },
    async close() { await document.destroy() },
  }
}

async function verifyVisualEvidence({ input, source, pages, previews, userId, signal, checks }) {
  if (!source && previews.length === 0) return []
  const outputRenderer = await renderer(input, signal)
  let sourceRenderer
  const evidence = []
  try {
    if (source) {
      sourceRenderer = await renderer(source, signal)
      for (let page = 1; page <= input.pageCount; page += 1) {
        if (pages.includes(page)) continue
        const before = await sourceRenderer.page(page)
        const after = await outputRenderer.page(page)
        if (before.width !== after.width || before.height !== after.height
          || !before.pixels.equals(after.pixels)) fail(`Non-target PDF page ${page} changed.`)
      }
      checks.push({ kind: 'untargeted_pages_unchanged', passed: true })
    }
    for (const preview of previews) {
      if (!Number.isInteger(preview.page) || preview.page < 1 || preview.page > input.pageCount) {
        fail('Preview page is outside the output PDF.')
      }
      const resolved = resolveForFileTool(preview.path, { userId })
      const bytes = fs.readFileSync(resolved.fullPath)
      const metadata = await sharp(bytes, { limitInputPixels: MAX_RENDER_PAGE_PIXELS }).metadata()
      if (metadata.format !== 'png' || !metadata.width || !metadata.height) fail('Preview must be a real PNG.')
      const page = input.pages[preview.page - 1]
      const pageWidth = page.rotation % 180 === 0 ? page.width : page.height
      const rendered = await outputRenderer.page(preview.page, metadata.width / pageWidth)
      const actual = await sharp(bytes, { limitInputPixels: MAX_RENDER_PAGE_PIXELS })
        .flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer()
      if (metadata.width !== rendered.width || metadata.height !== rendered.height
        || !actual.equals(rendered.pixels)) fail(`Preview for page ${preview.page} is not a fresh rendering.`)
      evidence.push({ path: resolved.fullPath, page: preview.page, sha256: digest(bytes) })
    }
    if (previews.length) checks.push({ kind: 'fresh_page_previews', passed: true })
    return evidence
  } finally {
    await sourceRenderer?.close()
    await outputRenderer.close()
  }
}

/**
 * The caller supplies the existing builtin pdf_text parser, avoiding a reader
 * import cycle. Dependencies are a trusted host seam, never tool arguments.
 */
export async function verifyPdfLayout(args, binding = {}, {
  readText, readInput = readPdfInput,
} = {}) {
  const { userId = null, signal = null } = binding
  throwIfPdfAborted(signal)
  const rule = args.verifyLayout
  if (!rule || typeof rule !== 'object' || !text(rule.expectedText)) {
    fail('PDF layout verification requires explicit expectedText.')
  }
  const input = readInput(args.path || args.input, { userId })
  const parsed = await readText({ path: args.path || args.input, includeItems: true }, { userId, signal })
  if (parsed.pages.length !== parsed.pageCount) fail('Layout verification requires every output page.')
  input.pageCount = parsed.pageCount
  input.pages = parsed.pages
  const pages = selectedPages({ pages: rule.pages }, parsed.pageCount, {
    defaultAll: true, label: 'PDF layout target',
  })
  const targetText = text(parsed.pages.filter((page) => pages.includes(page.page)).map((page) => page.text).join('\n'))
  if (!targetText.includes(text(rule.expectedText))) fail('The required PDF text is missing or out of order.')
  if (rule.sectionLabel && !targetText.toLowerCase().includes(text(rule.sectionLabel).toLowerCase())) {
    fail('The selected PDF section label is absent from the target pages.')
  }
  const checks = [{ kind: 'complete_pdf_read', passed: true }, { kind: 'expected_text', passed: true }]
  let source = null
  let sourceText = null
  if (rule.source) {
    source = readInput(rule.source, { userId })
    if (source.fullPath === input.fullPath) fail('Source must preserve the PDF before this output was written.')
    sourceText = await readText({ path: rule.source, includeItems: true }, { userId, signal })
    if (sourceText.pageCount !== parsed.pageCount || sourceText.pages.length !== parsed.pageCount) {
      fail('Source and output page trees do not match.')
    }
    if (rule.sectionLabel) {
      const label = text(rule.sectionLabel).toLowerCase()
      const labelled = sourceText.pages.filter((page) => text(page.text).slice(0, 512).toLowerCase().includes(label))
      if (!labelled.some((page) => pages.includes(page.page))) {
        fail('Target pages do not contain the authoritative section in the original source.')
      }
      checks.push({ kind: 'source_section_placement', passed: true })
    }
  }
  for (const page of parsed.pages) {
    const fullPage = { x: page.originX || 0, y: page.originY || 0, width: page.width, height: page.height }
    for (const item of page.items || []) {
      if (!inRectangle(item, fullPage)) fail(`Text escapes the bounds of PDF page ${page.page}.`)
    }
    const before = sourceText?.pages.find((entry) => entry.page === page.page)?.items || []
    const itemKey = (item) => JSON.stringify([item.text, item.x, item.y, item.width, item.height, item.rotation])
    const previous = new Set(before.map(itemKey))
    const changed = sourceText ? (page.items || []).filter((item) => !previous.has(itemKey(item))) : page.items || []
    for (const rectangle of rule.rectangles || []) {
      if (rectangle.page !== page.page) continue
      if (rectangle.width <= 0 || rectangle.height <= 0 || !inRectangle(rectangle, fullPage)
        || changed.some((item) => !inRectangle(item, rectangle))) {
        fail(`Text escapes the required writable rectangle on page ${page.page}.`)
      }
    }
  }
  checks.push({ kind: 'glyph_bounds', passed: true })
  const previews = await verifyVisualEvidence({
    input, source, pages, previews: rule.previews || [], userId, signal, checks,
  })
  throwIfPdfAborted(signal)
  // Re-read through the same permission boundary after async parsing/rendering.
  if (!readInput(args.path || args.input, { userId }).bytes.equals(input.bytes)
    || (source && !readInput(rule.source, { userId }).bytes.equals(source.bytes))) {
    fail('PDF bytes changed during verification.')
  }
  return issuePdfLayoutReceipt({
    userId, sessionId: binding.sessionId || null, executionId: binding.executionId || null,
    output: { path: input.fullPath, sha256: digest(input.bytes), byteLength: input.bytes.length },
    source: source ? { path: source.fullPath, sha256: digest(source.bytes) } : null,
    pages, pageCount: parsed.pageCount,
    sectionLabel: rule.sectionLabel || null, expectedTextSha256: digest(text(rule.expectedText)),
    checks, previews,
  })
}
