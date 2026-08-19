import { ChevronDown, Copy, Download, FileText, Maximize2, Table2 } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n/I18nProvider.jsx'

function ArtifactIcon({ type }) {
  if (type === 'xlsx') return <Table2 className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

function PptPreview({ preview }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {preview.slides.map((slide, index) => (
        <div key={`${slide.title}-${index}`} className="aspect-video rounded-card border border-ink-fade/30 bg-paper overflow-hidden flex flex-col">
          <div className="h-1 bg-ember" />
          <div className="p-3 flex-1 min-h-0 flex flex-col gap-2">
            <div className="text-xs font-mono text-ink-fade tabular-nums">{index + 1}</div>
            <div className="font-semibold text-ink text-sm leading-snug break-words line-clamp-2">{slide.title}</div>
            <div className="flex flex-col gap-1 text-xs text-ink-soft leading-snug overflow-hidden">
              {slide.bullets.slice(0, 4).map((bullet, bulletIndex) => (
                <div key={bulletIndex} className="grid grid-cols-[10px_1fr] gap-1">
                  <span className="text-ember">•</span>
                  <span className="break-words line-clamp-2">{bullet}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function DocPreview({ preview }) {
  return (
    <div className="bg-paper border border-ink-fade/30 rounded-card px-6 py-5 max-h-[420px] overflow-hidden shadow-sm">
      <div className="font-display text-2xl text-ink leading-tight mb-4 break-words">{preview.title}</div>
      <div className="space-y-2.5 text-sm text-ink-soft leading-relaxed">
        {preview.blocks.map((block, index) => {
          if (block.type === 'heading' || block.type === 'title') {
            return <div key={index} className="pt-2 font-semibold text-ink break-words">{block.text}</div>
          }
          if (block.type === 'bullet') {
            return (
              <div key={index} className="grid grid-cols-[14px_1fr] gap-1">
                <span className="text-ember">•</span>
                <span className="break-words">{block.text}</span>
              </div>
            )
          }
          return <p key={index} className="break-words">{block.text}</p>
        })}
      </div>
    </div>
  )
}

function SheetPreview({ preview }) {
  const header = preview.rows[0] || []
  const rows = preview.rows.slice(1)

  return (
    <div className="border border-ink-fade/30 rounded-card overflow-auto max-h-[420px] bg-paper">
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={index} className="sticky top-0 bg-paper-2 border-b border-r border-ink-fade/30 px-3 py-2 text-left font-semibold text-ink whitespace-nowrap">
                {cell || `Column ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex % 2 ? 'bg-paper-2/30' : 'bg-paper'}>
              {header.map((_, cellIndex) => (
                <td key={cellIndex} className="border-b border-r border-ink-fade/20 px-3 py-2 text-ink-soft max-w-[220px] truncate">
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

export default function ArtifactPreview({ preview, content, downloading, onDownload, onCopySource, onExpand }) {
  const { t } = useT()
  const [showSource, setShowSource] = useState(false)

  return (
    <div className="w-full overflow-hidden rounded-card border border-ink-fade/30 bg-paper-2 shadow-sm" data-artifact-surface="inline-preview">
      <div className="flex flex-wrap items-center gap-3 border-b border-dashed border-ink-fade/40 px-4 py-3">
        <div className="w-9 h-9 rounded-control border border-ink-fade/50 bg-paper flex items-center justify-center text-ink-soft shrink-0">
          <ArtifactIcon type={preview.type} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs uppercase tracking-[0.18em] text-ink-fade">{preview.label}</span>
            <span className="text-xs text-ink-fade">{preview.summary}</span>
          </div>
          <div className="font-semibold text-ink text-sm truncate">{preview.filename}</div>
        </div>
        <button
          onClick={onDownload}
          disabled={downloading}
          className="h-8 px-3 rounded-control border border-ember-line text-ember hover:bg-ember-soft transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 text-xs"
          title={t('artifact.downloadTitle', { filename: preview.filename })}
        >
          <Download className="w-3.5 h-3.5" />
          {downloading ? t('artifact.generating') : t('artifact.download')}
        </button>
        <button
          type="button"
          onClick={() => onExpand?.()}
          className="h-8 px-3 rounded-control border border-ink-fade/40 text-ink-soft hover:bg-paper hover:text-ember hover:border-ember/40 transition-colors inline-flex items-center gap-1.5 text-xs"
          title={t('artifact.openPanel')}
        >
          <Maximize2 className="w-3.5 h-3.5" />
          {t('artifact.openPanel')}
        </button>
      </div>

      <div className="p-4">
        {preview.type === 'pptx' && <PptPreview preview={preview} />}
        {preview.type === 'docx' && <DocPreview preview={preview} />}
        {preview.type === 'xlsx' && <SheetPreview preview={preview} />}
      </div>

      <div className="border-t border-dashed border-ink-fade/40 px-4 py-2 flex flex-wrap items-center gap-2 text-xs text-ink-fade">
        <button
          onClick={() => setShowSource((value) => !value)}
          className="inline-flex items-center gap-1 hover:text-ink transition-colors"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSource ? 'rotate-180' : ''}`} />
              {t('artifact.source')}
        </button>
        <button
          onClick={onCopySource}
          className="inline-flex items-center gap-1 hover:text-ink transition-colors"
        >
          <Copy className="w-3.5 h-3.5" />
              {t('artifact.copy')}
        </button>
      </div>

      {showSource && (
        <pre className="max-h-64 overflow-auto border-t border-dashed border-ink-fade/40 bg-paper p-3 text-xs leading-relaxed text-ink-soft whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </div>
  )
}
