import { createCanvas } from '@napi-rs/canvas'
import {
  DEFAULT_RENDER_DPI,
  MAX_RENDER_DIMENSION,
  MAX_RENDER_DPI,
  MAX_RENDER_PAGE_PIXELS,
  MAX_RENDER_PAGES,
  MAX_RENDER_TOTAL_PIXELS,
  MIN_RENDER_DPI,
  PDFJS_STANDARD_FONT_DATA_URL,
  inspectForm,
  loadPdf,
  loadPdfJs,
  outputByteLimit,
  pdfError,
  readPdfInput,
  selectedPages,
  textCharacterLimit,
  textItemLimit,
  textPageLimit,
} from './pdfToolSupport.js'

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

function renderPdfError(inputPath, cause) {
  const name = String(cause?.name || '')
  const message = String(cause?.message || '')
  if (name === 'PasswordException' || /password/i.test(message)) {
    return pdfError(
      `PDF 已加密，无法渲染：${inputPath}。请先解密文件。`,
      422,
      'PDF_ENCRYPTED',
      { path: inputPath, encrypted: true, cause },
    )
  }
  return pdfError(
    `无法渲染 PDF 页面：${inputPath}。${message || '文件结构无效或不受支持。'}`,
    422,
    'PDF_RENDER_FAILED',
    { path: inputPath, cause },
  )
}

function renderFormat(value) {
  const format = String(value || 'png').trim().toLowerCase()
  if (!['png', 'jpeg'].includes(format)) {
    throw pdfError('format must be png or jpeg', 400, 'PDF_RENDER_FORMAT_UNSUPPORTED')
  }
  return format
}

function renderDpi(value) {
  if (value == null || value === '') return DEFAULT_RENDER_DPI
  const dpi = Number(value)
  if (!Number.isFinite(dpi) || dpi < MIN_RENDER_DPI || dpi > MAX_RENDER_DPI) {
    throw pdfError(
      `dpi must be between ${MIN_RENDER_DPI} and ${MAX_RENDER_DPI}`,
      400,
      'PDF_RENDER_DPI_OUT_OF_RANGE',
      { minDpi: MIN_RENDER_DPI, maxDpi: MAX_RENDER_DPI },
    )
  }
  return dpi
}

function throwIfRenderAborted(signal) {
  if (!signal?.aborted) return
  const error = pdfError('PDF 页面渲染已取消', 499, 'ABORT_ERR')
  error.name = 'AbortError'
  error.cancelled = true
  throw error
}

async function renderPdfPages(args, { userId = null, signal = null } = {}) {
  const input = readPdfInput(args?.input || args?.path, { userId })
  const format = renderFormat(args?.format)
  const dpi = renderDpi(args?.dpi)
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png'
  let loadingTask
  let document
  try {
    throwIfRenderAborted(signal)
    const pdfjs = await loadPdfJs()
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(input.bytes),
      disableWorker: true,
      isEvalSupported: false,
      standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
      useWorkerFetch: false,
    })
    document = await loadingTask.promise
    const pages = args?.pages == null
      ? Array.from({ length: document.numPages }, (_, index) => index + 1)
      : selectedPages({ pages: args.pages }, document.numPages, { label: 'render_pdf_pages' })
    if (pages.length > MAX_RENDER_PAGES) {
      throw pdfError(
        `请求渲染 ${pages.length} 页，超过单次上限 ${MAX_RENDER_PAGES} 页。请用 pages 分批渲染。`,
        413,
        'PDF_RENDER_PAGE_LIMIT_EXCEEDED',
        { pages: pages.length, maxPages: MAX_RENDER_PAGES },
      )
    }

    const renderedPages = []
    let totalPixels = 0
    let totalBytes = 0
    for (const pageNumber of pages) {
      throwIfRenderAborted(signal)
      const page = await document.getPage(pageNumber)
      try {
        const viewport = page.getViewport({ scale: dpi / 72 })
        const width = Math.max(1, Math.ceil(viewport.width))
        const height = Math.max(1, Math.ceil(viewport.height))
        const pixels = width * height
        totalPixels += pixels
        if (width > MAX_RENDER_DIMENSION || height > MAX_RENDER_DIMENSION
          || pixels > MAX_RENDER_PAGE_PIXELS || totalPixels > MAX_RENDER_TOTAL_PIXELS) {
          throw pdfError(
            `PDF 页面渲染尺寸过大：第 ${pageNumber} 页为 ${width}×${height} 像素。请降低 dpi 或分批渲染。`,
            413,
            'PDF_RENDER_PIXEL_LIMIT_EXCEEDED',
            {
              page: pageNumber,
              width,
              height,
              pixels,
              maxDimension: MAX_RENDER_DIMENSION,
              maxPagePixels: MAX_RENDER_PAGE_PIXELS,
              maxTotalPixels: MAX_RENDER_TOTAL_PIXELS,
            },
          )
        }
        const canvas = createCanvas(width, height)
        const context = canvas.getContext('2d')
        context.save()
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)
        context.restore()
        const task = page.render({
          canvasContext: context,
          viewport,
          background: 'rgb(255,255,255)',
        })
        const cancelRender = () => task.cancel()
        if (signal) {
          signal.addEventListener('abort', cancelRender, { once: true })
        }
        try {
          await task.promise
        } finally {
          signal?.removeEventListener('abort', cancelRender)
        }
        throwIfRenderAborted(signal)
        const buffer = canvas.toBuffer(mimeType)
        totalBytes += buffer.byteLength
        const maxBytes = outputByteLimit()
        if (totalBytes > maxBytes) {
          throw pdfError(
            `PDF 页面图片总输出过大（${totalBytes} 字节；上限 ${maxBytes} 字节）。请降低 dpi 或分批渲染。`,
            413,
            'PDF_OUTPUT_TOO_LARGE',
            { size: totalBytes, maxBytes, path: input.path },
          )
        }
        renderedPages.push({
          page: pageNumber,
          width,
          height,
          dpi,
          format,
          mimeType,
          size: buffer.byteLength,
          buffer,
        })
      } finally {
        page.cleanup()
      }
    }
    return {
      ok: true,
      input: input.path,
      scope: input.scope,
      title: typeof args?.title === 'string' ? args.title.trim() : '',
      pageCount: document.numPages,
      renderedPageCount: renderedPages.length,
      pages: renderedPages,
      format,
      mimeType,
      dpi,
      totalBytes,
    }
  } catch (cause) {
    throwIfRenderAborted(signal)
    if (cause?.code) throw cause
    throw renderPdfError(input.path, cause)
  } finally {
    try { await document?.destroy() } catch { /* best effort cleanup */ }
    try { await loadingTask?.destroy() } catch { /* best effort cleanup */ }
  }
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

export {
  pdfInfo,
  pdfText,
  renderPdfPages,
}
