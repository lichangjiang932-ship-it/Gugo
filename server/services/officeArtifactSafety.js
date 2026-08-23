const OFFICE_RELATIONSHIP_PREFIXES = Object.freeze([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/',
])
const CORE_PROPERTIES_RELATIONSHIP = (
  'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties'
)
const ACTIVE_CONTENT_ERROR = 'ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN'

const COMMON_CONTENT_TYPES = Object.freeze([
  'application/xml',
  'application/vnd.openxmlformats-package.relationships+xml',
  'application/vnd.openxmlformats-package.core-properties+xml',
  'application/vnd.openxmlformats-officedocument.extended-properties+xml',
])

const SAFE_CONTENT_TYPES = Object.freeze({
  docx: new Set([
    ...COMMON_CONTENT_TYPES,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
    'image/png',
    'image/jpeg',
  ]),
  pptx: new Set([
    ...COMMON_CONTENT_TYPES,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
    'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
    'application/vnd.openxmlformats-officedocument.theme+xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png',
    'image/jpeg',
    'image/jpg',
  ]),
  xlsx: new Set([
    ...COMMON_CONTENT_TYPES,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
    'application/vnd.openxmlformats-officedocument.drawing+xml',
    'application/vnd.openxmlformats-officedocument.theme+xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml',
    'image/png',
    'image/jpeg',
  ]),
})

const SAFE_PART_PATTERNS = Object.freeze({
  docx: Object.freeze([
    /^\[Content_Types\]\.xml$/,
    /^_rels\/\.rels$/,
    /^word\/document\.xml$/,
    /^word\/styles\.xml$/,
    /^word\/_rels\/document\.xml\.rels$/,
    /^word\/media\/image[1-9]\d*\.(?:png|jpe?g)$/,
  ]),
  pptx: Object.freeze([
    /^\[Content_Types\]\.xml$/,
    /^_rels\/\.rels$/,
    /^docProps\/(?:app|core)\.xml$/,
    /^ppt\/presentation\.xml$/,
    /^ppt\/_rels\/presentation\.xml\.rels$/,
    /^ppt\/(?:presProps|tableStyles|viewProps)\.xml$/,
    /^ppt\/theme\/theme[1-9]\d*\.xml$/,
    /^ppt\/slideMasters\/slideMaster[1-9]\d*\.xml$/,
    /^ppt\/slideMasters\/_rels\/slideMaster[1-9]\d*\.xml\.rels$/,
    /^ppt\/slideLayouts\/slideLayout[1-9]\d*\.xml$/,
    /^ppt\/slideLayouts\/_rels\/slideLayout[1-9]\d*\.xml\.rels$/,
    /^ppt\/slides\/slide[1-9]\d*\.xml$/,
    /^ppt\/slides\/_rels\/slide[1-9]\d*\.xml\.rels$/,
    /^ppt\/notesMasters\/notesMaster[1-9]\d*\.xml$/,
    /^ppt\/notesMasters\/_rels\/notesMaster[1-9]\d*\.xml\.rels$/,
    /^ppt\/notesSlides\/notesSlide[1-9]\d*\.xml$/,
    /^ppt\/notesSlides\/_rels\/notesSlide[1-9]\d*\.xml\.rels$/,
    /^ppt\/charts\/chart[1-9]\d*\.xml$/,
    /^ppt\/charts\/_rels\/chart[1-9]\d*\.xml\.rels$/,
    /^ppt\/embeddings\/Microsoft_Excel_Worksheet[1-9]\d*\.xlsx$/,
    /^ppt\/media\/image[1-9]\d*\.(?:png|jpe?g)$/,
  ]),
  xlsx: Object.freeze([
    /^\[Content_Types\]\.xml$/,
    /^_rels\/\.rels$/,
    /^docProps\/(?:app|core)\.xml$/,
    /^xl\/workbook\.xml$/,
    /^xl\/_rels\/workbook\.xml\.rels$/,
    /^xl\/worksheets\/sheet[1-9]\d*\.xml$/,
    /^xl\/worksheets\/_rels\/sheet[1-9]\d*\.xml\.rels$/,
    /^xl\/drawings\/drawing[1-9]\d*\.xml$/,
    /^xl\/drawings\/_rels\/drawing[1-9]\d*\.xml\.rels$/,
    /^xl\/media\/image[1-9]\d*\.(?:png|jpe?g)$/,
    /^xl\/theme\/theme[1-9]\d*\.xml$/,
    /^xl\/styles\.xml$/,
    /^xl\/sharedStrings\.xml$/,
    /^xl\/tables\/table[1-9]\d*\.xml$/,
  ]),
})

const SAFE_RELATIONSHIP_KINDS = Object.freeze({
  docx: new Set(['officeDocument', 'styles', 'image']),
  pptx: new Set([
    'officeDocument',
    'extended-properties',
    'core-properties',
    'slideMaster',
    'slide',
    'notesMaster',
    'presProps',
    'viewProps',
    'theme',
    'tableStyles',
    'slideLayout',
    'notesSlide',
    'image',
    'chart',
    'package',
  ]),
  xlsx: new Set([
    'officeDocument',
    'extended-properties',
    'core-properties',
    'worksheet',
    'drawing',
    'image',
    'theme',
    'styles',
    'sharedStrings',
    'table',
  ]),
})

