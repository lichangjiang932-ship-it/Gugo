import {
  Code,
  Code2,
  Copy,
  Download,
  Eye,
  FileText,
  Globe,
  Maximize2,
  Minimize2,
  Presentation,
  Sparkles,
  Table2,
  X,
} from 'lucide-react'
import { getArtifactToolbarActions } from './artifactToolbar.js'

function ArtifactIcon({ type }) {
  if (['html', 'html_multi', 'mermaid', 'chart', 'svg'].includes(type)) return <Globe className="w-4 h-4" />
  if (type === 'pptx') return <Presentation className="w-4 h-4" />
  if (type === 'xlsx') return <Table2 className="w-4 h-4" />
  if (type === 'react') return <Code2 className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

export function PreviewHeader({ preview, maximized, setMaximized, onClose, t }) {
  return (
    <div className="flex items-center gap-3 border-b border-dashed border-ink-fade/40 bg-paper px-4 py-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-ink-fade/40 bg-paper-2 text-ember">
        <ArtifactIcon type={preview.type} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember">{preview.label}</span>
          <span className="truncate text-[11px] text-ink-fade">{preview.summary}</span>
        </div>
        <div className="truncate text-sm font-semibold text-ink" title={preview.filename}>{preview.filename}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => setMaximized((value) => !value)} className="chat-preview-maximize-toggle flex h-8 w-8 items-center justify-center rounded-md text-ink-fade hover:bg-paper-2" title={t(maximized ? 'chatPreview.restore' : 'chatPreview.maximize')}>
          {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button type="button" onClick={onClose} aria-label={t('chatPreview.close')} className="flex h-10 w-10 items-center justify-center rounded-md bg-paper/80 text-ink-soft hover:bg-ember/10 hover:text-ember" title={t('chatPreview.close')}>
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export function PreviewToolbar({ preview, content, view, setView, exports, t }) {
  const actions = getArtifactToolbarActions(preview)
  const downloadLabel = exports.downloading
    ? (exports.premiumProgress ? t('chatPreview.generating', { progress: exports.premiumProgress }) : t('chatPreview.generatingShort'))
    : t(actions.downloadLabelKey)

  return (
    <div className="chat-preview-toolbar flex items-center justify-between gap-2 border-b border-ink-fade/20 bg-paper-2 px-4 py-2">
      <div className="inline-flex overflow-hidden rounded-md border border-ink-fade/40 text-[11px]">
        <Tab active={view === 'preview'} onClick={() => setView('preview')} icon={<Eye className="h-3 w-3" />} label={t('chatPreview.preview')} />
        <Tab active={view === 'source'} onClick={() => setView('source')} icon={<Code className="h-3 w-3" />} label={t('chatPreview.source')} bordered />
      </div>
      <div className="chat-preview-toolbar-actions flex items-center gap-1.5">
        {actions.canCopy && (
          <button type="button" onClick={() => navigator.clipboard?.writeText(content)} className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-fade/40 px-2 text-[11px] text-ink-soft">
            <Copy className="h-3 w-3" />{t('chatPreview.copy')}
          </button>
        )}
        {actions.canExportEditablePptx && (
          <button type="button" onClick={exports.handleEditablePptxDownload} disabled={exports.premiumExporting || exports.downloading} className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-fade/40 px-2 text-[11px] text-ink-soft disabled:opacity-50">
            <Sparkles className="h-3 w-3" />
            {exports.premiumExporting ? t('chatPreview.exporting', { progress: exports.premiumProgress }) : t('chatPreview.editable')}
          </button>
        )}
        {actions.canConvertToPptx && (
          <button type="button" onClick={exports.handleHtmlToPptx} disabled={exports.premiumExporting || exports.downloading} className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-fade/40 px-2 text-[11px] text-ink-soft disabled:opacity-50" title={t('chatPreview.convertTitle')}>
            <Presentation className="h-3 w-3" />
            {exports.premiumExporting ? t('chatPreview.converting', { progress: exports.premiumProgress }) : t('chatPreview.convertPptx')}
          </button>
        )}
        {actions.canDownload && (
          <button type="button" onClick={exports.handleDownload} disabled={exports.downloading || exports.premiumExporting} className="inline-flex h-7 items-center gap-1 rounded-md bg-ember px-2.5 text-[11px] text-paper disabled:opacity-50">
            <Download className="h-3 w-3" />{downloadLabel}
          </button>
        )}
      </div>
    </div>
  )
}

function Tab({ active, onClick, icon, label, bordered }) {
  return (
    <button type="button" onClick={onClick} className={`inline-flex items-center gap-1.5 px-3 py-1 ${bordered ? 'border-l border-ink-fade/40' : ''} ${active ? 'bg-ember text-paper' : 'text-ink-soft hover:bg-paper'}`}>
      {icon}{label}
    </button>
  )
}
