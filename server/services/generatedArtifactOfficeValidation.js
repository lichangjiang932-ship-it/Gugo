import path from 'node:path'
import zlib from 'node:zlib'

import { JSDOM } from 'jsdom'

import {
  crc32,
  validateGeneratedArtifactImage,
} from './generatedArtifactImageValidation.js'
import {
  GeneratedArtifactFormatError,
  invalid,
} from './generatedArtifactFormatValidationError.js'
import {
  assertSafeOfficeContentType,
  assertSafeOfficeEntryNames,
  validateOfficeArtifactSafety,
} from './officeArtifactSafety.js'

const MAX_ZIP_ENTRIES = 20_000
const MAX_ZIP_EXPANDED_BYTES = 512 * 1024 * 1024
const MAX_XML_BYTES = 32 * 1024 * 1024
const MAX_OFFICE_EMBEDDED_IMAGE_TOTAL_PIXELS = 160_000_000
const MAX_OFFICE_EMBEDDED_WORKBOOKS = 256
const MAX_OFFICE_EMBEDDED_WORKBOOK_BYTES = 128 * 1024 * 1024

const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types'
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
])
const OFFICE_MAIN_NAMESPACES = Object.freeze({
  docx: new Set([
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main',
  ]),
  pptx: new Set([
    'http://schemas.openxmlformats.org/presentationml/2006/main',
    'http://purl.oclc.org/ooxml/presentationml/main',
  ]),
  xlsx: new Set([
    'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'http://purl.oclc.org/ooxml/spreadsheetml/main',
  ]),
})
const OFFICE_MAIN_CONTENT_TYPE = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
})
const OFFICE_CHILD_CONTENT_TYPE = Object.freeze({
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
})
const OFFICE_DRAWING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml'
const SPREADSHEET_DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  'http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing',
])
const DRAWING_MAIN_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
])
const OFFICE_MAIN_PART = Object.freeze({
  docx: 'word/document.xml',
  pptx: 'ppt/presentation.xml',
  xlsx: 'xl/workbook.xml',
})
const OFFICE_MAIN_ROOT = Object.freeze({ docx: 'document', pptx: 'presentation', xlsx: 'workbook' })

function findZipEocd(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557)
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue
    const commentLength = bytes.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === bytes.length) return offset
  }
  invalid('ARTIFACT_FORMAT_ZIP_INVALID', 'The Office artifact has no valid ZIP end record.')
}

function safeZipName(raw) {
  const name = raw.toString('utf8').replaceAll('\\', '/')
  const normalized = path.posix.normalize(name)
  if (!name || name.includes('\0') || name.startsWith('/') || normalized === '..'
    || normalized.startsWith('../') || normalized !== name.replace(/^\.\//, '')) {
    invalid('ARTIFACT_FORMAT_ZIP_ENTRY_INVALID', 'The Office artifact contains an unsafe ZIP entry path.')
  }
  return normalized
}

function inflateZipEntry(bytes, entry, centralOffset) {
  const offset = entry.localOffset
  if (offset < 0 || offset + 30 > centralOffset || bytes.readUInt32LE(offset) !== 0x04034b50) {
    invalid('ARTIFACT_FORMAT_ZIP_ENTRY_INVALID', `ZIP entry ${entry.name} has an invalid local header.`)
  }
  const flags = bytes.readUInt16LE(offset + 6)
  const method = bytes.readUInt16LE(offset + 8)
  const nameLength = bytes.readUInt16LE(offset + 26)
  const extraLength = bytes.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if ((flags & 1) !== 0 || method !== entry.method || dataEnd > centralOffset) {
    invalid('ARTIFACT_FORMAT_ZIP_ENTRY_INVALID', `ZIP entry ${entry.name} is encrypted, truncated, or inconsistent.`)
  }
  const localName = safeZipName(bytes.subarray(offset + 30, offset + 30 + nameLength))
  if (localName !== entry.name) {
    invalid('ARTIFACT_FORMAT_ZIP_ENTRY_INVALID', `ZIP entry ${entry.name} has inconsistent names.`)
  }
  const compressed = bytes.subarray(dataStart, dataEnd)
  let output
  try {
    output = method === 0
      ? Buffer.from(compressed)
      : method === 8
        ? zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize + 1) })
        : invalid('ARTIFACT_FORMAT_ZIP_COMPRESSION_UNSUPPORTED', `ZIP entry ${entry.name} uses an unsupported compression method.`)
  } catch (cause) {
    if (cause instanceof GeneratedArtifactFormatError) throw cause
    invalid('ARTIFACT_FORMAT_ZIP_ENTRY_INVALID', `ZIP entry ${entry.name} cannot be decompressed.`, cause)
  }
  if (output.length !== entry.uncompressedSize) {
    invalid('ARTIFACT_FORMAT_ZIP_ENTRY_INVALID', `ZIP entry ${entry.name} has an invalid expanded size.`)
  }
  if (crc32(output) !== entry.crc) {
    invalid('ARTIFACT_FORMAT_ZIP_CRC_MISMATCH', `ZIP entry ${entry.name} failed its CRC check.`)
  }
  return output
}

