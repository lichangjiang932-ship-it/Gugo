import { CircleAlert, FileText, LoaderCircle, X } from 'lucide-react'

export default function ComposerAttachments({ attachments, onClear, onOpen, onRemove, t }) {
  if (!attachments.length) return null
  return <div className="mb-3 flex flex-wrap gap-2">
    {attachments.map((item) => <div key={item.id} className="flex max-w-[280px] flex-wrap items-center gap-2 rounded-control border border-ink-fade/40 bg-paper-2 px-2 py-1.5 text-xs text-ink-soft">
      {item.kind === 'image' && item.dataUrl ? <button type="button" onClick={() => onOpen?.(item)} className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/45" title={t('chatComposer.viewImage')}><img src={item.dataUrl} alt={item.name} className="h-7 w-7 rounded border border-ink-fade/30 object-cover" /></button> : <FileText className="h-4 w-4 shrink-0 text-ink-fade" />}
      <span className="min-w-0 flex-1 truncate">{item.name} · {item.sizeKB}KB</span>
      {item.uploadStatus === 'uploading' && <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-ember" aria-label={t('chatAttachments.uploading')} />}
      {item.uploadStatus === 'error' && <CircleAlert className="h-3.5 w-3.5 shrink-0 text-rose-700" aria-label={t('chatAttachments.uploadFailed')} />}
      <button type="button" onClick={() => onRemove(item.id)} className="text-ink-fade hover:text-ink" title={t('chatComposer.removeAttachment')}><X className="h-3 w-3" /></button>
      {item.uploadStatus === 'uploading' && <p className="w-full text-xs leading-4 text-ink-fade">{t('chatAttachments.uploading')}</p>}
      {item.uploadStatus === 'error' && <p className="w-full text-xs leading-4 text-rose-700">{t('chatAttachments.uploadFailed')}{item.uploadError ? `：${item.uploadError}` : ''}</p>}
    </div>)}
    <button type="button" onClick={onClear} className="rounded-control border border-dashed border-ink-fade/50 px-2 py-1.5 text-xs text-ink-fade hover:text-ink">{t('chatComposer.clearAttachments')}</button>
  </div>
}
