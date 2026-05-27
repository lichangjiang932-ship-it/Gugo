import { AlertTriangle, Check, FileDiff, FilePlus2, FileX2, Loader2, Minus, PencilLine, Plus, X } from 'lucide-react'
import { useEffect } from 'react'
import { useT } from '../i18n/I18nProvider.jsx'

function opMeta(op, t) {
  const normalized = String(op || '').toLowerCase()
  if (normalized === 'add') {
    return {
      label: t('applyPatchApproval.opAdd'),
      icon: <FilePlus2 className="w-4 h-4" />,
      className: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    }
  }
  if (normalized === 'delete') {
    return {
      label: t('applyPatchApproval.opDelete'),
      icon: <FileX2 className="w-4 h-4" />,
      className: 'bg-rose-100 text-rose-700 border-rose-200',
    }
  }
  return {
    label: t('applyPatchApproval.opUpdate'),
    icon: <PencilLine className="w-4 h-4" />,
    className: 'bg-amber-100 text-amber-700 border-amber-200',
  }
}

function previewText(preview) {
  if (Array.isArray(preview)) return preview.join('\n')
  return String(preview || '')
}

export default function ApplyPatchApprovalModal({ open, changes, onApprove, onReject, busy }) {
  const { t } = useT()
  const items = Array.isArray(changes) ? changes : []
  const total = items.length
  const previewedItems = items.map((change) => {
    const text = previewText(change?.preview)
    const lines = text.split('\n')
    return {
      ...change,
      previewText: lines.slice(0, 200).join('\n'),
      truncated: lines.length > 200,
    }
  })

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onReject?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onReject, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/35 px-4 py-6 backdrop-blur-sm">
      <div className="flex max-h-[min(760px,calc(100vh-48px))] w-full max-w-4xl flex-col overflow-hidden rounded-md border border-ink/15 bg-paper shadow-2xl">
        <div className="flex items-start gap-3 border-b border-ink/10 bg-paper-2 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-ember-soft text-ember">
            <FileDiff className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">{t('applyPatchApproval.title')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-fade">
              {t('applyPatchApproval.subtitle', { count: total })}
            </p>
          </div>
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('applyPatchApproval.reject')}
            title={t('applyPatchApproval.reject')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {previewedItems.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-ink/10 bg-paper-2 px-4 py-3 text-sm text-ink-soft">
              <AlertTriangle className="h-4 w-4 text-ember" />
              {t('applyPatchApproval.noChanges')}
            </div>
          ) : (
            <div className="space-y-3">
              {previewedItems.map((change, index) => {
                const meta = opMeta(change?.op, t)
                const added = Number(change?.stats?.added || 0)
                const removed = Number(change?.stats?.removed || 0)
                return (
                  <section key={`${change?.path || 'change'}-${index}`} className="overflow-hidden rounded-md border border-ink/10 bg-paper-2">
                    <div className="flex flex-wrap items-center gap-2 border-b border-ink/10 px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${meta.className}`}>
                        {meta.icon}
                        {meta.label}
                      </span>
                      <code className="min-w-0 flex-1 truncate text-xs text-ink" title={change?.path || ''}>
                        {change?.path || t('applyPatchApproval.unknownPath')}
                      </code>
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                        <Plus className="h-3.5 w-3.5" />
                        {t('applyPatchApproval.addedLines', { count: added })}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs text-rose-700">
                        <Minus className="h-3.5 w-3.5" />
                        {t('applyPatchApproval.removedLines', { count: removed })}
                      </span>
                    </div>
                    <pre className="max-h-72 overflow-auto bg-paper px-4 py-3 font-mono text-xs leading-relaxed text-ink-soft whitespace-pre-wrap">
                      {change.previewText || t('applyPatchApproval.emptyPreview')}
                    </pre>
                    {change.truncated && (
                      <div className="border-t border-ink/10 px-4 py-2 text-xs text-ink-fade">
                        {t('applyPatchApproval.previewTruncated')}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-ink/10 bg-paper-2 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-ink/15 bg-paper px-4 text-sm font-medium text-ink-soft transition-colors hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
            {t('applyPatchApproval.reject')}
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-medium text-paper transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {busy ? t('applyPatchApproval.applying') : t('applyPatchApproval.approve')}
          </button>
        </div>
      </div>
    </div>
  )
}
