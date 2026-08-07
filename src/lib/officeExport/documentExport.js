import { cleanInlineMarkdown, DOCX_MIME, MAX_DOC_BLOCKS, normalizeText, xmlEscape } from './officeCommon.js'

export function parseMarkdownDocument(markdown) {
  const text = normalizeText(markdown)
  const lines = text.split('\n')
  const blocks = []
  let title = ''
  let paragraph = []

  const flushParagraph = () => {
    const content = cleanInlineMarkdown(paragraph.join(' '))
    paragraph = []
    if (content) blocks.push({ type: 'paragraph', text: content })
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      flushParagraph()
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      const textValue = cleanInlineMarkdown(heading[2])
      if (!title && heading[1].length === 1) {
        title = textValue
        continue
      }
      blocks.push({ type: heading[1].length === 1 ? 'title' : 'heading', text: textValue })
      continue
    }

    if (/^[-*+]\s+/.test(line) || /^\d+[.\u3001]\s+/.test(line)) {
      flushParagraph()
      blocks.push({ type: 'bullet', text: cleanInlineMarkdown(line) })
      continue
    }

    if (/^\|.+\|$/.test(line)) {
      flushParagraph()
      blocks.push({ type: 'paragraph', text: cleanInlineMarkdown(line.replace(/\|/g, ' | ')) })
      continue
    }

    paragraph.push(line)
  }

  flushParagraph()

  if (!title) {
    title = blocks.find((block) => block.text)?.text || '\u6587\u6863'
    if (!blocks.some((block) => block.type === 'title')) {
      blocks.unshift({ type: 'title', text: title })
    }
  }

  return { title, blocks: blocks.slice(0, MAX_DOC_BLOCKS) }
}

function docParagraphXml(block) {
  const text = xmlEscape(block.text)
  const isTitle = block.type === 'title'
  const isHeading = block.type === 'heading'
  const prefix = block.type === 'bullet' ? '\u2022 ' : ''
  const size = isTitle ? 36 : isHeading ? 28 : 22
  const spacingAfter = isTitle ? 360 : isHeading ? 220 : 120
  const bold = isTitle || isHeading
  return `
    <w:p>
      <w:pPr><w:spacing w:after="${spacingAfter}"/></w:pPr>
      <w:r>
        <w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/></w:rPr>
        <w:t xml:space="preserve">${xmlEscape(prefix)}${text}</w:t>
      </w:r>
    </w:p>`
}

function documentXml(blocks) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${blocks.map(docParagraphXml).join('\n')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1200" w:bottom="1440" w:left="1200" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`
}

function docxContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
}

export function packageRels(officeDocumentPath) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${officeDocumentPath}"/>
</Relationships>`
}

export async function zipToBlob(files, mimeType) {
  const module = await import('jszip')
  const JSZip = module.default || module
  const zip = new JSZip()
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content)
  }
  return zip.generateAsync({ type: 'blob', mimeType, compression: 'DEFLATE' })
}

export async function createDocxBlobFromMarkdown(markdown) {
  const doc = parseMarkdownDocument(markdown)
  return zipToBlob(
    {
      '[Content_Types].xml': docxContentTypes(),
      '_rels/.rels': packageRels('word/document.xml'),
      'word/document.xml': documentXml(doc.blocks),
    },
    DOCX_MIME
  )
}
