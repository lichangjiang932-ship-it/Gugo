import { buildOfficeFilename, parseMarkdownDocument, parseSpreadsheetRows, shouldOfferOfficeExport } from '../officeExport.js'
import { buildPresentationFilename, parseMarkdownSlides, shouldOfferPptxExport } from '../presentationExport.js'
import { detectArtifactWithConfidence, extractHtmlSource, inferSpreadsheetTitle } from './artifactDetection.js'
import { buildMultiHtmlDocument, parseMultiHtmlSource } from './htmlDocuments.js'
import { buildChartDocument, buildMermaidDocument, buildSvgDocument } from './visualDocuments.js'

const MAX_PREVIEW_SLIDES = 12
const MAX_PREVIEW_BLOCKS = 20
const MAX_PREVIEW_ROWS = 18
const MAX_PREVIEW_COLUMNS = 8

export function buildArtifactPreview({ content = '', meta = {} } = {}) {
  // \u5148\u6309 meta \u7684\u663e\u5f0f\u58f0\u660e\u8d70 (slash \u547d\u4ee4\u8def\u5f84)
  let resolvedType = ''
  let inferred = false
  let confidence = 1
  if (shouldOfferPptxExport(meta)) resolvedType = 'pptx'
  else if (meta?.artifactType === 'html' || meta?.skillId === 'htmlppt') resolvedType = 'html'
  else if (meta?.artifactType === 'react') resolvedType = 'react'
  else if (['mermaid', 'chart', 'svg', 'html_multi'].includes(meta?.artifactType)) resolvedType = meta.artifactType
  else {
    const officeType = shouldOfferOfficeExport(meta)
    if (officeType) resolvedType = officeType
  }
  // \u6ca1\u6709\u663e\u5f0f meta \u65f6\u53ea\u55c5\u63a2\u7f51\u9875/\u56fe\u5f62\u7c7b\u9884\u89c8\u3002Office \u6587\u4ef6\u5fc5\u987b\u6765\u81ea\u672c\u8f6e\u660e\u786e
  // \u7684\u6280\u80fd\u6216 create_* \u5de5\u5177\uff1b\u4e0d\u80fd\u56e0\u4e3a\u666e\u901a\u56de\u7b54\u7528\u4e86\u591a\u4e2a\u5206\u9694\u7ebf/\u6807\u9898/\u8868\u683c\uff0c
  // \u5c31\u5728\u6d41\u5f0f\u8f93\u51fa\u4e2d\u9014\u7a81\u7136\u628a\u6b63\u6587\u53d8\u6210 PPT\u3001Word \u6216 Excel\u3002
  // \u2605 batchF P2b: \u55c5\u63a2\u51fa\u6765\u7684 artifact \u4e0d\u518d\u66ff\u4ee3\u6b63\u6587,\u53ea\u5728\u6b63\u6587\u4e0b\u8ffd\u52a0\u4e00\u4e2a
  //   "\u5728\u53f3\u4fa7\u6253\u5f00\u9884\u89c8" CTA;\u901a\u8fc7\u8fd4\u56de inferred:true \u8ba9 ChatMessages \u533a\u5206.
  // \u2605 batchG G4: \u540c\u65f6\u8fd4\u56de\u7f6e\u4fe1\u5ea6,UI \u53ef\u53ea\u5bf9 \u2265 ARTIFACT_AUTO_OPEN_CONFIDENCE \u7684\u547d\u4e2d\u5f39\u53f3\u680f.
  if (!resolvedType) {
    const probe = detectArtifactWithConfidence(content)
    if (probe.type && !['pptx', 'docx', 'xlsx'].includes(probe.type)) {
      resolvedType = probe.type
      inferred = true
      confidence = probe.confidence
    }
  }
  if (!resolvedType) return null

  const base = { inferred, confidence }

  if (resolvedType === 'html') {
    const html = extractHtmlSource(content)
    if (!html) return null
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i) || html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    const title = (titleMatch?.[1] || meta.artifactTitle || 'preview').trim()
    return {
      ...base,
      type: 'html',
      title,
      label: 'HTML',
      filename: buildOfficeFilename(title, 'html'),
      summary: `${html.length} \u5b57\u7b26`,
      html,
      previewable: true,
    }
  }

  if (resolvedType === 'mermaid') {
    const title = (meta.artifactTitle || 'diagram').toString().trim() || 'diagram'
    return {
      ...base,
      type: 'mermaid',
      title,
      label: 'Mermaid',
      filename: buildOfficeFilename(title, 'mmd'),
      summary: `${content.length} characters`,
      html: buildMermaidDocument(content, meta.artifactDescription || 'default'),
      previewable: true,
    }
  }

  if (resolvedType === 'chart') {
    const title = (meta.artifactTitle || 'chart').toString().trim() || 'chart'
    return {
      ...base,
      type: 'chart',
      title,
      label: 'Chart',
      filename: buildOfficeFilename(title, 'json'),
      summary: 'Chart.js preview',
      html: buildChartDocument(content),
      previewable: true,
    }
  }

  if (resolvedType === 'svg') {
    const title = (meta.artifactTitle || 'vector').toString().trim() || 'vector'
    return {
      ...base,
      type: 'svg',
      title,
      label: 'SVG',
      filename: buildOfficeFilename(title, 'svg'),
      summary: `${content.length} characters`,
      html: buildSvgDocument(content),
      previewable: true,
    }
  }

  if (resolvedType === 'html_multi') {
    const title = (meta.artifactTitle || 'html-app').toString().trim() || 'html-app'
    const files = parseMultiHtmlSource(content)
    return {
      ...base,
      type: 'html_multi',
      title,
      label: 'HTML App',
      filename: buildOfficeFilename(title, 'html'),
      summary: `${Object.keys(files).length || 1} files`,
      html: buildMultiHtmlDocument(files),
      previewable: true,
    }
  }

  if (resolvedType === 'pptx') {
    const slides = parseMarkdownSlides(content)
    const title = slides[0]?.title || meta.artifactTitle || 'presentation'
    // \u2605 \u5173\u952e\u4fee\u590d: \u5373\u4f7f slides \u89e3\u6790\u4e3a 0\uff08\u6a21\u578b\u8f93\u51fa\u683c\u5f0f\u4e0d\u6807\u51c6\uff09\uff0c\u53ea\u8981 meta.artifactType
    //   \u663e\u5f0f\u58f0\u660e\u4e3a pptx\uff08\u6765\u81ea create_pptx \u5de5\u5177\u6210\u529f\u8c03\u7528\uff09\uff0c\u4ecd\u7136\u521b\u5efa\u9884\u89c8\u5361\u7247\u3002
    //   \u5426\u5219 artifact \u4e0d\u663e\u793a \u2192 \u53f3\u4fa7\u9884\u89c8\u4e0d\u6253\u5f00 \u2192 \u7528\u6237\u770b\u5230\u7684\u662f\u539f\u59cb\u6587\u672c\u3002
    if (!slides.length && meta.artifactType !== 'pptx') return null
    return {
      ...base,
      type: 'pptx',
      title,
      label: 'PowerPoint',
      filename: buildPresentationFilename(title),
      summary: slides.length ? `${slides.length} \u9875\u5e7b\u706f\u7247` : `${content.length} \u5b57\u7b26\u5185\u5bb9`,
      slides: slides.length ? slides.slice(0, MAX_PREVIEW_SLIDES) : [{ title, body: content.slice(0, 500) }],
      totalCount: slides.length || 1,
      previewable: true,
    }
  }

  if (resolvedType === 'docx') {
    const doc = parseMarkdownDocument(content)
    if (!doc.blocks.length && meta.artifactType !== 'docx') return null
    return {
      ...base,
      type: 'docx',
      title: doc.title || meta.artifactTitle || 'document',
      label: 'Word',
      filename: buildOfficeFilename(doc.title || meta.artifactTitle || 'document', 'docx'),
      summary: doc.blocks.length ? `${doc.blocks.length} \u4e2a\u5185\u5bb9\u5757` : `${content.length} \u5b57\u7b26\u5185\u5bb9`,
      blocks: doc.blocks.length ? doc.blocks.slice(0, MAX_PREVIEW_BLOCKS) : [{ title: '\u5185\u5bb9', body: content.slice(0, 500) }],
      totalCount: doc.blocks.length || 1,
      previewable: true,
    }
  }

  if (resolvedType === 'xlsx') {
    const rows = parseSpreadsheetRows(content)
    const title = inferSpreadsheetTitle(rows.length ? rows : [], meta.artifactTitle || 'spreadsheet')
    if (!rows.length && meta.artifactType !== 'xlsx') return null
    return {
      ...base,
      type: 'xlsx',
      title,
      label: 'Excel',
      filename: buildOfficeFilename(title, 'xlsx'),
      summary: rows.length ? `${rows.length} \u884c\u6570\u636e` : `${content.length} \u5b57\u7b26\u5185\u5bb9`,
      rows: rows.length ? rows.slice(0, MAX_PREVIEW_ROWS).map((row) => row.slice(0, MAX_PREVIEW_COLUMNS)) : [['\u5185\u5bb9', content.slice(0, 200)]],
      totalCount: rows.length || 1,
      totalColumns: rows.length ? Math.max(...rows.map((row) => row.length)) : 1,
      previewable: true,
    }
  }

  if (resolvedType === 'react') {
    // \u2605 batchH H1: React \u6c99\u7bb1 \u2014 \u6e90\u5c31\u662f\u5355\u6587\u4ef6\u7ec4\u4ef6\u4ee3\u7801,\u5728 RightPreviewPane
    //   \u91cc\u7528 iframe + babel-standalone \u5b9e\u65f6\u7f16\u8bd1\u5e76\u6e32\u67d3.
    const title = (meta.artifactTitle || 'react-component').toString().trim() || 'react-component'
    const description = meta.artifactDescription ? String(meta.artifactDescription).trim() : ''
    return {
      ...base,
      type: 'react',
      title,
      label: 'React',
      filename: buildOfficeFilename(title, 'jsx'),
      summary: description || `${content.length} \u5b57\u7b26\u7ec4\u4ef6`,
      description,
      previewable: true,
    }
  }

  return null
}

