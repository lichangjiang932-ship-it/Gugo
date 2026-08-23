import JSZip from 'jszip'

import { escapeXml } from '../../src/lib/pptCore.js'
import { officeImageSize } from './officeImageLayout.js'
import { validatePreparedOfficeImages } from './officePreparedImageValidation.js'

function buildParagraphsXml(paragraphs) {
  // 接受 string 或 { heading?: 1|2|3, text }
  const out = []
  for (const paragraph of paragraphs) {
    if (!paragraph) continue
    const isObject = typeof paragraph === 'object'
    const text = escapeXml(isObject ? (paragraph.text || '') : String(paragraph))
    const heading = isObject ? Number(paragraph.heading) || 0 : 0
    if (heading >= 1 && heading <= 3) {
      out.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading${heading}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`,
      )
    } else {
      out.push(`<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    }
  }
  return out.join('')
}

function imageXml(image, index, relationshipId) {
  const size = officeImageSize(image, { defaultWidth: 5.8, maxWidth: 6.5, maxHeight: 8.5 })
  const cx = Math.round(size.width * 914400)
  const cy = Math.round(size.height * 914400)
  const description = escapeXml(image.alt || image.sourceName || `Image ${index + 1}`)
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:docPr id="${index + 1}" name="Image ${index + 1}" descr="${description}"/>
      <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic><pic:nvPicPr><pic:cNvPr id="${index + 1}" name="${description}"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData></a:graphic>
    </wp:inline>
  </w:drawing></w:r></w:p>`
}

function buildBodyXml(paragraphs, images) {
  const parts = []
  const lastTarget = Math.max(1, paragraphs.length)
  paragraphs.forEach((paragraph, paragraphIndex) => {
    parts.push(buildParagraphsXml([paragraph]))
    images.forEach((image, imageIndex) => {
      const target = Math.min(image.targetIndex || lastTarget, lastTarget)
      if (target === paragraphIndex + 1) parts.push(imageXml(image, imageIndex, `rId${imageIndex + 2}`))
    })
  })
  return parts.join('')
}

export async function buildDocxArtifactBuffer({
  title = 'Document',
  paragraphs = [],
  preparedImages = [],
} = {}) {
  const images = validatePreparedOfficeImages(preparedImages, {
    targetCount: Math.max(1, paragraphs.length),
    targetKind: 'paragraph document',
  })
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${images.some((image) => image.extension === 'png') ? '  <Default Extension="png" ContentType="image/png"/>' : ''}
${images.some((image) => image.extension === 'jpg') ? '  <Default Extension="jpg" ContentType="image/jpeg"/>' : ''}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  )
  zip.folder('_rels').file(
    '.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  )
  const word = zip.folder('word')
  word.folder('_rels').file(
    'document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${images.map((image, index) => `  <Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${index + 1}.${image.extension}"/>`).join('\n')}
</Relationships>`,
  )
  const media = word.folder('media')
  images.forEach((image, index) => media.file(`image${index + 1}.${image.extension}`, image.buffer))
  word.file(
    'styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>
      <w:sz w:val="22"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:spacing w:before="280" w:after="140"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:spacing w:before="220" w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
    <w:pPr><w:spacing w:before="180" w:after="100"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`,
  )
  word.file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${buildParagraphsXml([{ heading: 1, text: title }])}
    ${buildBodyXml(paragraphs, images)}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
