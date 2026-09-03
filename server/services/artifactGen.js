/**
 * Artifact generation compatibility facade.
 *
 * Format encoders, delivery, atomic generated-file writes, and local-file
 * publication are delegated to focused host-owned services.
 */

import crypto from 'node:crypto'
import { resolveHtmlArtifactSource } from './htmlArtifactFormat.js'
import { prepareOfficeArtifactImages } from './officeArtifactImages.js'
import { buildDocxArtifactBuffer } from './docxArtifactFormat.js'
import {
  buildPdfArtifactBuffer,
  normalizePdfArtifactInput,
} from './pdfArtifactFormat.js'
import { buildPptxArtifactBuffer } from './pptxArtifactFormat.js'
import { buildXlsxArtifactBuffer } from './xlsxArtifactFormat.js'
import { snapshotXlsxSheets } from './xlsxArtifactContract.js'
import { writeGeneratedArtifactAtomically } from './artifactAtomicWriter.js'
import { artifactNameExists } from './artifactLocalPublicationPaths.js'
import {
  ensureArtifactDir,
  hasWindowsReservedDeviceBasename,
  replaceUnsafeFilenameCharacters,
} from './artifactStorage.js'

export {
  MAX_HTML_ARTIFACT_BYTES,
  validateHtmlArtifactSource,
} from './htmlArtifactFormat.js'

export {
  createLocalFileArtifact,
  createLocalFileArtifactAsync,
} from './artifactLocalPublication.js'

const ARTIFACT_FALLBACK_NAMES = Object.freeze({
  pptx: 'presentation',
  docx: 'document',
  xlsx: 'spreadsheet',
  pdf: 'document',
  html: 'webpage',
  png: 'image',
  jpg: 'image',
  webp: 'image',
})

function cleanArtifactTitle(title, ext) {
  const fallback = ARTIFACT_FALLBACK_NAMES[ext] || 'artifact'
  let value = String(title || fallback)
    .normalize('NFKC')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b(?:tool[_ -]?call|create_(?:pptx|docx|xlsx))\b[\s\S]*$/i, ' ')
    .replace(new RegExp(`\\.${ext}$`, 'i'), '')
    .replace(/^(?:请|請|帮我|幫我|请帮我|請幫我|please\s+)?(?:生成|產生|创建|建立|制作|製作|导出|匯出|create|generate|export)(?:一份|一个|一個|a|an)?\s*/i, '')
    .replace(/^(?:基于|基於|根据|根據)(?:已获取的|已取得的|上述|以上)?\s*/i, '')
    .replace(/(?:现在|現在|并|並|然后|然後)?\s*(?:生成|產生|创建|建立|制作|製作|导出|匯出|create|generate|export)(?:一份|一个|一個)?\s*(?:PPTX?|Word|DOCX?|Excel|XLSX?|文档|文件|文檔|檔案|演示文稿|簡報|表格)?\s*$/i, '')
  value = replaceUnsafeFilenameCharacters(value)
    .replace(/[，。；：！？、,;:!]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '')

  value = Array.from(value || fallback).slice(0, 64).join('').replace(/[.\s_-]+$/g, '') || fallback
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = `file-${value}`
  return value
}

export function buildArtifactFilename(title, extension) {
  const ext = String(extension || '').replace(/^\./, '').toLowerCase()
  if (!/^[a-z0-9]{1,12}$/.test(ext)) throw new Error('invalid artifact extension')
  const filename = `${cleanArtifactTitle(title, ext)}.${ext}`
  return hasWindowsReservedDeviceBasename(filename) ? `file-${filename}` : filename
}

function writeNewArtifact(title, ext, contents, encoding = null, previewUserId = null) {
  const id = crypto.randomBytes(8).toString('hex')
  const preferred = buildArtifactFilename(title, ext)
  const { filename, fullPath } = writeGeneratedArtifactAtomically({
    artifactDirectory: ensureArtifactDir(),
    preferredFilename: preferred,
    contents,
    encoding,
    previewUserId,
    filenameExists: artifactNameExists,
  })
  return {
    id,
    filename,
    fullPath,
    url: `/api/artifacts/${encodeURIComponent(filename)}`,
  }
}

export function createImageArtifact({
  title = 'generated-image',
  buffer,
  mimeType = 'image/png',
} = {}) {
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  const bytes = Buffer.from(buffer || [])
  if (!bytes.length) throw new Error('image buffer is empty')
  const artifactPath = writeNewArtifact(title, extension, bytes)
  return {
    ...artifactPath,
    type: 'image',
    title: String(title || 'generated-image').slice(0, 200),
  }
}