const FORBIDDEN_XML_LOCALS = Object.freeze({
  docx: new Set([
    'altchunk',
    'attachedtemplate',
    'control',
    'fldsimple',
    'hyperlink',
    'instrtext',
    'object',
    'oleobject',
  ]),
  pptx: new Set([
    'audio',
    'control',
    'custdatalst',
    'hlinkclick',
    'hlinkhover',
    'oleobj',
    'tags',
    'video',
  ]),
  xlsx: new Set([
    'connection',
    'connections',
    'control',
    'controls',
    'ddelink',
    'externallink',
    'externalreference',
    'externalreferences',
    'olelink',
    'oleobject',
    'oleobjects',
    'webpublishitem',
    'webpublishitems',
  ]),
})

function rejectActive(reject, message) {
  reject(ACTIVE_CONTENT_ERROR, message)
}

function relationshipSource(name) {
  if (name === '_rels/.rels') return ''
  const marker = '/_rels/'
  const index = name.indexOf(marker)
  if (index < 0 || !name.endsWith('.rels')) return null
  return `${name.slice(0, index)}/${name.slice(index + marker.length, -5)}`
}

function relationshipKind(type) {
  if (type === CORE_PROPERTIES_RELATIONSHIP) return 'core-properties'
  for (const prefix of OFFICE_RELATIONSHIP_PREFIXES) {
    if (type.startsWith(prefix) && type.length > prefix.length) return type.slice(prefix.length)
  }
  return null
}

function matchesSafePart(name, format) {
  return SAFE_PART_PATTERNS[format].some((pattern) => pattern.test(name))
}

export function assertSafeOfficeEntryNames({ entries, format, reject }) {
  for (const name of entries.keys()) {
    if (name.endsWith('/')) continue
    if (!matchesSafePart(name, format)) {
      rejectActive(reject, `The ${format.toUpperCase()} package contains a forbidden part: ${name}.`)
    }
  }
}

export function assertSafeOfficeContentType({ contentType, format, reject }) {
  const normalized = String(contentType || '').trim()
  if (!SAFE_CONTENT_TYPES[format].has(normalized)) {
    rejectActive(reject, `The ${format.toUpperCase()} package declares a forbidden content type.`)
  }
}

function validateEmbeddedWorkbookRelation({ relName, relation, entries, targets, reject }) {
  const source = relationshipSource(relName)
  const sourceMatch = /^ppt\/charts\/chart([1-9]\d*)\.xml$/.exec(source || '')
  const targetMatch = /^ppt\/embeddings\/Microsoft_Excel_Worksheet([1-9]\d*)\.xlsx$/.exec(
    relation.target || '',
  )
  if (!sourceMatch || !targetMatch || sourceMatch[1] !== targetMatch[1]
    || !entries.has(relation.target) || targets.has(relation.target)) {
    rejectActive(reject, 'A PPTX package relationship is not a bounded chart-data workbook.')
  }
  targets.add(relation.target)
}

function validateChartWorkbookBindings({ documents, relationshipSets, targets, reject }) {
  for (const [name, document] of documents) {
    const chartMatch = /^ppt\/charts\/chart([1-9]\d*)\.xml$/.exec(name)
    if (!chartMatch) continue
    const relationships = relationshipSets.get(
      `ppt/charts/_rels/chart${chartMatch[1]}.xml.rels`,
    )
    const externalData = [...document.getElementsByTagName('*')]
      .filter((element) => String(element.localName || '').toLowerCase() === 'externaldata')
    if (externalData.length !== 1 || relationships?.size !== 1) {
      rejectActive(reject, `PPTX chart part ${name} has an unsafe data binding.`)
    }
    const id = String(externalData[0].getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'id',
    ) || '').trim()
    const relation = relationships.get(id)
    if (!id || !relation || relationshipKind(relation.type) !== 'package'
      || !targets.has(relation.target)) {
      rejectActive(reject, `PPTX chart part ${name} is not bound to validated internal data.`)
    }
  }
}

function validateXmlSafety({ documents, format, reject }) {
  const forbidden = FORBIDDEN_XML_LOCALS[format]
  for (const [name, document] of documents) {
    for (const element of document.getElementsByTagName('*')) {
      const localName = String(element.localName || '').toLowerCase()
      const formula = format === 'xlsx' && (localName === 'f' || localName.endsWith('formula'))
      if (formula || forbidden.has(localName)) {
        rejectActive(
          reject,
          `Office package part ${name} contains forbidden active element ${localName}.`,
        )
      }
    }
  }
}

export function validateOfficeArtifactSafety({
  entries,
  documents,
  contentTypes,
  relationshipSets,
  format,
  reject,
}) {
  assertSafeOfficeEntryNames({ entries, format, reject })
  for (const contentType of contentTypes.values()) {
    assertSafeOfficeContentType({ contentType, format, reject })
  }

  const embeddedWorkbooks = new Set()
  for (const [relName, relationships] of relationshipSets) {
    for (const relation of relationships.values()) {
      const kind = relationshipKind(relation.type)
      if (relation.external || relation.targetMode || !SAFE_RELATIONSHIP_KINDS[format].has(kind)) {
        rejectActive(reject, `Relationship part ${relName} contains a forbidden relationship.`)
      }
      if (kind === 'package') {
        validateEmbeddedWorkbookRelation({
          relName,
          relation,
          entries,
          targets: embeddedWorkbooks,
          reject,
        })
      }
    }
  }

  if (format === 'pptx') {
    for (const name of entries.keys()) {
      if (/^ppt\/embeddings\/.*\.xlsx$/.test(name) && !embeddedWorkbooks.has(name)) {
        rejectActive(reject, `PPTX embedded workbook ${name} is not bound to a chart.`)
      }
    }
    validateChartWorkbookBindings({ documents, relationshipSets, targets: embeddedWorkbooks, reject })
  }
  validateXmlSafety({ documents, format, reject })
  return Object.freeze([...embeddedWorkbooks])
}