function readOfficeZip(bytes) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) {
    invalid('ARTIFACT_FORMAT_ZIP_INVALID', 'The Office artifact is not a ZIP package.')
  }
  const eocd = findZipEocd(bytes)
  const disk = bytes.readUInt16LE(eocd + 4)
  const centralDisk = bytes.readUInt16LE(eocd + 6)
  const diskEntries = bytes.readUInt16LE(eocd + 8)
  const entryCount = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0
    || entryCount > MAX_ZIP_ENTRIES || entryCount === 0xffff
    || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize !== eocd) {
    invalid('ARTIFACT_FORMAT_ZIP_INVALID', 'The Office ZIP directory is invalid or unsupported.')
  }
  const metadata = []
  const names = new Set()
  let cursor = centralOffset
  let expandedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      invalid('ARTIFACT_FORMAT_ZIP_INVALID', 'The Office ZIP central directory is truncated.')
    }
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const diskStart = bytes.readUInt16LE(cursor + 34)
    const localOffset = bytes.readUInt32LE(cursor + 42)
    const end = cursor + 46 + nameLength + extraLength + commentLength
    if (end > eocd || diskStart !== 0 || (flags & 1) !== 0
      || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      invalid('ARTIFACT_FORMAT_ZIP_ENTRY_INVALID', 'The Office ZIP contains an invalid or unsupported entry.')
    }
    const name = safeZipName(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    const key = name.toLowerCase()
    if (names.has(key)) invalid('ARTIFACT_FORMAT_ZIP_ENTRY_INVALID', `Duplicate ZIP entry: ${name}.`)
    names.add(key)
    expandedBytes += uncompressedSize
    if (expandedBytes > MAX_ZIP_EXPANDED_BYTES) {
      invalid('ARTIFACT_FORMAT_ZIP_BOMB_BLOCKED', 'The Office ZIP expands beyond the validation limit.')
    }
    metadata.push({ name, method, crc, compressedSize, uncompressedSize, localOffset })
    cursor = end
  }
  if (cursor !== eocd) invalid('ARTIFACT_FORMAT_ZIP_INVALID', 'The Office ZIP directory length is inconsistent.')
  const entries = new Map()
  for (const entry of metadata) entries.set(entry.name, inflateZipEntry(bytes, entry, centralOffset))
  return entries
}

let xmlParser = null
function parseXml(bytes, entryName) {
  if (!bytes || bytes.length === 0 || bytes.length > MAX_XML_BYTES) {
    invalid('ARTIFACT_FORMAT_XML_INVALID', `Required XML part ${entryName} is empty or too large.`)
  }
  const source = bytes.toString('utf8')
  if (/<!DOCTYPE/i.test(source)) invalid('ARTIFACT_FORMAT_XML_INVALID', `XML part ${entryName} contains a forbidden doctype.`)
  try {
    if (!xmlParser) xmlParser = new (new JSDOM('').window.DOMParser)()
    const document = xmlParser.parseFromString(source, 'application/xml')
    if (!document?.documentElement || document.getElementsByTagName('parsererror').length > 0) {
      invalid('ARTIFACT_FORMAT_XML_INVALID', `XML part ${entryName} is not well formed.`)
    }
    return document
  } catch (cause) {
    if (cause instanceof GeneratedArtifactFormatError) throw cause
    invalid('ARTIFACT_FORMAT_XML_INVALID', `XML part ${entryName} cannot be parsed.`, cause)
  }
}

function relationshipSource(name) {
  if (name === '_rels/.rels') return ''
  const marker = '/_rels/'
  const index = name.indexOf(marker)
  if (index < 0 || !name.endsWith('.rels')) return null
  return `${name.slice(0, index)}/${name.slice(index + marker.length, -5)}`
}

function relationshipTarget(relName, target) {
  const source = relationshipSource(relName)
  if (source == null) return null
  const raw = String(target || '').split('#', 1)[0].replaceAll('\\', '/')
  const joined = raw.startsWith('/')
    ? path.posix.normalize(raw.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(source), raw))
  if (!joined || joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null
  return joined
}

