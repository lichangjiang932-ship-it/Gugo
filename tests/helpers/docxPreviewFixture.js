import JSZip from 'jszip'

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

export async function createDocxPreviewFixture({ externalLink = false, externalImage = false, altChunk = false, documentXml = '' } = {}) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`)
  zip.file('_rels/.rels', `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<Relationships xmlns="${PACKAGE_REL_NS}">
    <Relationship Id="styles" Type="${REL_NS}/styles" Target="styles.xml"/>
    <Relationship Id="image1" Type="${REL_NS}/image" Target="${externalImage ? 'https://external.invalid/tracker.png' : 'media/image1.png'}"${externalImage ? ' TargetMode="External"' : ''}/>
    <Relationship Id="header1" Type="${REL_NS}/header" Target="header1.xml"/>
    <Relationship Id="footer1" Type="${REL_NS}/footer" Target="footer1.xml"/>
    ${externalLink ? `<Relationship Id="link1" Type="${REL_NS}/hyperlink" Target="https://external.invalid/private-document" TargetMode="External"/>` : ''}
    ${altChunk ? `<Relationship Id="chunk1" Type="${REL_NS}/aFChunk" Target="chunk.html"/>` : ''}
  </Relationships>`)
  zip.file('word/styles.xml', `<w:styles xmlns:w="${WORD_NS}">
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:styleId="FixtureHeading"><w:name w:val="Fixture Heading"/><w:rPr><w:b/><w:color w:val="204060"/><w:sz w:val="32"/></w:rPr></w:style>
  </w:styles>`)
  zip.file('word/header1.xml', `<w:hdr xmlns:w="${WORD_NS}"><w:p><w:r><w:t>Fixture page header</w:t></w:r></w:p></w:hdr>`)
  zip.file('word/footer1.xml', `<w:ftr xmlns:w="${WORD_NS}"><w:p><w:r><w:t>Fixture page footer</w:t></w:r></w:p></w:ftr>`)
  zip.file('word/media/image1.png', PNG, { base64: true })
  if (altChunk) zip.file('word/chunk.html', '<script>window.DOCX_UNTRUSTED=true</script><p>Active chunk must never run</p>')
  const cell = (text, properties = '') => `<w:tc><w:tcPr>${properties}</w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
  zip.file('word/document.xml', documentXml || `<w:document xmlns:w="${WORD_NS}" xmlns:r="${REL_NS}"
    xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
    <w:p><w:pPr><w:pStyle w:val="FixtureHeading"/></w:pPr><w:r><w:t>Layout fixture heading</w:t></w:r></w:p>
    <w:tbl><w:tblPr><w:tblW w:w="7200" w:type="dxa"/><w:tblBorders>
      ${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="12" w:color="204060"/>`).join('')}
    </w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>
      <w:tr>${cell('Merged heading', '<w:gridSpan w:val="2"/><w:shd w:fill="DDEEFF"/>')}${cell('Column three')}</w:tr>
      <w:tr>${cell('Vertical cell', '<w:vMerge w:val="restart"/>')}${cell('R2C2')}${cell('R2C3')}</w:tr>
      <w:tr>${cell('', '<w:vMerge/>')}${cell('R3C2')}${cell('R3C3')}</w:tr>
    </w:tbl>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Fixture embedded image"/>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
        <pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>
        <pic:blipFill><a:blip r:embed="image1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
        <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
      </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    ${externalLink ? '<w:p><w:hyperlink r:id="link1"><w:r><w:t>Visible external link label</w:t></w:r></w:hyperlink></w:p>' : ''}
    ${altChunk ? '<w:altChunk r:id="chunk1"/>' : ''}
    <w:p><w:r><w:br w:type="page"/></w:r></w:p>
    <w:p><w:r><w:t>Second page paragraph</w:t></w:r></w:p>
    <w:sectPr><w:headerReference w:type="default" r:id="header1"/><w:footerReference w:type="default" r:id="footer1"/>
      <w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/>
    </w:sectPr>
  </w:body></w:document>`)
  return zip.generateAsync({ type: 'uint8array' })
}
