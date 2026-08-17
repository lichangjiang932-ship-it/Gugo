import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import sharp from 'sharp'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-artifact-format-'))
process.env.ARTIFACT_DIR = path.join(root, 'artifacts')
process.env.APP_DATA_DIR = path.join(root, 'data')

const {
  createDocx,
  createImageArtifact,
  createPdf,
  createPptx,
  createXlsx,
} = await import('../server/services/artifactGen.js')
const {
  discardInvalidGeneratedArtifactFile,
  GeneratedArtifactFormatError,
  validateGeneratedArtifactFile,
} = await import('../server/services/generatedArtifactFormatValidation.js')
const { closeDb } = await import('../server/db.js')

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('validates generated DOCX, PPTX, and XLSX package structure', async () => {
  const artifacts = [
    ['create_docx', await createDocx({ title: 'Document', paragraphs: [{ text: 'Body' }] })],
    ['create_pptx', await createPptx({ title: 'Slides', slides: [{ title: 'One', bullets: ['Body'] }] })],
    ['create_xlsx', await createXlsx({ title: 'Workbook', sheets: [{ name: 'Data', rows: [['A', 'B']] }] })],
  ]
  for (const [toolName, artifact] of artifacts) {
    const result = await validateGeneratedArtifactFile({
      filePath: artifact.fullPath,
      filename: artifact.filename,
      artifactType: artifact.type,
      toolName,
    })
    assert.equal(result.ok, true)
    assert.ok(result.entryCount > 0)
  }
})

test('validates generated PDF object streams and a non-empty page tree', async () => {
  const artifact = await createPdf({ title: 'PDF', blocks: [{ type: 'paragraph', text: 'Body' }] })
  const result = await validateGeneratedArtifactFile({
    filePath: artifact.fullPath,
    filename: artifact.filename,
    artifactType: artifact.type,
    toolName: 'create_pdf',
  })
  assert.equal(result.format, 'pdf')
  assert.ok(result.pageCount > 0)
})

test('validates generated PNG, JPEG, and WebP image containers', async () => {
  for (const [extension, mimeType] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const buffer = await sharp({
      create: { width: 3, height: 2, channels: 4, background: '#1f6feb' },
    }).toFormat(extension === 'jpg' ? 'jpeg' : extension).toBuffer()
    const artifact = createImageArtifact({ title: `Image-${extension}`, buffer, mimeType })
    const result = await validateGeneratedArtifactFile({
      filePath: artifact.fullPath,
      filename: artifact.filename,
      artifactType: artifact.type,
      toolName: 'generate_image',
    })
    assert.deepEqual([result.width, result.height], [3, 2])
  }
})

test('rejects disguised, truncated, and structurally incomplete deliverables with retryable machine codes', async () => {
  const disguised = path.join(root, 'disguised.docx')
  fs.writeFileSync(disguised, 'not a zip')
  const pdf = await createPdf({ title: 'Truncated', blocks: [{ type: 'paragraph', text: 'Body' }] })
  const truncatedPdf = path.join(root, 'truncated.pdf')
  fs.writeFileSync(truncatedPdf, fs.readFileSync(pdf.fullPath).subarray(0, 80))
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#fff' },
  }).png().toBuffer()
  const corruptPng = path.join(root, 'corrupt.png')
  png[png.length - 5] ^= 0xff
  fs.writeFileSync(corruptPng, png)

  for (const scenario of [
    { filePath: disguised, toolName: 'create_docx', artifactType: 'docx', code: 'ARTIFACT_FORMAT_ZIP_INVALID' },
    { filePath: truncatedPdf, toolName: 'create_pdf', artifactType: 'pdf', code: 'ARTIFACT_FORMAT_PDF_INVALID' },
    { filePath: corruptPng, toolName: 'generate_image', artifactType: 'image', code: 'ARTIFACT_FORMAT_IMAGE_INVALID' },
  ]) {
    await assert.rejects(
      validateGeneratedArtifactFile({ ...scenario, filename: path.basename(scenario.filePath) }),
      (error) => error instanceof GeneratedArtifactFormatError
        && error.code === scenario.code
        && error.retryable === true
        && error.artifactValidationFailure === true,
    )
  }
})

test('rejects a valid file whose generator, declared type, and extension disagree', async () => {
  const artifact = await createPdf({ title: 'Mismatch', blocks: [{ type: 'paragraph', text: 'Body' }] })
  await assert.rejects(
    validateGeneratedArtifactFile({
      filePath: artifact.fullPath,
      filename: artifact.filename,
      artifactType: 'docx',
      toolName: 'create_pdf',
    }),
    (error) => error?.code === 'ARTIFACT_FORMAT_TYPE_MISMATCH' && error?.retryable === true,
  )
})

