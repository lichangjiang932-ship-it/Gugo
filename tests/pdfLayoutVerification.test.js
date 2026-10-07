import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createCanvas } from '@napi-rs/canvas'

import { closeDb, createUser } from '../server/db.js'
import { grantLocalPath } from '../server/services/localFileAccessService.js'
import { dispatchPdfTool } from '../server/adapters/pdfTools.js'
import { loadPdfJs, PDFJS_STANDARD_FONT_DATA_URL } from '../server/adapters/pdfToolSupport.js'
import { isTrustedPdfLayoutReceipt } from '../server/utils/pdfLayoutReceipt.js'
import { isSuccessfulPdfLayoutVerification } from '../server/services/loop/heuristics/capabilityChecks.js'

test.after(() => closeDb())
let sequence = 0

async function pdf(target, body, second = 'Untouched page') {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const value of ['Writing Task 1\n' + body, second]) {
    const page = document.addPage([160, 140])
    for (const [index, line] of value.split('\n').entries()) {
      page.drawText(line, { x: 10, y: 115 - index * 15, size: 8, font })
    }
  }
  fs.writeFileSync(target, await document.save())
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-layout-verification-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const userId = `pdf-layout-owner-${++sequence}`
  createUser({ id: userId, email: `${userId}@example.invalid` })
  grantLocalPath({ userId, rootPath: root, accessMode: 'read_only' })
  const source = path.join(root, 'source.pdf')
  const output = path.join(root, 'output.pdf')
  await pdf(source, 'Original body')
  await pdf(output, 'Expected body')
  return {
    root, source, output,
    binding: { userId, sessionId: `${userId}-session`, executionId: `${userId}-turn` },
    args: { path: output, verifyLayout: {
      source, pages: [1], expectedText: 'Expected body', sectionLabel: 'Writing Task 1',
    } },
  }
}

async function preview(input, output, number) {
  const pdfjs = await loadPdfJs()
  const task = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(input)), disableWorker: true,
    isEvalSupported: false, standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
  })
  const document = await task.promise
  try {
    const page = await document.getPage(number)
    const viewport = page.getViewport({ scale: 1 })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    fs.writeFileSync(output, canvas.toBuffer('image/png'))
  } finally { await document.destroy() }
}

test('builtin PDF verification issues a receipt for actual text, bounds and unchanged source pages', async (t) => {
  const f = await fixture(t)
  const result = await dispatchPdfTool('pdf_text', f.args, f.binding)
  const receipt = result.pdfLayoutVerification
  assert.equal(result.ok, true)
  assert.equal(result.pageCount, 2)
  assert.equal(receipt.output.path, f.output)
  assert.match(receipt.output.sha256, /^[a-f0-9]{64}$/u)
  assert.ok(receipt.checks.some((check) => check.kind === 'untargeted_pages_unchanged'))
  assert.equal(isSuccessfulPdfLayoutVerification(
    { name: 'pdf_text', args: f.args }, result, { ...f.binding, targets: [f.output] },
  ), true)
  assert.equal(isTrustedPdfLayoutReceipt(JSON.parse(JSON.stringify(receipt)), f.binding), true)
})

test('forged, edited and foreign-owner or foreign-turn PDF receipts cannot complete a task', async (t) => {
  const f = await fixture(t)
  const result = await dispatchPdfTool('pdf_text', f.args, f.binding)
  const receipt = result.pdfLayoutVerification
  assert.equal(isTrustedPdfLayoutReceipt({ verified: true, verifier: 'gugo_pdf_layout', version: 1 }), false)
  assert.equal(isTrustedPdfLayoutReceipt({
    ...receipt, output: { ...receipt.output, path: path.join(f.root, 'another.pdf') },
  }), false)
  assert.equal(isTrustedPdfLayoutReceipt(receipt, { ...f.binding, userId: 'another-owner' }), false)
  assert.equal(isTrustedPdfLayoutReceipt(receipt, { ...f.binding, executionId: 'another-turn' }), false)
  assert.equal(isSuccessfulPdfLayoutVerification({ name: 'pdf_text', args: f.args }, result, {
    ...f.binding, targets: [path.join(f.root, 'unrelated.pdf')],
  }), false)
  assert.equal(isSuccessfulPdfLayoutVerification({ name: 'pdf_text', args: f.args }, result, {
    ...f.binding, sectionLabel: 'Writing Task 2',
  }), false)
})

