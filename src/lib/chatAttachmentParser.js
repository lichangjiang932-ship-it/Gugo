import { compressImageDataUrl } from './imageCompress.js'
import { extractPdfText } from './pdfExtract.js'
import { extractDocxText, extractPptxText, isDocxFile, isPptxFile } from './officeExtract.js'
import {
  clampTextToBytes,
  dataUrlByteLength,
  isExcelFile,
  isPdfFile,
  isTextLikeFile,
  readExcelAsText,
  readFileAsDataUrl,
} from './chatAttachmentFiles.js'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_RAW_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 5

const DEFAULT_MESSAGES = {
  imageLimit: 'Image limit reached; only 5 images can be sent in one message.',
  imageTooLarge: 'Image is too large to process locally.',
  compressedTooLarge: 'Compressed image is still over 4MB.',
  excelTooLong: 'Excel content too long',
  wordTooLong: 'Word content too long',
  pptTooLong: 'Presentation content too long',
  textTooLong: 'Text content too long',
  unsupportedFormat: 'This format cannot be read locally; only the file name and metadata will be sent.',
  readFailed: 'Could not read file',
}

function attachmentBase(file) {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${file.name}`,
    name: file.name,
    sizeKB: (file.size / 1024).toFixed(1),
    type: file.type,
  }
}

export async function parseChatAttachments(files, options = {}) {
  const messages = { ...DEFAULT_MESSAGES, ...(options.messages || {}) }
  const attachments = []
  let imageCount = Math.max(0, Number(options.existingImageCount) || 0)

  for (const file of Array.from(files || [])) {
    const base = attachmentBase(file)
    try {
      if (file.type.startsWith('image/')) {
        if (imageCount >= MAX_IMAGES_PER_MESSAGE) {
          attachments.push({ ...base, kind: 'file', error: messages.imageLimit })
        } else if (file.size > MAX_RAW_IMAGE_BYTES) {
          attachments.push({ ...base, kind: 'file', error: messages.imageTooLarge })
        } else {
          const dataUrl = await compressImageDataUrl(await readFileAsDataUrl(file))
          if (dataUrlByteLength(dataUrl) > MAX_IMAGE_BYTES) {
            attachments.push({ ...base, kind: 'file', error: messages.compressedTooLarge })
          } else {
            imageCount += 1
            attachments.push({ ...base, kind: 'image', dataUrl })
          }
        }
      } else if (isExcelFile(file)) {
        attachments.push({ ...base, kind: 'text', text: clampTextToBytes(await readExcelAsText(file), messages.excelTooLong) })
      } else if (isPdfFile(file)) {
        const [dataUrl, text] = await Promise.all([
          readFileAsDataUrl(file),
          extractPdfText(file),
        ])
        attachments.push({ ...base, kind: 'pdf', dataUrl, text })
      } else if (isDocxFile(file)) {
        attachments.push({ ...base, kind: 'text', text: clampTextToBytes(await extractDocxText(file), messages.wordTooLong) })
      } else if (isPptxFile(file)) {
        attachments.push({ ...base, kind: 'text', text: clampTextToBytes(await extractPptxText(file), messages.pptTooLong) })
      } else if (isTextLikeFile(file)) {
        attachments.push({ ...base, kind: 'text', text: clampTextToBytes(await file.text(), messages.textTooLong) })
      } else {
        attachments.push({ ...base, kind: 'file', error: messages.unsupportedFormat })
      }
    } catch (error) {
      attachments.push({ ...base, kind: 'file', error: error.message || messages.readFailed })
    }
  }

  return attachments
}