async function rewriteOfficeArtifact(artifact, filename, mutate) {
  const zip = await JSZip.loadAsync(fs.readFileSync(artifact.fullPath))
  await mutate(zip)
  const output = path.join(root, filename)
  fs.writeFileSync(output, await zip.generateAsync({ type: 'nodebuffer' }))
  return output
}

function fakePageTreePdf() {
  const chunks = ['%PDF-1.4\n']
  const offsets = [0]
  for (const body of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [] >>',
  ]) {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'))
    chunks.push(`${offsets.length - 1} 0 obj\n${body}\nendobj\n`)
  }
  const xref = Buffer.byteLength(chunks.join(''), 'latin1')
  chunks.push('xref\n0 3\n0000000000 65535 f \n')
  for (const offset of offsets.slice(1)) chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`)
  chunks.push(`trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.from(chunks.join(''), 'latin1')
}

test('rejects image and PDF containers that declare content without decodable pixels or pages', async () => {
  const fakeWebp = Buffer.alloc(30)
  fakeWebp.write('RIFF', 0, 'ascii')
  fakeWebp.writeUInt32LE(22, 4)
  fakeWebp.write('WEBPVP8X', 8, 'ascii')
  fakeWebp.writeUInt32LE(10, 16)
  const webpPath = path.join(root, 'header-only.webp')
  fs.writeFileSync(webpPath, fakeWebp)
  const pdfPath = path.join(root, 'fake-page-tree.pdf')
  fs.writeFileSync(pdfPath, fakePageTreePdf())

  await assert.rejects(
    validateGeneratedArtifactFile({ filePath: webpPath, filename: 'header-only.webp', toolName: 'generate_image', artifactType: 'image' }),
    (error) => error?.code === 'ARTIFACT_FORMAT_IMAGE_INVALID',
  )
  await assert.rejects(
    validateGeneratedArtifactFile({ filePath: pdfPath, filename: 'fake-page-tree.pdf', toolName: 'create_pdf', artifactType: 'pdf' }),
    (error) => error?.code === 'ARTIFACT_FORMAT_PDF_INVALID',
  )
})

test('rejects Office packages with missing content types, broken relationship IDs, or missing worksheet bodies', async () => {
  const docx = await createDocx({ title: 'Document', paragraphs: [{ text: 'Body' }] })
  const invalidDocx = await rewriteOfficeArtifact(docx, 'missing-content-type.docx', async (zip) => {
    const part = zip.file('[Content_Types].xml')
    const xml = await part.async('string')
    zip.file('[Content_Types].xml', xml.replace(/<Override\s+PartName="\/word\/document\.xml"[^>]*\/>/, ''))
  })
  const pptx = await createPptx({ title: 'Slides', slides: [{ title: 'One', bullets: ['Body'] }] })
  const invalidPptx = await rewriteOfficeArtifact(pptx, 'broken-slide-id.pptx', async (zip) => {
    const part = zip.file('ppt/presentation.xml')
    const xml = await part.async('string')
    zip.file('ppt/presentation.xml', xml.replace(/(<p:sldId\b[^>]*\br:id=")[^"]+("[^>]*>)/, '$1missingRelationship$2'))
  })
  const xlsx = await createXlsx({ title: 'Workbook', sheets: [{ name: 'Data', rows: [['A']] }] })
  const invalidXlsx = await rewriteOfficeArtifact(xlsx, 'missing-sheet-data.xlsx', async (zip) => {
    const part = zip.file('xl/worksheets/sheet1.xml')
    const xml = await part.async('string')
    zip.file('xl/worksheets/sheet1.xml', xml.replace(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/, ''))
  })

  for (const [filePath, toolName, artifactType] of [
    [invalidDocx, 'create_docx', 'docx'],
    [invalidPptx, 'create_pptx', 'pptx'],
    [invalidXlsx, 'create_xlsx', 'xlsx'],
  ]) {
    await assert.rejects(
      validateGeneratedArtifactFile({ filePath, filename: path.basename(filePath), toolName, artifactType }),
      (error) => error?.code === 'ARTIFACT_FORMAT_STRUCTURE_INVALID',
    )
  }
})

test('invalid artifact cleanup cannot delete a file outside the managed artifact directory', () => {
  const artifactDirectory = path.join(root, 'cleanup-artifacts')
  fs.mkdirSync(artifactDirectory, { recursive: true })
  const inside = path.join(artifactDirectory, 'inside.bin')
  const outside = path.join(root, 'outside.bin')
  fs.writeFileSync(inside, 'inside')
  fs.writeFileSync(outside, 'outside')

  assert.equal(discardInvalidGeneratedArtifactFile({ filePath: inside, artifactDirectory }), true)
  assert.equal(fs.existsSync(inside), false)
  assert.equal(discardInvalidGeneratedArtifactFile({ filePath: outside, artifactDirectory }), false)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside')
})
