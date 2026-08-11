import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib'

import { PDF_TOOL_SPECS, dispatchPdfTool } from '../server/adapters/pdfTools.js'

let workspace
const savedEnv = {
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
  PDF_TOOL_MAX_INPUT_BYTES: process.env.PDF_TOOL_MAX_INPUT_BYTES,
  PDF_TOOL_MAX_OUTPUT_BYTES: process.env.PDF_TOOL_MAX_OUTPUT_BYTES,
  PDF_MAX_INPUT_BYTES: process.env.PDF_MAX_INPUT_BYTES,
  PDF_MAX_OUTPUT_BYTES: process.env.PDF_MAX_OUTPUT_BYTES,
  PDF_TEXT_MAX_PAGES: process.env.PDF_TEXT_MAX_PAGES,
  PDF_TEXT_MAX_CHARACTERS: process.env.PDF_TEXT_MAX_CHARACTERS,
  PDF_TEXT_MAX_ITEMS: process.env.PDF_TEXT_MAX_ITEMS,
}

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-tools-'))
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_FS_ENABLED = '1'
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
})

beforeEach(() => {
  process.env.WORKSPACE_FS_ENABLED = '1'
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
  delete process.env.PDF_TOOL_MAX_INPUT_BYTES
  delete process.env.PDF_TOOL_MAX_OUTPUT_BYTES
  delete process.env.PDF_MAX_INPUT_BYTES
  delete process.env.PDF_MAX_OUTPUT_BYTES
  delete process.env.PDF_TEXT_MAX_PAGES
  delete process.env.PDF_TEXT_MAX_CHARACTERS
  delete process.env.PDF_TEXT_MAX_ITEMS
})

after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* best effort */ }
})

async function createPdf(relativePath, pageCount, { title = relativePath } = {}) {
  const document = await PDFDocument.create()
  document.setTitle(title)
  document.setAuthor('Gugo PDF tools test')
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([300 + index, 420 + index])
    page.drawText(`Page ${index + 1} of ${title}`, { x: 30, y: 360, size: 14, font })
  }
  const bytes = await document.save({ useObjectStreams: true })
  fs.writeFileSync(path.join(workspace, relativePath), bytes)
  return bytes
}

async function loadOutput(relativePath) {
  return PDFDocument.load(fs.readFileSync(path.join(workspace, relativePath)), { updateMetadata: false })
}

async function createFormPdf(relativePath) {
  const document = await PDFDocument.create()
  const page = document.addPage([400, 500])
  const form = document.getForm()
  const name = form.createTextField('person.name')
  name.addToPage(page, { x: 40, y: 400, width: 220, height: 28 })
  const accepted = form.createCheckBox('terms.accepted')
  accepted.addToPage(page, { x: 40, y: 350, width: 20, height: 20 })
  fs.writeFileSync(path.join(workspace, relativePath), await document.save())
}

async function createChinesePdf(relativePath, text = '中文坐标测试') {
  const document = await PDFDocument.create()
  document.addPage([400, 500])
  const sourcePath = `${relativePath}.source.pdf`
  fs.writeFileSync(path.join(workspace, sourcePath), await document.save({ useObjectStreams: true }))
  await dispatchPdfTool('pdf_transform', {
    operation: 'overlay_text',
    input: sourcePath,
    output: relativePath,
    patches: [{
      page: 1,
      x: 40,
      y: 285,
      width: 220,
      height: 35,
      text,
      fontSize: 18,
      padding: 0,
      cover: false,
    }],
  })
}

test('exports complete PDF tool specs and rejects unknown tools', async () => {
  assert.deepEqual(PDF_TOOL_SPECS.map((spec) => spec.function.name), ['pdf_info', 'pdf_text', 'pdf_transform'])
  const text = PDF_TOOL_SPECS.find((spec) => spec.function.name === 'pdf_text')
  assert.match(text.function.description, /bottom-left origin/)
  assert.match(text.function.description, /Does not OCR/)
  const transform = PDF_TOOL_SPECS.find((spec) => spec.function.name === 'pdf_transform')
  assert.match(transform.function.description, /Unicode\/Chinese/)
  assert.deepEqual(transform.function.parameters.properties.operation.enum, [
    'merge', 'split', 'rotate', 'watermark', 'overlay_text', 'fill_form',
  ])
  await assert.rejects(
    () => dispatchPdfTool('pdf_missing', {}),
    (error) => error?.code === 'PDF_TOOL_NOT_FOUND' && error?.statusCode === 404,
  )
})

