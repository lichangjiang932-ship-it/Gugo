import { Sparkles, X } from 'lucide-react'

export default function AgentTemplateModal({ loading, onClose, onPreview, onUse, preview, source, templates, t }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-canvas shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-ink/10 px-6 py-4">
          <h2 className="text-base font-medium">{t('agents.templatesTitle')}</h2>
          <button onClick={onClose} className="p-1 text-ink-fade hover:text-ink"><X size={16} /></button>
        </header>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="w-64 shrink-0 overflow-y-auto border-r border-ink/10">
            {templates.length === 0 ? <p className="p-4 text-sm text-ink-fade">{t('agents.templatesEmpty')}</p> : (
              <ul className="divide-y divide-ink/10">
                {templates.map((template) => (
                  <li key={template.id} onClick={() => onPreview(template)} className={`cursor-pointer px-4 py-3 hover:bg-ink/5 ${preview?.id === template.id ? 'bg-ink/5' : ''}`}>
                    <div className="text-sm font-medium">{template.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-xs text-ink-fade">{template.description}</div>
                    <div className="mt-1 font-mono text-[10px] text-ink-fade">{template.id} v{template.version}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
            {!preview ? <p className="text-sm text-ink-fade">{t('agents.templatesHint')}</p> : loading ? <p className="text-sm text-ink-fade">{t('common.loading')}</p> : <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink">{source}</pre>}
          </div>
        </div>
        {preview && (
          <footer className="flex items-center justify-end gap-2 border-t border-ink/10 px-6 py-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-ink-fade hover:text-ink">{t('common.cancel')}</button>
            <button onClick={() => onUse(preview)} className="inline-flex items-center gap-2 rounded bg-ink px-4 py-2 text-sm text-canvas hover:opacity-90"><Sparkles size={14} />{t('agents.useThis')}</button>
          </footer>
        )}
      </div>
    </div>
  )
}
