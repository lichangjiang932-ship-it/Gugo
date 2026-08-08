import {
  Code,
  Code2,
  Copy,
  Download,
  Eye,
  FileImage,
  FileText,
  FileType2,
  Globe,
  Maximize2,
  Minimize2,
  Presentation,
  Sparkles,
  Table2,
  X,
} from 'lucide-react'
import { getArtifactToolbarActions } from './artifactToolbar.js'
import { copyTextToClipboard } from '../../../lib/clipboard.js'

export function ArtifactIcon({ type }) {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(type)) return <FileImage className="h-4 w-4" />
  if (type === 'pdf') return <FileType2 className="h-4 w-4" />
  if (['html', 'html_multi', 'mermaid', 'chart', 'svg'].includes(type)) return <Globe className="w-4 h-4" />
  if (type === 'pptx') return <Presentation className="w-4 h-4" />
  if (type === 'xlsx') return <Table2 className="w-4 h-4" />
  if (type === 'react') return <Code2 className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

export function PreviewHeader({ preview, maximized, setMaximized, onClose, t }) {
  return (
    <div data-testid="preview-tab-bar" className="chat-preview-tabbar flex h-12 shrink-0 items-center gap-2 border-b border-ink/10 bg-paper px-3">
      <div className="chat-preview-active-tab flex h-8 min-w-0 max-w-[min(68%,24rem)] items-center gap-2 rounded-lg border border-ink/10 bg-paper-2 px-2.5 text-ink shadow-sm">
        <span className="shrink-0 text-ember"><ArtifactIcon type={preview.type} /></span>
        <span className="truncate text-xs font-medium" title={preview.filename}>{preview.filename}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={() => setMaximized((value) => !value)} aria-label={t(maximized ? 'chatPreview.restore' : 'chatPreview.maximize')} className="chat-preview-maximize-toggle flex h-8 w-8 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-paper-2 hover:text-ink" title={t(maximized ? 'chatPreview.restore' : 'chatPreview.maximize')}>
          {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button type="button" onClick={onClose} aria-label={t('chatPreview.close')} className="flex h-10 w-10 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-paper-2 hover:text-ember" title={t('chatPreview.close')}>
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
    <div data-testid="preview-command-bar" className="chat-preview-toolbar flex min-h-14 shrink-0 items-center gap-3 border-b border-ink/10 bg-paper px-3 py-2">
      <FileIdentity preview={preview} />
      <div className="chat-preview-toolbar-actions ml-auto flex shrink-0 items-center gap-1.5">
        <div className="inline-flex h-8 overflow-hidden rounded-lg border border-ink/10 bg-paper-2 text-[11px]">
          <Tab active={view === 'preview'} onClick={() => setView('preview')} icon={<Eye className="h-3.5 w-3.5" />} label={t('chatPreview.preview')} />
          <Tab active={view === 'source'} onClick={() => setView('source')} icon={<Code className="h-3.5 w-3.5" />} label={t('chatPreview.source')} bordered />
        </div>
        {actions.canCopy && (
          <ActionButton onClick={() => copyTextToClipboard(content).catch(() => {})} icon={<Copy className="h-3.5 w-3.5" />} label={t('chatPreview.copy')} compact />
        )}
        {actions.canExportEditablePptx && (
          <ActionButton onClick={exports.handleEditablePptxDownload} disabled={exports.premiumExporting || exports.downloading} icon={<Sparkles className="h-3.5 w-3.5" />} label={exports.premiumExporting ? t('chatPreview.exporting', { progress: exports.premiumProgress }) : t('chatPreview.editable')} compact />
        )}
        {actions.canConvertToPptx && (
          <ActionButton onClick={exports.handleHtmlToPptx} disabled={exports.premiumExporting || exports.downloading} icon={<Presentation className="h-3.5 w-3.5" />} label={exports.premiumExporting ? t('chatPreview.converting', { progress: exports.premiumProgress }) : t('chatPreview.convertPptx')} compact />
        )}
        {actions.canDownload && (
          <ActionButton onClick={exports.handleDownload} disabled={exports.downloading || exports.premiumExporting} icon={<Download className="h-3.5 w-3.5" />} label={downloadLabel} primary />
        )}
      </div>
    </div>
  )
}

export function DirectFileToolbar({ filename, type, summary, url, t }) {
  const preview = { filename, label: type.toUpperCase(), summary }
  return (
    <div data-testid="preview-command-bar" className="chat-preview-toolbar flex min-h-14 shrink-0 items-center gap-3 border-b border-ink/10 bg-paper px-3 py-2">
      <FileIdentity preview={preview} />
      {url && (
        <a href={url} download={filename} className="ml-auto inline-flex h-8 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-lg bg-ember px-3 text-[11px] font-medium text-paper shadow-sm transition-colors hover:brightness-95">
          <Download className="h-3.5 w-3.5" />
          <span className="truncate">{t('chatPreview.download', { filename })}</span>
        </a>
      )}
    </div>
  )
}

function FileIdentity({ preview }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-semibold tracking-[-0.01em] text-ink" title={preview.filename}>{preview.filename}</div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-ink-fade">
        <span className="shrink-0 font-mono uppercase tracking-[0.14em] text-ember">{preview.label}</span>
        {preview.summary && <><span aria-hidden="true" className="text-ink-ghost">·</span><span className="truncate">{preview.summary}</span></>}
      </div>
    </div>
  )
}

function ActionButton({ compact = false, disabled, icon, label, onClick, primary = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${primary ? 'bg-ember text-paper shadow-sm hover:brightness-95' : 'border border-ink/10 bg-paper text-ink-soft hover:bg-paper-2 hover:text-ink'} ${compact ? 'chat-preview-compact-action' : ''}`}
    >
      {icon}<span className={compact ? 'chat-preview-action-label' : ''}>{label}</span>
    </button>
  )
}

function Tab({ active, onClick, icon, label, bordered }) {
  return (
    <button type="button" onClick={onClick} className={`inline-flex items-center gap-1.5 px-2.5 ${bordered ? 'border-l border-ink/10' : ''} ${active ? 'bg-paper text-ink shadow-sm' : 'text-ink-fade hover:text-ink'}`}>
      {icon}{label}
    </button>
  )
}
