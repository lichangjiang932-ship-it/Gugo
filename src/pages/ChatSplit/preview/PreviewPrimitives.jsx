import { ExternalLink, RefreshCw } from 'lucide-react'

export function RetryPreviewButton({ onClick, t }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-control border border-ink/10 bg-paper px-3 text-xs font-medium text-ink-soft hover:bg-paper-2 hover:text-ink"
    >
      <RefreshCw className="h-3.5 w-3.5" />
      {t('chatPreview.retryPreview')}
    </button>
  )
}

export function OpenOriginalLink({ t, url }) {
  if (!url) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 items-center gap-1.5 rounded-control border border-ink/10 bg-paper px-3 text-xs font-medium text-ink-soft hover:bg-paper-2 hover:text-ink"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {t('chatPreview.openOriginal')}
    </a>
  )
}

export function PreviewFallbackActions({ onRetry, t, url }) {
  return (
    <span className="flex flex-wrap items-center justify-center gap-2">
      <RetryPreviewButton onClick={onRetry} t={t} />
      <OpenOriginalLink url={url} t={t} />
    </span>
  )
}

export function PreviewStatus({ icon, text, detail = '', action = null, errorCode = '' }) {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center text-ink-fade" role="status" data-error-code={errorCode || undefined}>
      <span className="flex h-14 w-14 items-center justify-center rounded-card border border-ink/10 bg-paper shadow-sm">{icon}</span>
      <p className="max-w-sm text-sm font-medium text-ink-soft">{text}</p>
      {detail && <p className="max-w-sm break-words text-xs leading-relaxed text-ink-fade">{detail}</p>}
      {action}
    </div>
  )
}
