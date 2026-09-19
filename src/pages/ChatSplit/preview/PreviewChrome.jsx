import { useEffect, useRef } from 'react'
import {
  Code,
  ArrowLeft,
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
import { canViewDirectFileSource } from '../../../lib/directFileSource.js'
import FileIdentity from './FileIdentity.jsx'
import FileActions from './FileActions.jsx'

export function ArtifactIcon({ type }) {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(type)) return <FileImage className="h-4 w-4" />
  if (type === 'pdf') return <FileType2 className="h-4 w-4" />
  if (['html', 'html_multi', 'mermaid', 'chart', 'svg'].includes(type)) return <Globe className="w-4 h-4" />
  if (type === 'pptx') return <Presentation className="w-4 h-4" />
  if (type === 'xlsx') return <Table2 className="w-4 h-4" />
  if (type === 'react') return <Code2 className="w-4 h-4" />
  return <FileText className="w-4 h-4" />
}

export function PreviewHeader({ tabs, activeId, maximized, focused = false, setMaximized, onSelectTab, onCloseTab, onClose, t }) {
  const activeTabRef = useRef(null)
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const handleTabKeyDown = (event, index) => {
    let nextIndex = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    if (nextIndex === index) return
    onSelectTab(tabs[nextIndex].id)
    const buttons = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]')
    buttons?.[nextIndex]?.focus()
  }

  return (
    <div data-testid="preview-header" className="chat-preview-tabbar flex h-10 shrink-0 items-center gap-1.5 border-b border-ink/10 bg-paper px-2.5">
      {focused && <button type="button" data-testid="preview-back-to-chat" onClick={onClose} aria-label={t('chatPreview.backToChat')} title={t('chatPreview.backToChat')} className="chat-preview-back-button inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-ink-soft outline-none hover:bg-paper-2 focus-visible:ring-2 focus-visible:ring-ink/25">
        <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="chat-preview-back-label">{t('chatPreview.backToChat')}</span>
      </button>}
      <div role="tablist" aria-label={t('chatPreview.openTabs')} className="chat-preview-tabs flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          return (
            <div
              key={tab.id}
              data-testid="preview-tab-item"
              className={`chat-preview-tab-item flex h-[30px] min-w-0 flex-none items-center rounded-md border transition-colors ${active ? 'chat-preview-active-tab border-ink/10 bg-ink/[0.055] text-ink' : 'border-transparent text-ink-fade hover:bg-ink/[0.035] hover:text-ink'}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={tab.preview.filename}
                tabIndex={active ? 0 : -1}
                ref={active ? activeTabRef : null}
                data-testid="preview-tab"
                onClick={() => onSelectTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-md pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ink/25"
                title={tab.preview.filename}
              >
                <span className={`shrink-0 ${active ? 'text-ink-soft' : 'text-ink-fade'}`}><ArtifactIcon type={tab.preview.type} /></span>
                <span className="min-w-0 truncate text-xs font-medium">{tab.preview.filename}</span>
              </button>
              <button
                type="button"
                data-testid="preview-tab-close"
                onClick={(event) => { event.stopPropagation(); onCloseTab(tab.id) }}
                aria-label={t('chatPreview.closeTab', { filename: tab.preview.filename })}
                title={t('chatPreview.closeTab', { filename: tab.preview.filename })}
                className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-fade outline-none transition-colors hover:bg-ink/[0.065] hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/25"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={() => setMaximized((value) => !value)} aria-pressed={maximized} aria-label={t(maximized ? 'chatPreview.restore' : 'chatPreview.maximize')} className="chat-preview-maximize-toggle flex h-8 w-8 items-center justify-center rounded-md text-ink-fade outline-none transition-colors hover:bg-paper-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/25" title={t(maximized ? 'chatPreview.restore' : 'chatPreview.maximize')}>
          {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button type="button" data-testid="preview-close" onClick={onClose} aria-label={t('chatPreview.close')} className="flex h-10 w-10 items-center justify-center rounded-md text-ink-soft outline-none transition-colors hover:bg-paper-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/25" title={t('chatPreview.close')}>
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
    <div data-testid="preview-command-bar" className="chat-preview-toolbar flex min-h-11 shrink-0 items-center gap-3 border-b border-ink/10 bg-paper px-3 py-1.5">
      <FileIdentity preview={preview} t={t} />
      <div className="chat-preview-toolbar-actions ml-auto flex shrink-0 items-center gap-1.5">
        <div className="inline-flex h-8 overflow-hidden rounded-lg border border-ink/10 bg-paper-2 text-xs">
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
          <ActionButton onClick={exports.handleDownload} disabled={exports.downloading || exports.premiumExporting} icon={<Download className="h-3.5 w-3.5" />} label={downloadLabel} />
        )}
      </div>
    </div>
  )
}

export function DirectFileToolbar({ filename, type, file = {}, url, view = 'preview', setView, t }) {
  const preview = { ...file, filename, label: type.toUpperCase() }
  return (
    <div data-testid="preview-command-bar" className="chat-preview-toolbar chat-direct-file-toolbar flex min-h-11 shrink-0 items-center gap-3 border-b border-ink/10 bg-paper px-3 py-1.5">
      <FileIdentity preview={preview} t={t} />
      {setView && canViewDirectFileSource(preview) && <div className="inline-flex h-8 shrink-0 overflow-hidden rounded-lg border border-ink/10 bg-paper-2 text-xs">
        <Tab active={view === 'preview'} onClick={() => setView('preview')} icon={<Eye className="h-3.5 w-3.5" />} label={t('chatPreview.preview')} />
        <Tab active={view === 'source'} onClick={() => setView('source')} icon={<Code className="h-3.5 w-3.5" />} label={t('chatPreview.source')} bordered />
      </div>}
      <FileActions key={`${file.url || url}:${file.path || ''}:${file.previewRevision || ''}`} file={{ ...preview, url: file.url || url }} url={url} setView={setView} t={t} />
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
      className={`inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${primary ? 'bg-ink text-paper hover:bg-ink-soft' : 'border border-ink/10 bg-paper text-ink-soft hover:bg-paper-2 hover:text-ink'} ${compact ? 'chat-preview-compact-action' : ''}`}
    >
      {icon}<span className={compact ? 'chat-preview-action-label' : ''}>{label}</span>
    </button>
  )
}

function Tab({ active, onClick, icon, label, bordered }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`inline-flex items-center gap-1.5 px-2.5 ${bordered ? 'border-l border-ink/10' : ''} ${active ? 'bg-paper text-ink shadow-sm' : 'text-ink-fade hover:text-ink'}`}>
      {icon}{label}
    </button>
  )
}
