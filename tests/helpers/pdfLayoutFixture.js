import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createUser, getUserById } from '../../server/db.js'
import { grantLocalPath } from '../../server/services/localFileAccessService.js'
import { pdfText } from '../../server/adapters/pdfToolReaders.js'
import { readPdfInput } from '../../server/adapters/pdfToolSupport.js'
import { verifyPdfLayout } from '../../server/adapters/pdfLayoutVerification.js'
import { requestedPdfSectionLabel } from '../../server/services/loop/heuristics/capabilityChecks.js'
import { extractFileTargetReferences } from '../../shared/artifactIntentSupport.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-layout-fixtures-'))
process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }))
let sequence = 0

/**
 * Windows Loop fixtures inject a logical filesystem. Validate actual PDF bytes
 * with the canonical parser, then map that trusted adapter's logical output.
 * No test can mint a receipt by setting verified=true or printing a marker.
 */
export async function pdfLayoutReceiptForTest({
  path: logicalPath = 'fixture.pdf', userId = null, executionId = null,
  sessionId = null, sectionLabel = null, expectedText = null,
} = {}) {
  const readerId = userId || 'pdf-layout-fixture-reader'
  if (!getUserById(readerId)) createUser({ id: readerId, email: `${readerId}@example.invalid` })
  grantLocalPath({ userId: readerId, rootPath: root, accessMode: 'read_only' })
  let physicalPath = logicalPath
  if (!fs.existsSync(physicalPath)) {
    physicalPath = path.join(root, `fixture-${++sequence}.pdf`)
    const document = await PDFDocument.create()
    const font = await document.embedFont(StandardFonts.Helvetica)
    const page = document.addPage([300, 200])
    page.drawText(sectionLabel || 'Fixture document', { x: 15, y: 170, size: 10, font })
    page.drawText('Verified fixture body', { x: 15, y: 145, size: 10, font })
    fs.writeFileSync(physicalPath, await document.save())
  } else {
    grantLocalPath({ userId: readerId, rootPath: physicalPath, accessMode: 'read_only' })
  }
  const parsed = await pdfText({ path: physicalPath, includeItems: true }, { userId: readerId })
  const expectation = expectedText || parsed.pages.map((page) => page.text).join('\n').trim()
  return verifyPdfLayout({ path: logicalPath, verifyLayout: {
    expectedText: expectation, ...(sectionLabel ? { sectionLabel } : {}),
  } }, { userId, executionId, sessionId }, {
    readText: async () => parsed,
    readInput: () => ({ ...readPdfInput(physicalPath, { userId: readerId }), fullPath: logicalPath }),
  })
}

export function hostPdfLayoutExecutor(executeTool) {
  let output = null
  return async (context) => {
    const result = await executeTool(context)
    if (result?.ok !== true) return result
    const candidates = [
      ...(context.args?.expected_outputs || []),
      ...(result.changedPaths || []), result.path, context.args?.path,
    ].filter((value) => typeof value === 'string' && /\.pdf$/iu.test(value))
    if (candidates.length) output = candidates[0]
    if (!/^(?:[\s\S]*\n)?(?:RESULT:\s*)?PDF_LAYOUT_VERIFICATION_OK(?:\r?\n|$)/u
      .test(String(result.stdout || ''))) return result
    const prompt = context.job?.userPrompt || context.job?.prompt || ''
    const referenced = extractFileTargetReferences(prompt).references
      .filter((entry) => entry.type === 'pdf').at(-1)?.path
    return { ...result, pdfLayoutVerification: await pdfLayoutReceiptForTest({
      path: output || referenced || 'fixture.pdf',
      userId: context.job?.userId || null,
      executionId: context.job?.id || null,
      sessionId: context.job?.sessionId || null,
      sectionLabel: requestedPdfSectionLabel(context.job?.userPrompt || context.job?.prompt),
    }) }
  }
}