export function createHtmlArtifact({ title = 'Webpage', html, files, assetIds = [] } = {}) {
  const source = resolveHtmlArtifactSource({ html, files, assetIds })
  const artifactPath = writeNewArtifact(title, 'html', source, 'utf8')
  return {
    ...artifactPath,
    type: 'html',
    title: String(title || 'Webpage').slice(0, 200),
    byteLength: Buffer.byteLength(source, 'utf8'),
  }
}

export async function createPptx({
  title = 'Presentation',
  subtitle = '',
  theme: themeName,
  brand = 'Gugo',
  slides = [],
  images = [],
  userId = null,
  generatedAt = null,
} = {}) {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('slides 不能为空')
  }
  const officeImages = await prepareOfficeArtifactImages(images, { userId })
  if (officeImages.some((image) => image.targetIndex && image.targetIndex > slides.length)) {
    throw new Error(`image target_index exceeds the ${slides.length}-slide deck`)
  }
  const resolvedGeneratedAt = generatedAt == null ? new Date().toISOString() : generatedAt
  const {
    buffer,
    themeName: resolvedThemeName,
    generatedAt: receiptGeneratedAt,
    fontInjection,
  } = await buildPptxArtifactBuffer({
    title,
    subtitle,
    theme: themeName,
    brand,
    slides,
    preparedImages: officeImages,
    generatedAt: resolvedGeneratedAt,
  })
  const artifactPath = writeNewArtifact(title, 'pptx', buffer, null, userId)
  return {
    ...artifactPath,
    type: 'pptx',
    title,
    slideCount: slides.length,
    imageCount: officeImages.length,
    byteLength: buffer.length,
    themeName: resolvedThemeName,
    generatedAt: receiptGeneratedAt,
    fontInjection,
  }
}

export async function createDocx({
  title = 'Document',
  paragraphs = [],
  images = [],
  userId = null,
} = {}) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) {
    throw new Error('paragraphs 不能为空')
  }
  const officeImages = await prepareOfficeArtifactImages(images, { userId })
  if (officeImages.some((image) => image.targetIndex && image.targetIndex > paragraphs.length)) {
    throw new Error(`image target_index exceeds the ${paragraphs.length}-paragraph document`)
  }
  const buffer = await buildDocxArtifactBuffer({
    title,
    paragraphs,
    preparedImages: officeImages,
  })
  const artifactPath = writeNewArtifact(title, 'docx', buffer)
  return {
    ...artifactPath,
    type: 'docx',
    title,
    paragraphCount: paragraphs.length,
    imageCount: officeImages.length,
    byteLength: buffer.length,
  }
}

export async function createPdf({
  title = 'Document',
  blocks = [],
  images = [],
  userId = null,
} = {}) {
  const pdfInput = normalizePdfArtifactInput({ title, blocks })
  const officeImages = await prepareOfficeArtifactImages(images, { userId })
  const { buffer, pageCount } = await buildPdfArtifactBuffer({
    ...pdfInput,
    preparedImages: officeImages,
  })
  const artifactPath = writeNewArtifact(pdfInput.normalizedTitle, 'pdf', buffer)
  return {
    ...artifactPath,
    type: 'pdf',
    title: pdfInput.normalizedTitle,
    pageCount,
    imageCount: officeImages.length,
    byteLength: buffer.length,
  }
}

export async function createXlsx({
  title = 'Spreadsheet',
  sheets = [],
  images = [],
  userId = null,
} = {}) {
  const validSheets = snapshotXlsxSheets(sheets)
  const officeImages = await prepareOfficeArtifactImages(images, { userId })
  if (officeImages.some((image) => image.targetIndex && image.targetIndex > validSheets.length)) {
    throw new Error(`image target_index exceeds the ${validSheets.length}-sheet workbook`)
  }
  const buffer = await buildXlsxArtifactBuffer({
    sheets: validSheets,
    preparedImages: officeImages,
  })
  const artifactPath = writeNewArtifact(title, 'xlsx', buffer)
  const totalRows = validSheets.reduce((sum, sheet) => sum + sheet.rows.length, 0)
  return {
    ...artifactPath,
    type: 'xlsx',
    title,
    sheetCount: validSheets.length,
    rowCount: totalRows,
    imageCount: officeImages.length,
    byteLength: buffer.length,
  }
}

export {
  getArtifactPreviewRendererStatus,
  handleArtifactDownload,
  renderArtifactPreviewPng,
} from './artifactDelivery.js'
export { getArtifactDir } from './artifactStorage.js'
