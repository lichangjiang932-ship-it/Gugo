import fs from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { PDFDocument, rgb } from 'pdf-lib'
import { officeImageSize } from './officeImageLayout.js'
import { validatePreparedOfficeImages } from './officePreparedImageValidation.js'

const PDF_CJK_FONT_PATH = fileURLToPath(new URL('../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url))
const PDF_PAGE_WIDTH = 595.28
const PDF_PAGE_HEIGHT = 841.89
const PDF_MARGIN_X = 56
const PDF_MARGIN_TOP = 58
const PDF_MARGIN_BOTTOM = 52

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

function pdfTextWidth(font, text, size) {
  return font.widthOfTextAtSize(String(text || ''), size)
}

function wrapPdfText(text, font, size, maxWidth) {
  const source = String(text || '').replace(/\s+/g, ' ').trim()
  if (!source) return []
  const lines = []
  let current = ''
  for (const character of source) {
    const candidate = `${current}${character}`
    if (current && pdfTextWidth(font, candidate, size) > maxWidth) {
      lines.push(current.trimEnd())
      current = character.trimStart()
    } else {
      current = candidate
    }
  }
  if (current.trim()) lines.push(current.trimEnd())
  return lines
}

export function normalizePdfArtifactInput({ title = 'Document', blocks = [] } = {}) {
  return {
    normalizedTitle: String(title || 'Document').trim().slice(0, 200) || 'Document',
    contentBlocks: (Array.isArray(blocks) ? blocks : [])
      .map((block) => ({
        type: ['title', 'heading', 'bullet'].includes(block?.type) ? block.type : 'paragraph',
        text: String(block?.text || '').trim(),
      }))
      .filter((block) => block.text),
  }
}

export async function buildPdfArtifactBuffer({
  normalizedTitle = 'Document',
  contentBlocks = [],
  preparedImages = [],
} = {}) {
  const images = validatePreparedOfficeImages(preparedImages)
  if (!contentBlocks.length && !images.length) {
    throw new Error('PDF content blocks 或 images 不能为空')
  }

  const document = await PDFDocument.create()
  let font = null
  if (contentBlocks.length) {
    document.registerFontkit(pdfLibFontkit)
    try {
      font = await document.embedFont(fs.readFileSync(PDF_CJK_FONT_PATH), { subset: true })
    } catch (cause) {
      throw new Error(`PDF 中文字体加载失败: ${cause?.message || cause}`, { cause })
    }
  }
  document.setTitle(normalizedTitle)
  document.setCreator('Gugo')
  document.setProducer('Gugo PDF artifact generator')

  let page = null
  let y = 0
  const addPage = () => {
    page = document.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
    y = PDF_PAGE_HEIGHT - PDF_MARGIN_TOP
  }
  const ensureSpace = (height) => {
    if (!page || y - height < PDF_MARGIN_BOTTOM) addPage()
  }
  const drawBlock = ({ type, text }) => {
    const titleBlock = type === 'title'
    const headingBlock = type === 'heading'
    const bulletBlock = type === 'bullet'
    const size = titleBlock ? 25 : headingBlock ? 16 : 11.5
    const lineHeight = titleBlock ? 34 : headingBlock ? 24 : 18
    const before = titleBlock ? 0 : headingBlock ? 12 : 4
    const after = titleBlock ? 18 : headingBlock ? 7 : 5
    const prefix = bulletBlock ? '• ' : ''
    const indent = bulletBlock ? 14 : 0
    const maxWidth = PDF_PAGE_WIDTH - (PDF_MARGIN_X * 2) - indent
    const lines = wrapPdfText(`${prefix}${text}`, font, size, maxWidth)
    ensureSpace(before + Math.max(1, lines.length) * lineHeight + after)
    y -= before
    for (const line of lines) {
      ensureSpace(lineHeight + after)
      page.drawText(line, {
        x: PDF_MARGIN_X + indent,
        y: y - size,
        size,
        font,
        color: titleBlock ? rgb(0.08, 0.12, 0.2) : headingBlock ? rgb(0.12, 0.2, 0.34) : rgb(0.16, 0.18, 0.22),
      })
      y -= lineHeight
    }
    y -= after
  }

  if (contentBlocks.length) {
    const startsWithSameTitle = contentBlocks[0]?.type === 'title'
      && contentBlocks[0].text.localeCompare(normalizedTitle, undefined, { sensitivity: 'base' }) === 0
    drawBlock({ type: 'title', text: normalizedTitle })
    for (const block of startsWithSameTitle ? contentBlocks.slice(1) : contentBlocks) drawBlock(block)
  }

  for (const [imageIndex, image] of images.entries()) {
    let targetPage
    if (image.targetIndex) {
      while (document.getPageCount() < image.targetIndex) document.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
      targetPage = document.getPage(image.targetIndex - 1)
    } else {
      targetPage = document.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
    }
    const embedded = image.mimeType === 'image/jpeg'
      ? await document.embedJpg(image.buffer)
      : await document.embedPng(image.buffer)
    const { width: pageWidth, height: pageHeight } = targetPage.getSize()
    const availableWidth = Math.max(1, pageWidth - (PDF_MARGIN_X * 2))
    const availableHeight = Math.max(1, pageHeight - PDF_MARGIN_TOP - PDF_MARGIN_BOTTOM)
    const requested = officeImageSize(image, {
      defaultWidth: availableWidth / 72,
      maxWidth: availableWidth / 72,
      maxHeight: availableHeight / 72,
    })
    const width = requested.width * 72
    const height = requested.height * 72
    const x = image.x == null ? (pageWidth - width) / 2 : image.x * 72
    const yPosition = image.y == null ? (pageHeight - height) / 2 : pageHeight - (image.y * 72) - height
    if (x < 0 || yPosition < 0 || x + width > pageWidth || yPosition + height > pageHeight) {
      throw new Error(`images[${imageIndex}] placement exceeds PDF page bounds`)
    }
    targetPage.drawImage(embedded, { x, y: yPosition, width, height })
  }

  const pages = document.getPages()
  if (contentBlocks.length) {
    pages.forEach((item, index) => {
      const label = `${index + 1} / ${pages.length}`
      item.drawText(label, {
        x: (item.getWidth() - pdfTextWidth(font, label, 9)) / 2,
        y: 24,
        size: 9,
        font,
        color: rgb(0.48, 0.5, 0.54),
      })
    })
  }

  return {
    buffer: Buffer.from(await document.save()),
    pageCount: pages.length,
  }
}