test('pdf_info reports real page geometry, metadata, and form limitations', async () => {
  await createPdf('info.pdf', 3, { title: 'Three pages' })
  const result = await dispatchPdfTool('pdf_info', { path: 'info.pdf' })

  assert.equal(result.ok, true)
  assert.equal(result.encrypted, false)
  assert.equal(result.pageCount, 3)
  assert.equal(result.metadata.title, 'Three pages')
  assert.deepEqual(result.pages.map((page) => page.page), [1, 2, 3])
  assert.equal(result.pages[0].width, 300)
  assert.deepEqual(result.form.fields, [])
})

test('pdf_text extracts Chinese text and bottom-left PDF point coordinates', async () => {
  await createChinesePdf('text-chinese.pdf', '中文坐标测试')
  const result = await dispatchPdfTool('pdf_text', { path: 'text-chinese.pdf' })

  assert.equal(result.ok, true)
  assert.equal(result.pageCount, 1)
  assert.match(result.pages[0].text, /中文坐标测试/)
  const item = result.pages[0].items.find((entry) => entry.text.includes('中文'))
  assert.ok(item)
  assert.ok(item.x >= 39 && item.x <= 41, `unexpected x: ${item.x}`)
  assert.ok(item.y < 300 && item.y > 270, `unexpected y: ${item.y}`)
  assert.ok(item.width > 50)
  assert.ok(item.height > 10)
  assert.match(result.coordinateSystem, /bottom-left origin/)
  assert.match(result.limitations.join(' '), /OCR/)
})

test('pdf_text keeps rotated pages and item bounds in overlay_text user space', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([300, 400])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('EDGE', { x: 40, y: 350, size: 12, font })
  page.setRotation(degrees(90))
  fs.writeFileSync(path.join(workspace, 'text-rotated.pdf'), await document.save())

  const extracted = await dispatchPdfTool('pdf_text', { path: 'text-rotated.pdf' })
  const extractedPage = extracted.pages[0]
  const item = extractedPage.items.find((entry) => entry.text === 'EDGE')
  assert.equal(extractedPage.width, 300)
  assert.equal(extractedPage.height, 400)
  assert.equal(extractedPage.rotation, 90)
  assert.ok(item)
  assert.ok(item.y > 300, `expected raw user-space y coordinate, got ${item.y}`)
  assert.ok(item.x + item.width <= extractedPage.width)
  assert.ok(item.y + item.height <= extractedPage.height)

  const transformed = await dispatchPdfTool('pdf_transform', {
    operation: 'overlay_text',
    input: 'text-rotated.pdf',
    output: 'text-rotated-overlay.pdf',
    patches: [{
      page: 1,
      x: item.x,
      y: item.y,
      width: item.width + 10,
      height: item.height + 6,
      text: 'R90',
      fontSize: 10,
      padding: 1,
    }],
  })
  assert.deepEqual(transformed.changedPaths, ['text-rotated-overlay.pdf'])
  const reread = await dispatchPdfTool('pdf_text', { path: transformed.path })
  assert.match(reread.pages[0].text, /R90/)
})

