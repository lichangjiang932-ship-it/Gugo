import { useState } from 'react'
import { buildPresentationFilename, downloadPptxFromMarkdown, downloadPremiumPptx, parseMarkdownSlides } from '../../../lib/presentationExport.js'
import { buildOfficeFilename, downloadDocxFromMarkdown, downloadXlsxFromMarkdown, parseMarkdownDocument, parseSpreadsheetRows } from '../../../lib/officeExport.js'
import { buildHtmlDocument } from '../../../lib/artifactPreview.js'
import { downloadHtmlDeckAsPptx } from '../../../lib/htmlSlidesToPptx.js'

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  setTimeout(() => { URL.revokeObjectURL(url); anchor.remove() }, 100)
}

export default function useArtifactExports({ preview, content, onMessage, t }) {
  const [downloading, setDownloading] = useState(false)
  const [premiumExporting, setPremiumExporting] = useState(false)
  const [premiumProgress, setPremiumProgress] = useState('')
  const progress = (current, total) => setPremiumProgress(`${current}/${total}`)

  const handleDownload = async () => {
    setDownloading(true)
    try {
      if (preview.type === 'pptx') {
        const slides = parseMarkdownSlides(content)
        const title = slides[0]?.title || preview.title
        await downloadPremiumPptx(content, { title, filename: buildPresentationFilename(title), onProgress: progress })
      } else if (preview.type === 'docx') {
        const doc = parseMarkdownDocument(content)
        await downloadDocxFromMarkdown(content, { title: doc.title, filename: buildOfficeFilename(doc.title, 'docx') })
      } else if (preview.type === 'xlsx') {
        const rows = parseSpreadsheetRows(content)
        const title = rows[0]?.find((cell) => String(cell || '').trim()) || preview.title
        await downloadXlsxFromMarkdown(content, { title, filename: buildOfficeFilename(title, 'xlsx') })
      } else if (['html', 'html_multi', 'mermaid', 'chart'].includes(preview.type)) downloadBlob(buildHtmlDocument(preview.html), 'text/html;charset=utf-8', preview.filename)
      else if (preview.type === 'svg') downloadBlob(content, 'image/svg+xml;charset=utf-8', preview.filename)
      else if (preview.type === 'react') downloadBlob(content, 'text/jsx;charset=utf-8', preview.filename)
      else if (preview.type === 'text') downloadBlob(content, 'text/plain;charset=utf-8', preview.filename)
    } catch (error) { onMessage?.(error.message || t('chatPreview.exportFailed')) }
    finally { setDownloading(false); setPremiumProgress('') }
  }
  const handleEditablePptxDownload = async () => {
    if (preview.type !== 'pptx') return
    setPremiumExporting(true)
    try {
      const slides = parseMarkdownSlides(content)
      const title = slides[0]?.title || preview.title
      await downloadPptxFromMarkdown(content, { title, filename: buildPresentationFilename(title).replace('.pptx', '_editable.pptx') })
    } catch (error) { onMessage?.(error.message || t('chatPreview.editableExportFailed')) }
    finally { setPremiumExporting(false); setPremiumProgress('') }
  }
  const handleHtmlToPptx = async () => {
    if (preview.type !== 'html') return
    setPremiumExporting(true)
    try {
      const title = (preview.title || preview.filename || 'presentation').replace(/\.html$/i, '')
      await downloadHtmlDeckAsPptx(buildHtmlDocument(preview.html), { title, filename: buildPresentationFilename(title), onProgress: progress })
    } catch (error) { onMessage?.(error.message || t('chatPreview.pptxConvertFailed')) }
    finally { setPremiumExporting(false); setPremiumProgress('') }
  }
  return { downloading, premiumExporting, premiumProgress, handleDownload, handleEditablePptxDownload, handleHtmlToPptx }
}
