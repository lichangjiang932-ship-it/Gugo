import { ChevronRight, FolderOpen } from 'lucide-react'

export default function FileIdentity({ preview, t }) {
  const filePath = String(preview.path || preview.fullPath || '').trim()
  const segments = filePath.split(/[\\/]/u).filter(Boolean)
  const crumbs = segments.length > 4 ? [segments[0], '…', ...segments.slice(-2)] : segments
  return (
    <div className="chat-preview-file-identity min-w-0 flex-1">
      {filePath ? (
        <div data-testid="preview-file-path" aria-label={t('chatPreview.filePath', { path: filePath })}
          title={filePath} className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-ink-fade">
          <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {crumbs.map((crumb, index) => <span key={`${index}:${crumb}`} className="inline-flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span className={`truncate ${index === crumbs.length - 1 ? 'font-medium text-ink' : ''}`}>{crumb}</span>
          </span>)}
        </div>
      ) : <div className="truncate text-[13px] font-medium tracking-[-0.01em] text-ink" title={preview.filename}>{preview.filename}</div>}
      {preview.summary && <div className="mt-0.5 truncate text-[10px] text-ink-fade">{preview.summary}</div>}
    </div>
  )
}