test('pdf_text supports page selection and enforces page, character, and item limits', async () => {
  await createPdf('text-limits.pdf', 2)
  process.env.PDF_TEXT_MAX_PAGES = '1'
  await assert.rejects(
    () => dispatchPdfTool('pdf_text', { path: 'text-limits.pdf' }),
    (error) => error?.code === 'PDF_TEXT_PAGE_LIMIT_EXCEEDED' && error?.maxPages === 1,
  )

  const selected = await dispatchPdfTool('pdf_text', {
    path: 'text-limits.pdf',
    pages: [2],
    includeItems: false,
  })
  assert.deepEqual(selected.pages.map((page) => page.page), [2])
  assert.equal(Object.hasOwn(selected.pages[0], 'items'), false)

  delete process.env.PDF_TEXT_MAX_PAGES
  process.env.PDF_TEXT_MAX_CHARACTERS = '3'
  await assert.rejects(
    () => dispatchPdfTool('pdf_text', { path: 'text-limits.pdf', pages: [1] }),
    (error) => error?.code === 'PDF_TEXT_CHARACTER_LIMIT_EXCEEDED' && error?.maxCharacters === 3,
  )

  delete process.env.PDF_TEXT_MAX_CHARACTERS
  process.env.PDF_TEXT_MAX_ITEMS = '1'
  const document = await loadOutput('text-limits.pdf')
  const font = await document.embedFont(StandardFonts.Helvetica)
  document.getPage(0).drawText('second item', { x: 30, y: 320, size: 12, font })
  fs.writeFileSync(path.join(workspace, 'text-limits.pdf'), await document.save())
  await assert.rejects(
    () => dispatchPdfTool('pdf_text', { path: 'text-limits.pdf', pages: [1] }),
    (error) => error?.code === 'PDF_TEXT_ITEM_LIMIT_EXCEEDED' && error?.maxItems === 1,
  )
})

test('merge combines real PDFs in input order into a multi-page output', async () => {
  await createPdf('merge-a.pdf', 2)
  await createPdf('merge-b.pdf', 3)

  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'merge',
    inputs: ['merge-a.pdf', 'merge-b.pdf'],
    output: 'merged/output.pdf',
  })

  assert.equal(result.ok, true)
  assert.equal(result.operation, 'merge')
  assert.equal(result.outputs[0].pageCount, 5)
  const output = await loadOutput('merged/output.pdf')
  assert.equal(output.getPageCount(), 5)
  assert.equal(output.getPage(0).getWidth(), 300)
  assert.equal(output.getPage(2).getWidth(), 300)
})

test('split supports pages and ranges with multiple independently atomic outputs', async () => {
  await createPdf('split-source.pdf', 6)

  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'split',
    input: 'split-source.pdf',
    outputs: [
      { path: 'split/first.pdf', ranges: ['1-3'] },
      { path: 'split/second.pdf', pages: [6, 4], ranges: [{ start: 2, end: 2 }] },
    ],
  })

  assert.deepEqual(result.outputs.map((output) => output.pages), [[1, 2, 3], [6, 4, 2]])
  assert.equal((await loadOutput('split/first.pdf')).getPageCount(), 3)
  const second = await loadOutput('split/second.pdf')
  assert.equal(second.getPageCount(), 3)
  assert.equal(second.getPage(0).getWidth(), 305)
  assert.equal(second.getPage(1).getWidth(), 303)
  assert.equal(second.getPage(2).getWidth(), 301)
})

test('rotate applies relative right-angle rotation only to selected pages', async () => {
  await createPdf('rotate-source.pdf', 3)
  const source = await loadOutput('rotate-source.pdf')
  source.getPage(1).setRotation(degrees(90))
  fs.writeFileSync(path.join(workspace, 'rotate-source.pdf'), await source.save())

  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'rotate',
    input: 'rotate-source.pdf',
    output: 'rotated.pdf',
    pages: [2, 3],
    degrees: 90,
  })

  assert.deepEqual(result.pages, [2, 3])
  const output = await loadOutput('rotated.pdf')
  assert.deepEqual(output.getPages().map((page) => page.getRotation().angle), [0, 180, 90])
})

test('rotate preserves an interactive AcroForm', async () => {
  await createFormPdf('rotate-form-source.pdf')
  await dispatchPdfTool('pdf_transform', {
    operation: 'rotate',
    input: 'rotate-form-source.pdf',
    output: 'rotate-form-output.pdf',
    degrees: 90,
  })

  const output = await loadOutput('rotate-form-output.pdf')
  assert.deepEqual(output.getForm().getFields().map((field) => field.getName()), [
    'person.name',
    'terms.accepted',
  ])
})

