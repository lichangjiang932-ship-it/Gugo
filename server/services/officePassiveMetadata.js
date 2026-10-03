import { validateGeneratedArtifactImage } from './generatedArtifactImageValidation.js'

export const PPTX_PRINTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.printerSettings'
export const OFFICE_THUMBNAIL_RELATIONSHIP = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail'
const PRINTER_PART = /^ppt\/printerSettings\/printerSettings[1-9]\d*\.bin$/u
const THUMBNAIL_PART = /^docProps\/thumbnail\.(png|jpe?g)$/u
const PRINTER_RELATIONSHIPS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/printerSettings',
])
const ACTIVE_CONTENT_ERROR = 'ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN'
const MAX_PRINTER_BYTES = 1024 * 1024
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024
const EXECUTABLE_PREFIXES = ['4d5a', '7f454c46', '504b0304', '504b0506', '504b0708',
  'd0cf11e0a1b11ae1', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe']

export function isPptxPassiveMetadataPart(name) {
  return PRINTER_PART.test(name) || THUMBNAIL_PART.test(name)
}

function rejectMetadata(reject, message) {
  reject(ACTIVE_CONTENT_ERROR, message)
}

/**
 * Printer settings are bounded, opaque OS data, not a document or code part.
 * Windows DEVMODE is not their only encoding: normal Mac/Python presentations
 * also carry these settings. Never execute or reinterpret the payload here.
 */
export function validateOfficePassiveMetadataBindings({
  entries, contentTypes, relationshipSets, format, reject,
}) {
  if (format !== 'pptx') return
  const printers = [...entries.keys()].filter(name => PRINTER_PART.test(name))
  const thumbnails = [...entries.keys()].filter(name => THUMBNAIL_PART.test(name))
  for (const [name, type] of contentTypes) {
    if (type === PPTX_PRINTER_CONTENT_TYPE && !PRINTER_PART.test(name)) {
      rejectMetadata(reject, 'Printer metadata content types may only label the exact printer-settings parts.')
    }
  }
  if (printers.length > 1 || thumbnails.length > 1) {
    rejectMetadata(reject, 'A PPTX package may contain at most one printer settings part and one thumbnail.')
  }
  for (const name of printers) {
    const bytes = entries.get(name)
    const prefix = bytes.subarray(0, 8).toString('hex')
    if (contentTypes.get(name) !== PPTX_PRINTER_CONTENT_TYPE
      || bytes.length === 0 || bytes.length > MAX_PRINTER_BYTES
      || EXECUTABLE_PREFIXES.some(signature => prefix.startsWith(signature))) {
      rejectMetadata(reject, `PPTX printer metadata ${name} has an invalid type, size, or executable container.`)
    }
  }
  for (const name of thumbnails) {
    const expectedType = name.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const bytes = entries.get(name)
    if (contentTypes.get(name) !== expectedType || bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES) {
      rejectMetadata(reject, `PPTX thumbnail ${name} has an invalid type or size.`)
    }
  }

  const boundPrinters = new Set()
  const boundThumbnails = new Set()
  for (const [source, relations] of relationshipSets) {
    for (const relation of relations.values()) {
      const printer = PRINTER_RELATIONSHIPS.has(relation.type)
      const thumbnail = relation.type === OFFICE_THUMBNAIL_RELATIONSHIP
      const printerTarget = PRINTER_PART.test(relation.target || '')
      const thumbnailTarget = THUMBNAIL_PART.test(relation.target || '')
      const thumbnailKind = String(relation.type || '').endsWith('/thumbnail')
      if (!printer && !thumbnailKind && !printerTarget && !thumbnailTarget) continue
      const validPrinter = printer && printerTarget && source === 'ppt/_rels/presentation.xml.rels'
      const validThumbnail = thumbnail && thumbnailTarget && source === '_rels/.rels'
      const seen = validPrinter ? boundPrinters : boundThumbnails
      if ((!validPrinter && !validThumbnail) || relation.external || relation.targetMode
        || !entries.has(relation.target) || seen.has(relation.target)) {
        rejectMetadata(reject, `PPTX metadata relationship in ${source} is not a unique internal metadata binding.`)
      }
      seen.add(relation.target)
    }
  }
  if (printers.some(name => !boundPrinters.has(name)) || thumbnails.some(name => !boundThumbnails.has(name))) {
    rejectMetadata(reject, 'PPTX printer settings and thumbnails must have a matching internal metadata relationship.')
  }
}

export async function validateOfficePassiveMetadataImages({ entries, format, reject }) {
  if (format !== 'pptx') return
  for (const [name, bytes] of entries) {
    const match = THUMBNAIL_PART.exec(name)
    if (!match) continue
    try {
      await validateGeneratedArtifactImage(bytes, match[1] === 'jpeg' ? 'jpg' : match[1], {
        maxDimension: 4096, maxPixels: 4096 * 4096,
      })
    } catch (error) {
      if (error?.code === 'ARTIFACT_FORMAT_IMAGE_LIMIT_EXCEEDED') {
        rejectMetadata(reject, 'The PPTX thumbnail dimensions exceed the bounded metadata image size.')
      }
      throw error
    }
  }
}
