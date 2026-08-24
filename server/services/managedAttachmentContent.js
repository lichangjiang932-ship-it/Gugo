import fs from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import {
  getManagedAttachment,
  validateManagedAttachmentsForTurn,
} from './managedAttachmentStore.js'

const MAX_EXTRACTED_CHARS = 256 * 1024
const MAX_EXTRACTION_BYTES = 25 * 1024 * 1024
const MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 2_000
const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_COMPRESSION_RATIO = 200
const MAX_PDF_STREAM_BYTES = 16 * 1024 * 1024
const MAX_PDF_TOTAL_STREAM_BYTES = 32 * 1024 * 1024

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h',
  '.hpp', '.go', '.rs', '.sh', '.ps1', '.sql', '.log', '.ini', '.toml', '.env', '.rtf',
])

function bounded(value, maxChars = MAX_EXTRACTED_CHARS) {
  const text = String(value || '').replaceAll('\0', '').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[附件文本已截断]`
}

function readPrefix(fullPath, maxBytes = MAX_EXTRACTION_BYTES) {
  const stat = fs.statSync(fullPath)
  const size = Math.min(stat.size, maxBytes)
  const buffer = Buffer.alloc(size)
  const descriptor = fs.openSync(fullPath, 'r')
  try {
    fs.readSync(descriptor, buffer, 0, size, 0)
  } finally {
    fs.closeSync(descriptor)
  }
  return { buffer, truncated: stat.size > size }
}

function decodePdfLiteral(value = '') {
  return String(value)
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
}

function decodePdfHex(value = '') {
  const hex = String(value).replace(/\s+/g, '')
  if (!hex || /[^0-9a-f]/i.test(hex)) return ''
  const padded = hex.length % 2 ? `${hex}0` : hex
  const buffer = Buffer.from(padded, 'hex')
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    let result = ''
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      result += String.fromCharCode(buffer.readUInt16BE(index))
    }
    return result
  }
  return buffer.toString('latin1')
}

function collectPdfTextOperators(source, values) {
  const textBlocks = String(source || '').matchAll(/\bBT\b([\s\S]{0,2000000}?)\bET\b/g)
  for (const block of textBlocks) {
    const body = block[1]
    for (const match of body.matchAll(/\(((?:\\[\s\S]|[^\\()]){1,4000})\)\s*(?:Tj|'|")/g)) {
      values.push(decodePdfLiteral(match[1]))
      if (values.length >= 1200) return
    }
    for (const match of body.matchAll(/<([0-9a-fA-F\s]{2,8000})>\s*(?:Tj|'|")/g)) {
      values.push(decodePdfHex(match[1]))
      if (values.length >= 1200) return
    }
    for (const match of body.matchAll(/\[([\s\S]{1,100000}?)\]\s*TJ/g)) {
      const pieces = []
      for (const token of match[1].matchAll(/\(((?:\\[\s\S]|[^\\()]){1,4000})\)|<([0-9a-fA-F\s]{2,8000})>/g)) {
        pieces.push(token[1] != null ? decodePdfLiteral(token[1]) : decodePdfHex(token[2]))
      }
      if (pieces.length) values.push(pieces.join(''))
      if (values.length >= 1200) return
    }
  }
}

function pdfTextSources(buffer) {
  const binary = buffer.toString('latin1')
  const sources = [binary]
  const streamPattern = /\bstream(?:\r\n|\n|\r)/g
  let totalInflatedBytes = 0
  for (const match of binary.matchAll(streamPattern)) {
    const contentStart = match.index + match[0].length
    const contentEnd = binary.indexOf('endstream', contentStart)
    if (contentEnd < 0) break
    const dictionary = binary.slice(Math.max(0, match.index - 4096), match.index)
    if (!/\/FlateDecode\b/.test(dictionary)) continue
    let streamEnd = contentEnd
    while (streamEnd > contentStart && /[\r\n]/.test(binary[streamEnd - 1])) streamEnd -= 1
    try {
      const inflated = inflateSync(buffer.subarray(contentStart, streamEnd), {
        maxOutputLength: Math.min(
          MAX_PDF_STREAM_BYTES,
          MAX_PDF_TOTAL_STREAM_BYTES - totalInflatedBytes,
        ),
      })
      totalInflatedBytes += inflated.length
      sources.push(inflated.toString('latin1'))
      if (totalInflatedBytes >= MAX_PDF_TOTAL_STREAM_BYTES) break
    } catch {
      // Unsupported filter chains and corrupt streams are reported as no_text
      // instead of leaking compressed bytes as if they were readable content.
    }
  }
  return sources
}

export function extractPdfBufferContent(buffer, { maxChars = MAX_EXTRACTED_CHARS } = {}) {
  const values = []
  for (const source of pdfTextSources(buffer)) {
    collectPdfTextOperators(source, values)
    if (values.length >= 1200) break
  }
  const text = bounded(values
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter((value) => value && /[\p{L}\p{N}]/u.test(value))
    .join('\n'), maxChars)
  return {
    text,
    mimeType: 'application/pdf',
    extractionStatus: text ? 'text' : 'no_text',
    requiresVision: !text,
  }
}

export function extractPdfBufferText(buffer, options) {
  return extractPdfBufferContent(buffer, options).text
}

function decodeXmlEntities(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function xmlToText(xml = '') {
  return bounded(decodeXmlEntities(String(xml)
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/(?:w:p|a:p|text:p|table:table-row)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')))
}

function numericPathOrder(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}

function unsafeArchive(message) {
  const error = new Error(message)
  error.statusCode = 422
  error.code = 'ATTACHMENT_ARCHIVE_UNSAFE'
  return error
}

export async function validateOfficeArchiveSafety(buffer, limits = {}) {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  const maxEntries = Math.max(1, Number(limits.maxEntries) || MAX_ARCHIVE_ENTRIES)
  const maxEntryBytes = Math.max(1, Number(limits.maxEntryBytes) || MAX_ARCHIVE_ENTRY_BYTES)
  const maxUncompressedBytes = Math.max(1, Number(limits.maxUncompressedBytes) || MAX_ARCHIVE_UNCOMPRESSED_BYTES)
  const maxCompressionRatio = Math.max(1, Number(limits.maxCompressionRatio) || MAX_ARCHIVE_COMPRESSION_RATIO)
  if (entries.length > maxEntries) throw unsafeArchive('Office 文件包含过多压缩条目')
  let uncompressedBytes = 0
  for (const entry of entries) {
    const size = Number(entry?._data?.uncompressedSize)
    if (!Number.isFinite(size) || size < 0) throw unsafeArchive('Office 文件压缩目录无效')
    if (size > maxEntryBytes) throw unsafeArchive('Office 文件单个压缩条目过大')
    uncompressedBytes += size
    if (uncompressedBytes > maxUncompressedBytes) throw unsafeArchive('Office 文件解压后体积过大')
  }
  const compressedBytes = Math.max(1, Buffer.byteLength(buffer))
  if (uncompressedBytes / compressedBytes > maxCompressionRatio) {
    throw unsafeArchive('Office 文件压缩比异常')
  }
  return zip
}

async function extractOpenXmlText(buffer, extension) {
  const zip = await validateOfficeArchiveSafety(buffer)
  let names
  if (extension === '.docx') names = ['word/document.xml']
  else if (extension === '.pptx') {
    names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort(numericPathOrder)
  } else if (extension === '.xlsx') return ''
  else {
    names = Object.keys(zip.files).filter((name) => /(?:content|document|slide\d+)\.xml$/i.test(name)).sort(numericPathOrder)
  }
  const parts = []
  for (const name of names.slice(0, 500)) {
    const entry = zip.file(name)
    if (!entry) continue
    const text = xmlToText(await entry.async('string'))
    if (text) parts.push(extension === '.pptx' ? `[${path.basename(name, '.xml')}]\n${text}` : text)
    if (parts.join('\n\n').length >= MAX_EXTRACTED_CHARS) break
  }
  return bounded(parts.join('\n\n'))
}

async function extractWorkbookText(buffer) {
  await validateOfficeArchiveSafety(buffer)
  const XLSX = await import('@e965/xlsx')
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const parts = []
  for (const sheetName of workbook.SheetNames.slice(0, 200)) {
    const sheet = workbook.Sheets[sheetName]
    parts.push(`[工作表: ${sheetName}]\n${XLSX.utils.sheet_to_csv(sheet)}`)
    if (parts.join('\n\n').length >= MAX_EXTRACTED_CHARS) break
  }
  return bounded(parts.join('\n\n'))
}

const OFFICE_MIME_TYPES = Object.freeze({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
})

/** Extract bounded text from an in-memory Office file without attachment DB access. */
export async function extractOfficeBufferContent({ buffer, filename = '', maxChars = MAX_EXTRACTED_CHARS } = {}) {
  const extension = path.extname(String(filename || '')).toLowerCase()
  const mimeType = OFFICE_MIME_TYPES[extension] || 'application/octet-stream'
  if (!Buffer.isBuffer(buffer) || !Object.hasOwn(OFFICE_MIME_TYPES, extension)) {
    return {
      text: '',
      mimeType,
      extractionStatus: 'unsupported',
      requiresVision: false,
    }
  }
  try {
    const text = ['.xlsx', '.xlsm', '.ods'].includes(extension)
      ? await extractWorkbookText(buffer)
      : await extractOpenXmlText(buffer, extension)
    return {
      text: bounded(text, maxChars),
      mimeType,
      extractionStatus: text ? 'text' : 'no_text',
      requiresVision: !text && ['.docx', '.pptx', '.odt', '.odp'].includes(extension),
    }
  } catch (error) {
    return {
      text: '',
      mimeType,
      extractionStatus: 'invalid',
      requiresVision: false,
      extractionErrorCode: String(error?.code || 'OFFICE_EXTRACTION_FAILED').slice(0, 120),
    }
  }
}

function isTextAttachment(attachment) {
  return attachment.mimeType.startsWith('text/') ||
    /(?:json|xml|yaml|javascript|typescript|sql|rtf)/i.test(attachment.mimeType) ||
    TEXT_EXTENSIONS.has(path.extname(attachment.name).toLowerCase())
}

export async function extractManagedAttachmentContent({ userId, id, maxChars = MAX_EXTRACTED_CHARS } = {}) {
  const attachment = getManagedAttachment({ userId, id })
  if (!attachment) {
    const error = new Error('附件不存在或无权访问')
    error.statusCode = 404
    error.code = 'ATTACHMENT_NOT_FOUND'
    throw error
  }
  const extension = path.extname(attachment.name).toLowerCase()
  const { buffer, truncated } = readPrefix(attachment.fullPath)
  let text = ''
  let extractionStatus = 'unsupported'
  let requiresVision = false
  if (isTextAttachment(attachment)) {
    text = buffer.toString('utf8')
    extractionStatus = text ? 'text' : 'no_text'
  } else if (attachment.mimeType === 'application/pdf' || extension === '.pdf') {
    const extracted = extractPdfBufferContent(buffer, { maxChars })
    text = extracted.text
    extractionStatus = extracted.extractionStatus
    requiresVision = extracted.requiresVision
  } else if (Object.hasOwn(OFFICE_MIME_TYPES, extension) && !truncated) {
    const extracted = await extractOfficeBufferContent({
      buffer,
      filename: attachment.name,
      maxChars,
    })
    text = extracted.text
    extractionStatus = extracted.extractionStatus
    requiresVision = extracted.requiresVision
  }
  if (text) {
    return {
      text: bounded(text, maxChars),
      mimeType: attachment.mimeType,
      extractionStatus: 'text',
      requiresVision: false,
      truncated,
    }
  }
  if (extractionStatus !== 'unsupported') extractionStatus = 'no_text'
  const sizeNote = truncated ? ' 文件过大，仅检查了前部内容。' : ''
  return {
    text: `[托管附件: ${attachment.name}，类型 ${attachment.mimeType}，大小 ${attachment.size} 字节。${sizeNote}未提取到可读文本，可用 ${attachment.uri} 继续读取或处理。]`,
    mimeType: attachment.mimeType,
    extractionStatus,
    requiresVision,
    truncated,
  }
}

export async function extractManagedAttachmentText(options = {}) {
  return (await extractManagedAttachmentContent(options)).text
}

function metadataLine(attachment) {
  const name = String(attachment.name || '').replace(/["\\\r\n]/g, '_')
  return `[GUGO_MANAGED_ATTACHMENT id="${attachment.id}" uri="${attachment.uri}" name="${name}" mime="${attachment.mimeType}" size=${attachment.size} sha256="${attachment.sha256}"]`
}

function projectedTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let ascii = 0
  let nonAscii = 0
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4) + nonAscii
}

function normalizeAttachmentTokenBudget(value) {
  if (value === undefined || value === null) return Number.POSITIVE_INFINITY
  const budget = Number(value)
  return Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : Number.POSITIVE_INFINITY
}

function inlineMediaTokenProjection(attachment, metadata) {
  // Base64 expands bytes by 4/3 and the shared context estimator prices ASCII
  // at four characters per token. This projection lets large media fall back
  // before allocating a multi-megabyte data URL; the final provider projection
  // is still measured authoritatively by TurnEngine.
  return projectedTokens({ type: 'text', text: metadata })
    + Math.ceil(Math.max(0, Number(attachment.size) || 0) / 3)
    + 64
}

function attachmentBudgetNote(attachment, truncated = true) {
  return truncated
    ? `[附件内容已按当前上下文预算截断。需要更多内容时请通过 ${attachment.uri} 分页读取。]`
    : `[附件未内联：展开内容超出当前上下文预算。需要时请通过 ${attachment.uri} 读取。]`
}

function fitAttachmentText(metadata, body, attachment, maxTokens) {
  const text = String(body || '')
  const full = [metadata, text].filter(Boolean).join('\n')
  if (!Number.isFinite(maxTokens) || projectedTokens({ type: 'text', text: full }) <= maxTokens) {
    return full
  }

  const note = attachmentBudgetNote(attachment, true)
  const minimum = `${metadata}\n${note}`
  if (!text || projectedTokens({ type: 'text', text: minimum }) > maxTokens) {
    return metadata
  }

  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${metadata}\n${text.slice(0, middle)}\n${note}`
    if (projectedTokens({ type: 'text', text: candidate }) <= maxTokens) low = middle
    else high = middle - 1
  }
  return `${metadata}\n${text.slice(0, low)}\n${note}`
}