function directChildren(element, namespace, localName) {
  return [...(element?.children || [])].filter((child) => (
    child.namespaceURI === namespace && child.localName === localName
  ))
}

function validateContentTypes(entries, document, format) {
  const root = document?.documentElement
  if (root?.localName !== 'Types' || root?.namespaceURI !== CONTENT_TYPES_NAMESPACE) {
    invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', 'The Office content-types part is invalid.')
  }
  const defaults = new Map()
  const overrides = new Map()
  for (const node of directChildren(root, CONTENT_TYPES_NAMESPACE, 'Default')) {
    const extension = String(node.getAttribute('Extension') || '').trim().toLowerCase()
    const contentType = String(node.getAttribute('ContentType') || '').trim()
    if (!extension || extension.includes('/') || !contentType || defaults.has(extension)) {
      invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', 'The Office package has invalid default content types.')
    }
    defaults.set(extension, contentType)
  }
  for (const node of directChildren(root, CONTENT_TYPES_NAMESPACE, 'Override')) {
    const rawName = String(node.getAttribute('PartName') || '').trim().replaceAll('\\', '/')
    const contentType = String(node.getAttribute('ContentType') || '').trim()
    const partName = rawName.startsWith('/') ? rawName.slice(1) : ''
    if (!partName || path.posix.normalize(partName) !== partName || !contentType || overrides.has(partName)) {
      invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', 'The Office package has invalid override content types.')
    }
    overrides.set(partName, contentType)
  }
  const contentTypes = new Map()
  for (const name of entries.keys()) {
    if (name === '[Content_Types].xml' || name.endsWith('/')) continue
    const extension = name.endsWith('.rels')
      ? 'rels'
      : path.posix.extname(name).slice(1).toLowerCase()
    const contentType = overrides.get(name) || defaults.get(extension)
    if (!contentType) {
      invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `Office package part ${name} has no declared content type.`)
    }
    contentTypes.set(name, contentType)
  }
  for (const contentType of contentTypes.values()) {
    assertSafeOfficeContentType({ contentType, format, reject: invalid })
  }
  if (contentTypes.get(OFFICE_MAIN_PART[format]) !== OFFICE_MAIN_CONTENT_TYPE[format]) {
    invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `The ${format.toUpperCase()} main content type is invalid.`)
  }
  return contentTypes
}

function validateRelationships(entries, documents) {
  const relationshipSets = new Map()
  for (const [name, document] of documents) {
    if (!name.endsWith('.rels')) continue
    const root = document?.documentElement
    if (root?.localName !== 'Relationships' || root?.namespaceURI !== PACKAGE_RELATIONSHIPS_NAMESPACE) {
      invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `Relationship part ${name} has an invalid namespace.`)
    }
    const source = relationshipSource(name)
    if (source == null || (source && !entries.has(source))) {
      invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `Relationship part ${name} has no valid source part.`)
    }
    const relations = new Map()
    for (const relation of directChildren(root, PACKAGE_RELATIONSHIPS_NAMESPACE, 'Relationship')) {
      const id = String(relation.getAttribute('Id') || '').trim()
      const type = String(relation.getAttribute('Type') || '').trim()
      const targetValue = String(relation.getAttribute('Target') || '').trim()
      const targetMode = String(relation.getAttribute('TargetMode') || '').trim().toLowerCase()
      const external = targetMode === 'external'
      if (!id || !type || !targetValue || relations.has(id)) {
        invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `Relationship part ${name} has an invalid or duplicate relationship.`)
      }
      const target = external ? null : relationshipTarget(name, targetValue)
      if (!external && (!target || !entries.has(target))) {
        invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `Relationship ${name}#${id} points to a missing package part.`)
      }
      relations.set(id, { id, type, target, external, targetMode })
    }
    relationshipSets.set(name, relations)
  }
  return relationshipSets
}

function officeRelationshipAttribute(element, localName) {
  for (const namespace of OFFICE_RELATIONSHIP_NAMESPACES) {
    const id = String(element?.getAttributeNS(namespace, localName) || '').trim()
    if (id) return id
  }
  return ''
}

function officeRelationshipId(element) {
  return officeRelationshipAttribute(element, 'id')
}

function relationshipPartName(sourcePart) {
  const directory = path.posix.dirname(sourcePart)
  return `${directory}/_rels/${path.posix.basename(sourcePart)}.rels`
}

