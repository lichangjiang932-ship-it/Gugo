import { pdfInfo, pdfText, renderPdfPages } from './pdfToolReaders.js'
import { PDF_TOOL_SPECS } from './pdfToolSpecs.js'
import { pdfError } from './pdfToolSupport.js'
import { pdfTransform } from './pdfToolTransforms.js'

export { PDF_TOOL_SPECS }

export async function dispatchPdfTool(name, args = {}, { userId = null, signal = null } = {}) {
  switch (name) {
    case 'pdf_info': return pdfInfo(args, { userId })
    case 'pdf_text': return pdfText(args, { userId })
    case 'render_pdf_pages': return renderPdfPages(args, { userId, signal })
    case 'pdf_transform': return pdfTransform(args, { userId, signal })
    default: throw pdfError(`unknown PDF tool: ${name}`, 404, 'PDF_TOOL_NOT_FOUND')
  }
}
