import { FileText, X } from 'lucide-react'

export default function ComposerAttachments({ attachments, onClear, onOpenImage, onRemove, t }) {
  if (!attachments.length) return null
  return <div className="mb-3 flex flex-wrap gap-2">
    {attachments.map((item) => <div key={item.id} className="flex max-w-[280px] flex-wrap items-center gap-2 rounded-md border border-ink-fade/40 bg-paper-2 px-2 py-1.5 text-xs text-ink-soft">
      {item.kind === 'image' && item.dataUrl ? <img src={item.dataUrl} alt={item.name} className="h-7 w-7 cursor-zoom-in rounded border border-ink-fade/30 object-cover" onClick={() => onOpenImage({ src: item.dataUrl, alt: item.name })} title={t('chatComposer.viewImage')} /> : <FileText className="h-4 w-4 shrink-0 text-ink-fade" />}
      <span className="min-w-0 flex-1 truncate">{item.name} · {item.sizeKB}KB</span>
      {item.error && <span className="text-ember" title={item.error}>!</span>}
      <button type="button" onClick={() => onRemove(item.id)} className="text-ink-fade hover:text-ink" title={t('chatComposer.removeAttachment')}><X className="h-3 w-3" /></button>
      {item.error && <p className="w-full text-[10px] leading-4 text-rose-700">{item.error}</p>}
    </div>)}
    <button type="button" onClick={onClear} className="rounded-md border border-dashed border-ink-fade/50 px-2 py-1.5 text-xs text-ink-fade hover:text-ink">{t('chatComposer.clearAttachments')}</button>
  </div>
}