async function validateXlsxDrawingClosure({
  worksheet,
  worksheetName,
  relationshipSets,
  contentTypes,
  documents,
  entries,
  validatedImages,
}) {
  const root = worksheet?.documentElement
  const namespace = root?.namespaceURI
  const drawingNodes = root ? directChildren(root, namespace, 'drawing') : []
  if (drawingNodes.length > 1) {
    invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `XLSX worksheet part ${worksheetName} has multiple drawing bindings.`)
  }
  if (drawingNodes.length === 0) return

  const worksheetRelationships = relationshipSets.get(relationshipPartName(worksheetName))
  const drawingId = officeRelationshipId(drawingNodes[0])
  const drawingRelation = worksheetRelationships?.get(drawingId)
  if (!drawingId || !drawingRelation || drawingRelation.external
    || !drawingRelation.type.endsWith('/drawing') || !drawingRelation.target
    || contentTypes.get(drawingRelation.target) !== OFFICE_DRAWING_CONTENT_TYPE) {
    invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `XLSX worksheet part ${worksheetName} has an invalid drawing relationship.`)
  }

  const drawingName = drawingRelation.target
  const drawing = documents.get(drawingName)
  const drawingRoot = drawing?.documentElement
  if (drawingRoot?.localName !== 'wsDr' || !SPREADSHEET_DRAWING_NAMESPACES.has(drawingRoot?.namespaceURI)) {
    invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `XLSX drawing part ${drawingName} has an invalid root.`)
  }

  const blips = []
  for (const drawingNamespace of DRAWING_MAIN_NAMESPACES) {
    blips.push(...drawing.getElementsByTagNameNS(drawingNamespace, 'blip'))
  }
  if (blips.length === 0) {
    invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `XLSX drawing part ${drawingName} has no embedded image.`)
  }

  const drawingRelationships = relationshipSets.get(relationshipPartName(drawingName))
  if (!drawingRelationships) {
    invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `XLSX drawing part ${drawingName} has no relationship part.`)
  }
  for (const blip of blips) {
    const imageId = officeRelationshipAttribute(blip, 'embed')
    const imageRelation = drawingRelationships.get(imageId)
    if (!imageId || !imageRelation || imageRelation.external
      || !imageRelation.type.endsWith('/image') || !imageRelation.target
      || !String(contentTypes.get(imageRelation.target) || '').startsWith('image/')) {
      invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `XLSX drawing part ${drawingName} has an invalid embedded-image relationship.`)
    }
    if (!validatedImages.targets.has(imageRelation.target)) {
      const extension = path.posix.extname(imageRelation.target).slice(1).toLowerCase()
      if (!['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
        invalid('ARTIFACT_FORMAT_IMAGE_INVALID', `XLSX embedded image ${imageRelation.target} uses an unsupported format.`)
      }
      const details = await validateGeneratedArtifactImage(entries.get(imageRelation.target), extension)
      validatedImages.totalPixels += details.width * details.height * details.pages
      if (validatedImages.totalPixels > MAX_OFFICE_EMBEDDED_IMAGE_TOTAL_PIXELS) {
        invalid('ARTIFACT_FORMAT_IMAGE_INVALID', 'XLSX embedded images exceed the cumulative pixel limit.')
      }
      validatedImages.targets.add(imageRelation.target)
    }
  }
}

async function requireBoundParts({ nodes, relationships, relationSuffix, contentTypes, contentType, documents, validatePart }) {
  if (nodes.length === 0) invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', 'The Office document contains no bound content parts.')
  for (const node of nodes) {
    const id = officeRelationshipId(node)
    const relation = relationships?.get(id)
    if (!id || !relation || relation.external || !relation.type.endsWith(relationSuffix)
      || !relation.target || contentTypes.get(relation.target) !== contentType) {
      invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', 'An Office content node is not bound to the required package part.')
    }
    await validatePart(documents.get(relation.target), relation.target)
  }
}

