import { parseMarkdownDocument } from '../officeExport.js'
import { parseMarkdownSlides } from '../presentationExport.js'

export function inferSpreadsheetTitle(rows, fallback = 'spreadsheet') {
  return rows[0]?.find((cell) => String(cell || '').trim()) || fallback
}

/**
 * \u5185\u5bb9\u55c5\u63a2 \u2014 \u5728\u6ca1\u6709 /ppt /doc /excel /html \u659c\u6760\u547d\u4ee4\u65f6,\u6839\u636e\u6d88\u606f\u6b63\u6587\u81ea\u52a8\u5224\u522b\u8981\u4e0d\u8981\u505a\u6210"\u6587\u4ef6\u5361\u7247"\u3002
 * \u4f18\u5148\u7ea7: html > pptx > xlsx > docx
 *
 * \u2605 batchF P2b: \u55c5\u63a2\u9608\u503c\u4e4b\u524d\u592a\u6fc0\u8fdb \u2014 3 \u4e2a\u7f16\u53f7\u5c0f\u8282\u5c31\u5f53 PPT,
 *   2 \u884c markdown \u8868\u683c\u5c31\u5f53 Excel,\u666e\u901a\u95ee\u7b54\u91cc\u5e38\u89c1\u7684\u5bf9\u6bd4\u8868/\u6b65\u9aa4\u6e05\u5355\u5168\u88ab\u8bef\u5224.
 *   \u73b0\u5728\u7edf\u4e00\u62ac\u9ad8\u95e8\u69db,\u5e76\u4e14 ChatMessages \u4e0d\u518d\u7528\u5361\u7247\u66ff\u4ee3\u6b63\u6587 \u2014 \u5361\u7247\u53ea\u4f5c\u4e3a
 *   \u8f85\u52a9 CTA \u51fa\u73b0,\u7528\u6237\u59cb\u7ec8\u80fd\u770b\u5230\u5b8c\u6574\u7b54\u6848.
 *
 * \u2605 batchG G4: \u540c\u65f6\u8fd4\u56de confidence (0..1).\u8c03\u7528\u65b9\u53ef\u7528\u9608\u503c\u7b5b\u6389\u4f4e\u7f6e\u4fe1\u5ea6\u547d\u4e2d.
 *   \u8fd4\u56de\u65e7\u5f62\u5f0f (\u5b57\u7b26\u4e32) \u7531 detectArtifactType \u517c\u5bb9,\u65b0\u63a5\u53e3\u8d70 detectArtifactWithConfidence.
 *
 * \u8fd4\u56de\u503c: 'html' | 'pptx' | 'xlsx' | 'docx' | null
 */