test('watermark writes selected real PDF pages without changing page count', async () => {
  await createPdf('watermark-source.pdf', 4)
  const before = await loadOutput('watermark-source.pdf')
  const beforeContents = before.getPage(1).node.Contents()

  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'watermark',
    input: 'watermark-source.pdf',
    output: 'watermarked.pdf',
    ranges: ['2-3'],
    text: 'CONFIDENTIAL',
    opacity: 0.35,
    fontSize: 28,
    rotation: 30,
  })

  assert.deepEqual(result.pages, [2, 3])
  const output = await loadOutput('watermarked.pdf')
  assert.equal(output.getPageCount(), 4)
  assert.notEqual(output.getPage(1).node.Contents()?.toString(), beforeContents?.toString())
})

test('watermark embeds and exposes Chinese Unicode text', async () => {
  await createPdf('watermark-chinese-source.pdf', 1)
  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'watermark',
    input: 'watermark-chinese-source.pdf',
    output: 'watermark-chinese-output.pdf',
    text: '机密文件',
    fontSize: 28,
  })

  assert.equal(result.path, 'watermark-chinese-output.pdf')
  assert.equal(result.scope, 'workspace')
  assert.deepEqual(result.changedPaths, ['watermark-chinese-output.pdf'])
  const extracted = await dispatchPdfTool('pdf_text', { path: 'watermark-chinese-output.pdf' })
  assert.match(extracted.pages[0].text, /机密文件/)
  const item = extracted.pages[0].items.find(({ text }) => text.includes('机密文件'))
  assert.ok(item)
  assert.ok(item.x >= 0 && item.y >= 0)
  assert.ok(item.x + item.width <= extracted.pages[0].width)
  assert.ok(item.y + item.height <= extracted.pages[0].height)
  assert.ok(Math.abs((item.x + (item.width / 2)) - (extracted.pages[0].width / 2)) < 1)
  assert.ok(Math.abs((item.y + (item.height / 2)) - (extracted.pages[0].height / 2)) < 1)
})

test('watermark keeps a 90-degree Unicode text box centered on the page', async () => {
  await createPdf('watermark-vertical-source.pdf', 1)
  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'watermark',
    input: 'watermark-vertical-source.pdf',
    output: 'watermark-vertical-output.pdf',
    text: '中文水印',
    fontSize: 28,
    rotation: 90,
  })

  assert.deepEqual(result.changedPaths, ['watermark-vertical-output.pdf'])
  const extracted = await dispatchPdfTool('pdf_text', { path: result.path })
  const item = extracted.pages[0].items.find(({ text }) => text.includes('中文水印'))
  assert.ok(item)
  assert.ok(item.x >= 0 && item.y >= 0)
  assert.ok(item.x + item.width <= extracted.pages[0].width)
  assert.ok(item.y + item.height <= extracted.pages[0].height)
  assert.ok(Math.abs((item.x + (item.width / 2)) - (extracted.pages[0].width / 2)) < 1)
  assert.ok(Math.abs((item.y + (item.height / 2)) - (extracted.pages[0].height / 2)) < 1)
})

test('overlay_text covers and redraws bounded one-line text on selected pages', async () => {
  await createPdf('overlay-source.pdf', 2)
  const before = await loadOutput('overlay-source.pdf')
  const beforeContents = before.getPage(0).node.Contents()

  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'overlay_text',
    input: 'overlay-source.pdf',
    output: 'overlay-output.pdf',
    patches: [{
      page: 1,
      x: 25,
      y: 345,
      width: 240,
      height: 32,
      text: 'Corrected heading',
      fontSize: 14,
      color: '#113355',
      backgroundColor: '#FFFFFF',
    }],
  })

  assert.equal(result.operation, 'overlay_text')
  assert.deepEqual(result.outputs[0].pages, [1])
  const output = await loadOutput('overlay-output.pdf')
  assert.equal(output.getPageCount(), 2)
  assert.notEqual(output.getPage(0).node.Contents()?.toString(), beforeContents?.toString())
})

