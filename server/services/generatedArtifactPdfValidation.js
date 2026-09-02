import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GeneratedArtifactFormatError,
  invalid,
} from './generatedArtifactFormatValidationError.js'

const MAX_PDF_PAGES = 10_000
const PDFJS_STANDARD_FONT_DATA_URL = `${path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/pdfjs-dist/standard_fonts',
)}${path.sep}`

let pdfJsPromise = null
function loadPdfJs() {
  if (!pdfJsPromise) pdfJsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfJsPromise
}

export async function validateGeneratedArtifactPdf(bytes) {
  let loadingTask = null
  let document = null
  try {
    const { getDocument } = await loadPdfJs()
    loadingTask = getDocument({
      data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
      disableWorker: true,
      stopAtErrors: true,
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0,
    })
    document = await loadingTask.promise
    if (!Number.isSafeInteger(document.numPages) || document.numPages <= 0 || document.numPages > MAX_PDF_PAGES) {
      invalid('ARTIFACT_FORMAT_PDF_INVALID', 'The PDF has no bounded, non-empty page tree.')
    }
    let operatorCount = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const view = page?.view
      const width = Array.isArray(view) ? Math.abs(Number(view[2]) - Number(view[0])) : 0
      const height = Array.isArray(view) ? Math.abs(Number(view[3]) - Number(view[1])) : 0
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        invalid('ARTIFACT_FORMAT_PDF_INVALID', `PDF page ${pageNumber} has invalid dimensions.`)
      }
      const operators = await page.getOperatorList()
      if (!Array.isArray(operators?.fnArray) || !Array.isArray(operators?.argsArray)) {
        invalid('ARTIFACT_FORMAT_PDF_INVALID', `PDF page ${pageNumber} cannot be decoded.`)
      }
      operatorCount += operators.fnArray.length
      page.cleanup()
    }
    return { pageCount: document.numPages, operatorCount }
  } catch (cause) {
    if (cause instanceof GeneratedArtifactFormatError) throw cause
    invalid('ARTIFACT_FORMAT_PDF_INVALID', 'The PDF page tree or page content cannot be parsed.', cause)
  } finally {
    try {
      if (document) await document.destroy()
      else if (loadingTask) await loadingTask.destroy()
    } catch { /* parser cleanup only */ }
  }
}