export function detectArtifactWithConfidence(content = '') {
  const text = String(content || '')
  if (text.length < 60) return { type: null, confidence: 0 }

  // \u2500\u2500 HTML: \u5b8c\u6574 html \u4ee3\u7801\u5757 \u6216 \u4ee5 <!doctype html> / <html \u5f00\u5934 \u2500\u2500
  const htmlFence = text.match(/```html\s*\n([\s\S]*?)```/i)
  if (htmlFence && /<\w+[\s>]/.test(htmlFence[1])) return { type: 'html', confidence: 0.95 }
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)) return { type: 'html', confidence: 0.95 }

  // \u2500\u2500 PPTX: \u81f3\u5c11 3 \u5f20 --- \u5206\u9694\u7684\u5e7b\u706f\u7247, \u6216 \u22656 \u6761 "\u6570\u5b57." \u5927\u7eb2 \u2500\u2500
  const dashSlideCount = (text.match(/^\s*---+\s*$/gm) || []).length
  if (dashSlideCount >= 3) {
    const slides = parseMarkdownSlides(text)
    if (slides.length >= 3) {
      const conf = Math.min(0.95, 0.6 + slides.length * 0.05)
      return { type: 'pptx', confidence: conf }
    }
  }
  const numberedHeads = (text.match(/^(?:#{1,4}\s*)?\d{1,2}[.\u3001]\s+\S/gm) || []).length
  if (numberedHeads >= 6) {
    const slides = parseMarkdownSlides(text)
    if (slides.length >= 6) {
      const conf = Math.min(0.85, 0.55 + slides.length * 0.04)
      return { type: 'pptx', confidence: conf }
    }
  }

  // \u2500\u2500 XLSX: csv \u4ee3\u7801\u5757 \u6216 \u771f\u00b7markdown \u8868\u683c (\u542b\u5206\u9694\u884c + \u22654 \u6570\u636e\u884c) \u2500\u2500
  if (/```(?:csv|tsv)\s*\n[\s\S]*?```/i.test(text)) return { type: 'xlsx', confidence: 0.9 }
  const tableLines = text.split('\n').filter((l) => /^\s*\|.+\|\s*$/.test(l))
  const hasSeparatorRow = text.split('\n').some((l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l))
  if (tableLines.length >= 6 && hasSeparatorRow) {
    const conf = Math.min(0.9, 0.6 + tableLines.length * 0.03)
    return { type: 'xlsx', confidence: conf }
  }

  // \u2500\u2500 DOCX: \u81f3\u5c11 3 \u4e2a markdown \u6807\u9898 + \u4e00\u5b9a\u5b57\u6570 \u2500\u2500
  const headingCount = (text.match(/^#{1,6}\s+\S/gm) || []).length
  if (headingCount >= 3 && text.length >= 400) {
    const doc = parseMarkdownDocument(text)
    if (doc.blocks.length >= 5) {
      const conf = Math.min(0.85, 0.5 + headingCount * 0.05 + Math.min(0.2, text.length / 4000))
      return { type: 'docx', confidence: conf }
    }
  }

  return { type: null, confidence: 0 }
}

// \u9608\u503c\u4f4e\u4e8e\u8be5\u503c\u7684\u55c5\u63a2\u7ed3\u679c\u4e0d\u4f1a\u89e6\u53d1\u81ea\u52a8\u53f3\u680f\u5f39\u51fa.
// \u7528\u6237\u4e3b\u52a8\u70b9\u51fb artifact \u5361\u7247\u4ecd\u7136\u80fd\u9884\u89c8 \u2014 \u53ea\u662f\u4e0d\u4f1a\u65e0\u9080\u8bf7\u5f39\u51fa\u6765\u6253\u6270.
export const ARTIFACT_AUTO_OPEN_CONFIDENCE = 0.7

export function detectArtifactType(content = '') {
  return detectArtifactWithConfidence(content).type
}

/**
 * \u662f\u5426\u628a\u6574\u6761\u6d88\u606f\u6298\u53e0\u6210\u4e00\u5f20\u300c\u6587\u4ef6\u5361\u300d(\u4e0d\u518d\u6e32\u67d3\u6b63\u6587)\u3002
 *
 * \u2605 \u8fd9\u91cc\u53ea\u8be5\u5728**\u4e00\u79cd**\u60c5\u51b5\u4e0b\u6298\u53e0:\u6d88\u606f\u6b63\u6587\u81ea\u8eab\u5c31\u662f\u6587\u4ef6\u6e90\u7801
 * (\u6a21\u578b\u76f4\u63a5\u5410\u4e86\u4e00\u6574\u7bc7 HTML/markdown \u5f53\u56de\u590d),\u6e32\u67d3\u539f\u59cb\u6e90\u7801\u6ca1\u6709\u610f\u4e49\u3002
 *
 * \u66fe\u7ecf\u7684\u5199\u6cd5\u662f `!(replyText && sourceText && replyText !== sourceText)`,
 * \u5b83\u5728\u300c\u6709\u4ea7\u7269\u4f46\u6a21\u578b\u6ca1\u5199\u6b63\u6587\u300d\u65f6\u4e5f\u8fd4\u56de true \u2014\u2014 \u4e8e\u662f\u6574\u6761\u6d88\u606f\u53ea\u5269\u4e00\u5f20\u5361,
 * \u6a21\u578b\u8bf4\u8fc7\u7684\u4efb\u4f55\u8bdd\u3001\u4ee5\u53ca\u6211\u4eec\u515c\u5e95\u5408\u6210\u7684\u6267\u884c\u6458\u8981,**\u5168\u88ab\u541e\u6389**\u3002
 * \u771f\u5b9e\u4e8b\u6545:\u7528\u6237\u8ba9\u300c\u4f18\u5316\u4e70\u5356\u9875\u9762\u7684\u6309\u94ae\u9ad8\u4eae\u300d,\u5c4f\u5e55\u4e0a\u53ea\u51fa\u73b0\u4e00\u5f20 PPT \u5361\u7247,
 * \u6ca1\u6709\u4e00\u4e2a\u5b57\u8bf4\u660e\u6539\u4e86\u4ec0\u4e48\u3001\u6539\u6ca1\u6539\u6210\u3002
 *
 * \u73b0\u5728\u7684\u89c4\u5219:
 *   - \u6b63\u6587 === \u6e90\u7801 \u2192 \u6298\u53e0\u3002\u6a21\u578b\u628a\u6574\u7bc7\u6e90\u7801\u5f53\u56de\u590d\u5410\u51fa\u6765\u4e86,
 *     \u6b63\u6587\u533a\u6e32\u67d3\u539f\u59cb\u6e90\u7801\u6ca1\u6709\u610f\u4e49,\u4e5f\u6ca1\u6709\u4efb\u4f55\u8bf4\u660e\u4f1a\u88ab\u541e\u6389\u3002
 *   - \u5176\u4f59\u60c5\u51b5\u4e00\u5f8b**\u4e0d\u6298\u53e0**\u3002\u5c24\u5176\u662f\u300c\u6709\u4ea7\u7269\u4f46\u6b63\u6587\u4e3a\u7a7a\u300d\u2014\u2014
 *     \u90a3\u6b63\u662f\u6700\u9700\u8981\u663e\u793a\u515c\u5e95\u6267\u884c\u6458\u8981\u7684\u65f6\u5019\u3002
 */
export function shouldCollapseArtifactPreview(preview, { content = '', artifactSource = '' } = {}) {
  if (!preview) return false
  const replyText = String(content || '').trim()
  const sourceText = String(artifactSource || '').trim()

  // \u6b63\u6587\u81ea\u8eab\u5c31\u662f\u6e90\u7801 \u2014\u2014 \u6298\u53e0\u6210\u5361\u7247,\u6ca1\u6709\u8bf4\u660e\u4f1a\u56e0\u6b64\u4e22\u5931\u3002
  // (\u5305\u62ec\u55c5\u63a2\u51fa\u6765\u7684\u4ea7\u7269:\u6ca1\u6709\u72ec\u7acb source,\u6b63\u6587\u672c\u8eab\u5373\u6e90\u7801\u3002)
  if (!sourceText) return true
  if (replyText === sourceText) return true

  // \u6709\u72ec\u7acb source \u4e14\u6b63\u6587\u4e0d\u662f\u6e90\u7801 \u2192 \u6b63\u6587\u8981\u4e48\u662f\u771f\u7684\u8bf4\u660e,
  // \u8981\u4e48\u662f\u7a7a\u7684(\u6b64\u65f6\u515c\u5e95\u6458\u8981\u4f1a\u586b\u8fdb\u6765)\u3002\u4e24\u79cd\u60c5\u51b5\u90fd\u5fc5\u987b\u663e\u793a\u6b63\u6587\u533a\u3002
  return false
}

/**
 * \u53d6\u51fa\u6d88\u606f\u91cc\u7684 HTML \u6e90 \u2014 \u4f18\u5148\u7528 ```html``` \u4ee3\u7801\u5757, fallback \u5230\u6574\u6bb5\u6587\u672c\u3002
 */
export function extractHtmlSource(content = '') {
  const text = String(content || '')
  const fence = text.match(/```html\s*\n([\s\S]*?)```/i)
  if (fence) return fence[1].trim()
  const fullDocument = text.match(/(?:<!doctype\s+html[^>]*>\s*)?<html[\s\S]*?<\/html>/i)
  if (fullDocument) return fullDocument[0].trim()
  return text.trim()
}

export function isHtmlDeckLike(htmlSource = '') {
  const src = String(htmlSource || '')
  if (!src.trim()) return false
  const sectionCount = (src.match(/<section\b/gi) || []).length
  const explicitSlideCount = (src.match(/\bclass\s*=\s*["'][^"']*\bslide\b[^"']*["']/gi) || []).length
  const dataSlideCount = (src.match(/\bdata-slide\s*=/gi) || []).length
  const pageClassCount = (src.match(/\bclass\s*=\s*["'][^"']*\b(?:page|deck-page|presentation-slide|deck-slide)\b[^"']*["']/gi) || []).length
  return explicitSlideCount >= 2 || dataSlideCount >= 2 || sectionCount >= 2 || pageClassCount >= 2
}