test('shell workers and cold hosts do not inherit the parent receipt authority', async (t) => {
  const f = await fixture(t)
  const { pdfLayoutVerification: receipt } = await dispatchPdfTool('pdf_text', f.args, f.binding)
  const moduleUrl = new URL('../server/utils/pdfLayoutReceipt.js', import.meta.url).href
  const script = `import fs from 'node:fs'; import {isTrustedPdfLayoutReceipt} from ${JSON.stringify(moduleUrl)};
process.stdout.write(String(isTrustedPdfLayoutReceipt(JSON.parse(fs.readFileSync(0, 'utf8')))));`
  const accepted = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', input: JSON.stringify(receipt),
  })
  assert.equal(accepted, 'false')
})

test('a valid PDF with missing required text cannot get a layout receipt', async (t) => {
  const f = await fixture(t)
  await pdf(f.output, 'Wrong body')
  await assert.rejects(dispatchPdfTool('pdf_text', f.args, f.binding), {
    code: 'PDF_LAYOUT_VERIFICATION_FAILED',
  })
})

test('changing a non-target page fails independent renderer verification', async (t) => {
  const f = await fixture(t)
  await pdf(f.output, 'Expected body', 'Unexpected changed page')
  await assert.rejects(dispatchPdfTool('pdf_text', f.args, f.binding), {
    code: 'PDF_LAYOUT_VERIFICATION_FAILED',
  })
})

test('text outside writable bounds cannot be certified', async (t) => {
  const f = await fixture(t)
  f.args.verifyLayout.rectangles = [{ page: 1, x: 0, y: 0, width: 5, height: 5 }]
  await assert.rejects(dispatchPdfTool('pdf_text', f.args, f.binding), {
    code: 'PDF_LAYOUT_VERIFICATION_FAILED',
  })
})

test('writable bounds cover inserted text while retaining the original page heading', async (t) => {
  const f = await fixture(t)
  f.args.verifyLayout.rectangles = [{ page: 1, x: 0, y: 85, width: 160, height: 27 }]
  const result = await dispatchPdfTool('pdf_text', f.args, f.binding)
  assert.equal(isTrustedPdfLayoutReceipt(result.pdfLayoutVerification, f.binding), true)
})

test('copying the selected label onto a wrong source page cannot prove section placement', async (t) => {
  const f = await fixture(t)
  await pdf(f.output, 'Original body', 'Writing Task 1\nExpected body')
  f.args.verifyLayout.pages = [2]
  await assert.rejects(dispatchPdfTool('pdf_text', f.args, f.binding), {
    code: 'PDF_LAYOUT_VERIFICATION_FAILED',
  })
})

test('fresh PNG previews pass and an older page preview fails', async (t) => {
  const f = await fixture(t)
  const image = path.join(f.root, 'page-1.png')
  await preview(f.output, image, 1)
  f.args.verifyLayout.previews = [{ page: 1, path: image }]
  const result = await dispatchPdfTool('pdf_text', f.args, f.binding)
  assert.ok(result.pdfLayoutVerification.checks.some((check) => check.kind === 'fresh_page_previews'))
  await preview(f.source, image, 1)
  await assert.rejects(dispatchPdfTool('pdf_text', f.args, f.binding), {
    code: 'PDF_LAYOUT_VERIFICATION_FAILED',
  })
})

test('PDF verification retains path permissions and cancellation before creating a receipt', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(dispatchPdfTool('pdf_text', f.args, {
    ...f.binding, signal: controller.signal,
  }), { name: 'AbortError' })
  const other = `pdf-layout-foreign-${++sequence}`
  createUser({ id: other, email: `${other}@example.invalid` })
  await assert.rejects(dispatchPdfTool('pdf_text', f.args, { userId: other }),
    (error) => ['PATH_NOT_AUTHORIZED', 'PATH_ACCESS_DENIED'].includes(error.code))
})