export async function validateGeneratedArtifactOffice(bytes, format) {
  const entries = readOfficeZip(bytes)
  assertSafeOfficeEntryNames({ entries, format, reject: invalid })
  const required = ['[Content_Types].xml', '_rels/.rels', OFFICE_MAIN_PART[format]]
  for (const name of required) {
    if (!entries.has(name)) invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `The ${format.toUpperCase()} package is missing ${name}.`)
  }
  const documents = new Map()
  for (const [name, content] of entries) {
    if ((name.endsWith('.xml') || name.endsWith('.rels')) && !name.endsWith('/')) {
      documents.set(name, parseXml(content, name))
    }
  }
  const contentTypes = validateContentTypes(entries, documents.get('[Content_Types].xml'), format)
  const relationshipSets = validateRelationships(entries, documents)
  const embeddedWorkbooks = validateOfficeArtifactSafety({
    entries,
    documents,
    contentTypes,
    relationshipSets,
    format,
    reject: invalid,
  })
  const rootRelationships = relationshipSets.get('_rels/.rels')
  const officeRelationship = [...(rootRelationships?.values() || [])]
    .find((item) => item.type.endsWith('/officeDocument'))
  if (officeRelationship?.target !== OFFICE_MAIN_PART[format] || officeRelationship.external) {
    invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `The ${format.toUpperCase()} package has no valid office-document relationship.`)
  }

  const main = documents.get(OFFICE_MAIN_PART[format])
  const mainNamespace = main?.documentElement?.namespaceURI
  if (main?.documentElement?.localName !== OFFICE_MAIN_ROOT[format]
    || !OFFICE_MAIN_NAMESPACES[format].has(mainNamespace)) {
    invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `The ${format.toUpperCase()} main document part is invalid.`)
  }

  if (format === 'docx') {
    const bodies = directChildren(main.documentElement, mainNamespace, 'body')
    const body = bodies.length === 1 ? bodies[0] : null
    const content = body ? [...body.getElementsByTagNameNS(mainNamespace, 'p'), ...body.getElementsByTagNameNS(mainNamespace, 'tbl')] : []
    if (!body || content.length === 0) {
      invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', 'The DOCX document has no paragraph or table body content.')
    }
  } else {
    const mainRelsName = format === 'pptx' ? 'ppt/_rels/presentation.xml.rels' : 'xl/_rels/workbook.xml.rels'
    const mainRelationships = relationshipSets.get(mainRelsName)
    if (!mainRelationships) {
      invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `The ${format.toUpperCase()} main relationships are missing.`)
    }
    if (format === 'pptx') {
      const nodes = [...main.getElementsByTagNameNS(mainNamespace, 'sldId')]
      await requireBoundParts({
        nodes,
        relationships: mainRelationships,
        relationSuffix: '/slide',
        contentTypes,
        contentType: OFFICE_CHILD_CONTENT_TYPE.pptx,
        documents,
        validatePart(document, name) {
          const root = document?.documentElement
          const namespace = root?.namespaceURI
          const commonSlides = root ? directChildren(root, namespace, 'cSld') : []
          const shapeTrees = commonSlides.flatMap((item) => directChildren(item, namespace, 'spTree'))
          if (root?.localName !== 'sld' || !OFFICE_MAIN_NAMESPACES.pptx.has(namespace)
            || commonSlides.length !== 1 || shapeTrees.length !== 1) {
            invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `PPTX slide part ${name} has no valid shape tree.`)
          }
        },
      })
    } else {
      const nodes = [...main.getElementsByTagNameNS(mainNamespace, 'sheet')]
      const validatedImages = { targets: new Set(), totalPixels: 0 }
      await requireBoundParts({
        nodes,
        relationships: mainRelationships,
        relationSuffix: '/worksheet',
        contentTypes,
        contentType: OFFICE_CHILD_CONTENT_TYPE.xlsx,
        documents,
        async validatePart(document, name) {
          const root = document?.documentElement
          const namespace = root?.namespaceURI
          const sheetData = root ? directChildren(root, namespace, 'sheetData') : []
          const rows = sheetData[0] ? [...sheetData[0].getElementsByTagNameNS(namespace, 'row')] : []
          if (root?.localName !== 'worksheet' || !OFFICE_MAIN_NAMESPACES.xlsx.has(namespace)
            || sheetData.length !== 1 || rows.length === 0) {
            invalid('ARTIFACT_FORMAT_STRUCTURE_INVALID', `XLSX worksheet part ${name} has no row data.`)
          }
          await validateXlsxDrawingClosure({
            worksheet: document,
            worksheetName: name,
            relationshipSets,
            contentTypes,
            documents,
            entries,
            validatedImages,
          })
        },
      })
    }
  }
  if (embeddedWorkbooks.length > MAX_OFFICE_EMBEDDED_WORKBOOKS) {
    invalid('ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN', 'The PPTX package has too many embedded chart workbooks.')
  }
  let embeddedWorkbookBytes = 0
  for (const name of embeddedWorkbooks) {
    const workbook = entries.get(name)
    embeddedWorkbookBytes += workbook?.length || 0
    if (embeddedWorkbookBytes > MAX_OFFICE_EMBEDDED_WORKBOOK_BYTES) {
      invalid('ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN', 'The PPTX embedded chart workbooks are too large.')
    }
    await validateGeneratedArtifactOffice(workbook, 'xlsx')
  }
  return { entryCount: entries.size }
}