test('overlay_text embeds Chinese Unicode replacement text', async () => {
  await createPdf('overlay-chinese-source.pdf', 1)
  await dispatchPdfTool('pdf_transform', {
    operation: 'overlay_text',
    input: 'overlay-chinese-source.pdf',
    output: 'overlay-chinese-output.pdf',
    patches: [{
      page: 1,
      x: 25,
      y: 335,
      width: 250,
      height: 42,
      text: '修正后的中文标题',
      fontSize: 16,
    }],
  })

  const extracted = await dispatchPdfTool('pdf_text', { path: 'overlay-chinese-output.pdf' })
  assert.match(extracted.pages[0].text, /修正后的中文标题/)
})

test('overlay_text rejects out-of-bounds and overflowing patches before publication', async () => {
  await createPdf('overlay-invalid-source.pdf', 1)
  await assert.rejects(
    () => dispatchPdfTool('pdf_transform', {
      operation: 'overlay_text',
      input: 'overlay-invalid-source.pdf',
      output: 'overlay-invalid-output.pdf',
      patches: [{ page: 1, x: 290, y: 20, width: 30, height: 20, text: 'outside' }],
    }),
    (error) => error?.code === 'PDF_TEXT_PATCH_OUT_OF_BOUNDS',
  )
  assert.equal(fs.existsSync(path.join(workspace, 'overlay-invalid-output.pdf')), false)
})

test('fill_form preserves interactive fields by default and updates real values', async () => {
  await createFormPdf('form-source.pdf')
  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'fill_form',
    input: 'form-source.pdf',
    output: 'form-filled.pdf',
    fields: {
      'person.name': 'Ada Lovelace',
      'terms.accepted': true,
    },
  })

  assert.equal(result.flattened, false)
  assert.equal(result.interactiveFormPreserved, true)
  const output = await loadOutput('form-filled.pdf')
  const form = output.getForm()
  assert.equal(form.getTextField('person.name').getText(), 'Ada Lovelace')
  assert.equal(form.getCheckBox('terms.accepted').isChecked(), true)
  assert.equal(form.getFields().length, 2)
})

test('fill_form writes Chinese /V and a non-empty Unicode /AP appearance', async () => {
  await createFormPdf('form-chinese-source.pdf')
  await dispatchPdfTool('pdf_transform', {
    operation: 'fill_form',
    input: 'form-chinese-source.pdf',
    output: 'form-chinese-filled.pdf',
    fields: { 'person.name': '张三' },
  })

  const output = await loadOutput('form-chinese-filled.pdf')
  const field = output.getForm().getTextField('person.name')
  assert.equal(field.getText(), '张三')
  assert.ok(field.acroField.dict.has(PDFName.of('V')), 'text field must retain canonical /V')
  const widgets = field.acroField.getWidgets()
  assert.equal(widgets.length, 1)
  const appearances = widgets[0].getAppearances()
  assert.ok(appearances?.normal, 'widget must contain a normal /AP appearance')
  const normal = output.context.lookup(appearances.normal)
  assert.ok(normal?.getContentsSize?.() > 0, 'normal /AP stream must not be empty')
})

test('fill_form flattens only when explicitly requested', async () => {
  await createFormPdf('flatten-source.pdf')
  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'fill_form',
    input: 'flatten-source.pdf',
    output: 'flattened.pdf',
    fields: { 'person.name': 'Grace Hopper' },
    flatten: true,
  })

  assert.equal(result.flattened, true)
  assert.equal(result.interactiveFormPreserved, false)
  const output = await loadOutput('flattened.pdf')
  assert.equal(output.getForm().getFields().length, 0)
})

test('outputs never overwrite by default and failed publication leaves no temp files', async () => {
  await createPdf('no-overwrite-source.pdf', 1)
  const sentinel = Buffer.from('do not replace')
  fs.writeFileSync(path.join(workspace, 'existing.pdf'), sentinel)

  await assert.rejects(
    () => dispatchPdfTool('pdf_transform', {
      operation: 'rotate',
      input: 'no-overwrite-source.pdf',
      output: 'existing.pdf',
      degrees: 90,
    }),
    (error) => error?.code === 'PDF_OUTPUT_EXISTS' && error?.statusCode === 409,
  )
  assert.deepEqual(fs.readFileSync(path.join(workspace, 'existing.pdf')), sentinel)
  assert.equal(fs.readdirSync(workspace).some((name) => name.endsWith('.tmp')), false)
})

