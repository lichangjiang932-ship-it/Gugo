import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Download, Copy, Maximize2, Minimize2, Code, Eye, FileText, Table2, Presentation, Globe } from 'lucide-react'
import {
  buildPresentationFilename,
  downloadPptxFromMarkdown,
  parseMarkdownSlides,
} from '../../lib/presentationExport.js'
import {
  buildOfficeFilename,
  downloadDocxFromMarkdown,
  downloadXlsxFromMarkdown,
  parseMarkdownDocument,
  parseSpreadsheetRows,
} from '../../lib/officeExport.js'
import { buildHtmlDocument } from '../../lib/artifactPreview.js'

function ArtifactIcon({ type }) {
  if (type === 'html') return <Globe className="w-4 h-4" />
  if (type === 'pptx') return <Presentation className="w-4 h-4" />
  if (type === 'xlsx') return <Table2 className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

function HtmlPreview({ html }) {
  const srcDoc = useMemo(() => buildHtmlDocument(html), [html])
  return (
    <iframe
      title="HTML 预览"
      // SECURITY: 只给 allow-scripts + allow-forms + allow-modals。绝不加 allow-same-origin —
      // srcdoc 文档默认是 opaque origin,加上后会让脚本访问父页 storage/cookie + 逃逸沙箱。
      // 工件页面如需调用外部 API,通过 postMessage 让父页代理。
      sandbox="allow-scripts allow-forms allow-modals"
      // 可选:再加 referrerpolicy 防泄漏来源
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="w-full h-full border-0 bg-white"
    />
  )
}

function PptxPreview({ slides }) {
  return (
    <div className="grid grid-cols-1 gap-3 p-4 overflow-auto h-full">
      {slides.map((slide, index) => (
        <div
          key={`${slide.title}-${index}`}
          className="aspect-video rounded-md border border-ink-fade/30 bg-paper overflow-hidden flex flex-col shadow-sm"
        >
          <div className="h-1 bg-ember" />
          <div className="p-4 flex-1 min-h-0 flex flex-col gap-2">
            <div className="text-[10px] font-mono text-ink-fade">SLIDE {index + 1}</div>
            <div className="font-semibold text-ink text-base leading-snug break-words">
              {slide.title}
            </div>
            <div className="flex flex-col gap-1.5 text-xs text-ink-soft leading-relaxed mt-1">
              {slide.bullets.slice(0, 8).map((bullet, bulletIndex) => (
                <div key={bulletIndex} className="grid grid-cols-[10px_1fr] gap-1.5">
                  <span className="text-ember">•</span>
                  <span className="break-words">{bullet}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function DocxPreview({ blocks, title }) {
  return (
    <div className="overflow-auto h-full bg-paper">
      <div className="max-w-[720px] mx-auto px-10 py-8">
        <div className="font-display text-3xl text-ink leading-tight mb-6 break-words">{title}</div>
        <div className="space-y-3 text-sm text-ink-soft leading-relaxed">
          {blocks.map((block, index) => {
            if (block.type === 'heading' || block.type === 'title') {
              return (
                <div key={index} className="pt-3 font-semibold text-ink text-base break-words">
                  {block.text}
                </div>
              )
            }
            if (block.type === 'bullet') {
              return (
                <div key={index} className="grid grid-cols-[14px_1fr] gap-1.5">
                  <span className="text-ember">•</span>
                  <span className="break-words">{block.text}</span>
                </div>
              )
            }
            return (
              <p key={index} className="break-words">
                {block.text}
              </p>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function XlsxPreview({ rows }) {
  const header = rows[0] || []
  const body = rows.slice(1)
  return (
    <div className="overflow-auto h-full bg-paper">
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 bg-paper-2 border-b border-r border-ink-fade/30 px-2 py-1.5 text-[10px] text-ink-fade font-mono">
              #
            </th>
            {header.map((cell, index) => (
              <th
                key={index}
                className="sticky top-0 z-10 bg-paper-2 border-b border-r border-ink-fade/30 px-3 py-1.5 text-left font-semibold text-ink whitespace-nowrap"
              >
                {cell || `Column ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex % 2 ? 'bg-paper-2/30' : 'bg-paper'}>
              <td className="sticky left-0 z-10 bg-paper-2/60 border-b border-r border-ink-fade/30 px-2 py-1.5 text-[10px] text-ink-fade font-mono text-right">
                {rowIndex + 1}
              </td>
              {header.map((_, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border-b border-r border-ink-fade/20 px-3 py-1.5 text-ink-soft max-w-[260px] truncate"
                  title={row[cellIndex] || ''}
                >
                  {row[cellIndex] || ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SourceView({ content }) {
  return (
    <pre className="h-full overflow-auto bg-paper p-4 text-xs leading-relaxed text-ink-soft whitespace-pre-wrap font-mono">
      {content}
    </pre>
  )
}

export default function RightPreviewPane({ artifact, onClose, onMessage }) {
  const [view, setView] = useState('preview') // 'preview' | 'source'
  const [downloading, setDownloading] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const previousArtifactKey = useRef('')

  // 切换 artifact 时复位视图状态
  useEffect(() => {
    const key = `${artifact?.messageId || ''}:${artifact?.preview?.type || ''}`
    if (key !== previousArtifactKey.current) {
      previousArtifactKey.current = key
      setView('preview')
      setDownloading(false)
    }
  }, [artifact])

  if (!artifact || !artifact.preview) return null
  const { preview, content } = artifact

  const handleDownload = async () => {
    setDownloading(true)
    try {
      if (preview.type === 'pptx') {
        const slides = parseMarkdownSlides(content)
        const title = slides[0]?.title || preview.title
        await downloadPptxFromMarkdown(content, {
          title,
          filename: buildPresentationFilename(title),
        })
      } else if (preview.type === 'docx') {
        const doc = parseMarkdownDocument(content)
        await downloadDocxFromMarkdown(content, {
          title: doc.title,
          filename: buildOfficeFilename(doc.title, 'docx'),
        })
      } else if (preview.type === 'xlsx') {
        const rows = parseSpreadsheetRows(content)
        const title = rows[0]?.find((cell) => String(cell || '').trim()) || preview.title
        await downloadXlsxFromMarkdown(content, {
          title,
          filename: buildOfficeFilename(title, 'xlsx'),
        })
      } else if (preview.type === 'html') {
        const blob = new Blob([buildHtmlDocument(preview.html)], { type: 'text/html;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = preview.filename
        document.body.appendChild(a)
        a.click()
        setTimeout(() => {
          URL.revokeObjectURL(url)
          a.remove()
        }, 100)
      }
    } catch (err) {
      // ★ #26: 统一通过外层 toast 通道,避免阻塞式 alert
      onMessage?.(err.message || '导出失败')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        key="preview-pane"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className={`${
          maximized ? 'fixed inset-0 z-40 w-screen' : 'w-[520px]'
        } bg-paper-2 flex flex-col border-l border-dashed border-ink-fade/50 overflow-hidden`}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-dashed border-ink-fade/40 bg-paper">
          <div className="w-8 h-8 rounded-md border border-ink-fade/40 bg-paper-2 flex items-center justify-center text-ember shrink-0">
            <ArtifactIcon type={preview.type} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember">
                {preview.label}
              </span>
              <span className="text-[11px] text-ink-fade truncate">{preview.summary}</span>
            </div>
            <div className="font-semibold text-ink text-sm truncate" title={preview.filename}>
              {preview.filename}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setMaximized((v) => !v)}
              className="w-8 h-8 rounded-md hover:bg-paper-2 transition-colors flex items-center justify-center text-ink-fade hover:text-ink"
              title={maximized ? '还原' : '最大化'}
            >
              {maximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-md hover:bg-paper-2 transition-colors flex items-center justify-center text-ink-fade hover:text-ink"
              title="关闭预览"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-ink-fade/20 bg-paper-2">
          <div className="inline-flex border border-ink-fade/40 rounded-md overflow-hidden text-[11px]">
            <button
              onClick={() => setView('preview')}
              className={`px-3 py-1 inline-flex items-center gap-1.5 transition-colors ${
                view === 'preview' ? 'bg-ember text-paper' : 'text-ink-soft hover:bg-paper'
              }`}
            >
              <Eye className="w-3 h-3" />
              预览
            </button>
            <button
              onClick={() => setView('source')}
              className={`px-3 py-1 inline-flex items-center gap-1.5 transition-colors border-l border-ink-fade/40 ${
                view === 'source' ? 'bg-ember text-paper' : 'text-ink-soft hover:bg-paper'
              }`}
            >
              <Code className="w-3 h-3" />
              源
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => navigator.clipboard?.writeText(content)}
              className="h-7 px-2 rounded-md border border-ink-fade/40 text-ink-soft hover:bg-paper transition-colors inline-flex items-center gap-1 text-[11px]"
              title="复制源内容"
            >
              <Copy className="w-3 h-3" />
              复制
            </button>
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="h-7 px-2.5 rounded-md bg-ember text-paper hover:bg-ember/90 transition-colors inline-flex items-center gap-1 text-[11px] disabled:opacity-50"
              title={`下载 ${preview.filename}`}
            >
              <Download className="w-3 h-3" />
              {downloading ? '生成中' : '下载'}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {view === 'source' ? (
            <SourceView content={content} />
          ) : (
            <>
              {preview.type === 'html' && <HtmlPreview html={preview.html} />}
              {preview.type === 'pptx' && <PptxPreview slides={preview.slides} />}
              {preview.type === 'docx' && <DocxPreview blocks={preview.blocks} title={preview.title} />}
              {preview.type === 'xlsx' && <XlsxPreview rows={preview.rows} />}
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