function extractionCharLimit(remainingTokens) {
  if (!Number.isFinite(remainingTokens)) return MAX_EXTRACTED_CHARS
  return Math.min(MAX_EXTRACTED_CHARS, Math.max(1_024, remainingTokens * 4))
}

export async function prepareManagedAttachmentsForModel({
  userId,
  sessionId,
  attachmentIds,
  text = '',
  maxAttachmentTokens,
} = {}) {
  const attachments = validateManagedAttachmentsForTurn({ userId, sessionId, attachmentIds })
  if (!attachments.length) return { attachments: [], content: String(text || '') }
  const content = [{ type: 'text', text: String(text || '请分析附件内容。') }]
  let remainingTokens = normalizeAttachmentTokenBudget(maxAttachmentTokens)
  const pushTextFallback = (attachment, metadata, body = '', truncated = true) => {
    const fallbackBody = body || attachmentBudgetNote(attachment, truncated)
    const fitted = fitAttachmentText(metadata, fallbackBody, attachment, remainingTokens)
    const part = { type: 'text', text: fitted }
    content.push(part)
    if (Number.isFinite(remainingTokens)) {
      remainingTokens = Math.max(0, remainingTokens - projectedTokens(part))
    }
  }
  for (const item of attachments) {
    const attachment = getManagedAttachment({ userId, id: item.id })
    const metadata = metadataLine(attachment)
    if (attachment.mimeType.startsWith('image/')) {
      if (
        attachment.size > MAX_INLINE_MEDIA_BYTES
        || inlineMediaTokenProjection(attachment, metadata) > remainingTokens
      ) {
        pushTextFallback(attachment, metadata, '', false)
        continue
      }
      const data = fs.readFileSync(attachment.fullPath).toString('base64')
      const metadataPart = { type: 'text', text: metadata }
      const imagePart = { type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${data}` } }
      const inlineTokens = projectedTokens(metadataPart) + projectedTokens(imagePart)
      if (inlineTokens > remainingTokens) {
        pushTextFallback(attachment, metadata, '', false)
        continue
      }
      content.push(metadataPart, imagePart)
      if (Number.isFinite(remainingTokens)) remainingTokens -= inlineTokens
      continue
    }
    const extracted = remainingTokens > 0
      ? await extractManagedAttachmentText({
          userId,
          id: attachment.id,
          maxChars: extractionCharLimit(remainingTokens),
        })
      : ''
    const fallbackText = `${metadata}\n${extracted}`
    if (attachment.mimeType === 'application/pdf' && attachment.size <= MAX_INLINE_MEDIA_BYTES) {
      if (inlineMediaTokenProjection(attachment, metadata) <= remainingTokens) {
        const data = fs.readFileSync(attachment.fullPath).toString('base64')
        const pdfPart = {
          type: 'yma_pdf',
          filename: attachment.name,
          file_data: `data:application/pdf;base64,${data}`,
          fallback_text: fallbackText,
        }
        const inlineTokens = projectedTokens(pdfPart)
        if (inlineTokens <= remainingTokens) {
          content.push(pdfPart)
          if (Number.isFinite(remainingTokens)) remainingTokens -= inlineTokens
          continue
        }
      }
    }
    pushTextFallback(attachment, metadata, extracted, !!extracted)
  }
  return { attachments, content }
}

export const MANAGED_ATTACHMENT_CONTENT_LIMITS = Object.freeze({
  maxExtractedChars: MAX_EXTRACTED_CHARS,
  maxExtractionBytes: MAX_EXTRACTION_BYTES,
  maxInlineMediaBytes: MAX_INLINE_MEDIA_BYTES,
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
  maxArchiveEntryBytes: MAX_ARCHIVE_ENTRY_BYTES,
  maxArchiveUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  maxArchiveCompressionRatio: MAX_ARCHIVE_COMPRESSION_RATIO,
})