test('overwrite replaces an existing output only when explicitly enabled', async () => {
  await createPdf('overwrite-source.pdf', 2)
  fs.writeFileSync(path.join(workspace, 'overwrite-target.pdf'), 'old bytes')

  const result = await dispatchPdfTool('pdf_transform', {
    operation: 'rotate',
    input: 'overwrite-source.pdf',
    output: 'overwrite-target.pdf',
    degrees: 90,
    overwrite: true,
  })

  assert.equal(result.ok, true)
  const output = await loadOutput('overwrite-target.pdf')
  assert.equal(output.getPageCount(), 2)
  assert.deepEqual(output.getPages().map((page) => page.getRotation().angle), [90, 90])
})

test('PDF input and output limits are separate and configurable', async () => {
  const source = await createPdf('limited-source.pdf', 1)
  process.env.PDF_TOOL_MAX_INPUT_BYTES = String(source.byteLength - 1)
  await assert.rejects(
    () => dispatchPdfTool('pdf_info', { path: 'limited-source.pdf' }),
    (error) => error?.code === 'PDF_INPUT_TOO_LARGE' && error?.statusCode === 413,
  )

  delete process.env.PDF_TOOL_MAX_INPUT_BYTES
  process.env.PDF_TOOL_MAX_OUTPUT_BYTES = '128'
  await assert.rejects(
    () => dispatchPdfTool('pdf_transform', {
      operation: 'rotate',
      input: 'limited-source.pdf',
      output: 'too-large-output.pdf',
      degrees: 90,
    }),
    (error) => error?.code === 'PDF_OUTPUT_TOO_LARGE' && error?.statusCode === 413,
  )
  assert.equal(fs.existsSync(path.join(workspace, 'too-large-output.pdf')), false)
})

test('pdf_info and transform use a large-file channel beyond the old 5 MB text limit', async () => {
  const document = await PDFDocument.create()
  document.addPage([200, 200])
  await document.attach(crypto.randomBytes(6 * 1024 * 1024), 'random-payload.bin', {
    mimeType: 'application/octet-stream',
  })
  const bytes = await document.save({ useObjectStreams: true })
  assert.ok(bytes.byteLength > 5 * 1024 * 1024, `fixture was only ${bytes.byteLength} bytes`)
  fs.writeFileSync(path.join(workspace, 'large.pdf'), bytes)

  const info = await dispatchPdfTool('pdf_info', { path: 'large.pdf' })
  assert.equal(info.pageCount, 1)
  assert.ok(info.size > 5 * 1024 * 1024)

  const transformed = await dispatchPdfTool('pdf_transform', {
    operation: 'rotate',
    input: 'large.pdf',
    output: 'large-rotated.pdf',
    degrees: 90,
  })
  assert.ok(transformed.outputs[0].size > 5 * 1024 * 1024)
  assert.equal((await loadOutput('large-rotated.pdf')).getPage(0).getRotation().angle, 90)
})

test('XFA is reported without being deleted and transformations are explicitly rejected', async () => {
  const document = await PDFDocument.create()
  document.addPage([200, 200])
  const acroForm = document.catalog.getOrCreateAcroForm()
  acroForm.dict.set(PDFName.of('XFA'), document.context.obj('unsupported-xfa'))
  fs.writeFileSync(path.join(workspace, 'xfa.pdf'), await document.save())

  const info = await dispatchPdfTool('pdf_info', { path: 'xfa.pdf' })
  assert.equal(info.form.hasXfa, true)
  assert.equal(info.supported, false)
  assert.match(info.limitations.join(' '), /XFA/)

  await assert.rejects(
    () => dispatchPdfTool('pdf_transform', {
      operation: 'rotate',
      input: 'xfa.pdf',
      output: 'xfa-rotated.pdf',
      degrees: 90,
    }),
    (error) => error?.code === 'PDF_XFA_UNSUPPORTED' && error?.hasXfa === true,
  )
})
