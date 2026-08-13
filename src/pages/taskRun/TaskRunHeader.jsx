export default function TaskRunHeader({ prompt, setPrompt, submitting, error, onCreate, t }) {
  return (
    <header className="px-7 py-5 border-b border-dashed border-ink-fade/40">
      <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{t('taskCenter.kicker')}</span>
      <h1 className="font-semibold text-[28px] text-ink mt-1.5">{t('taskCenter.title')}</h1>
      <form onSubmit={onCreate} className="mt-4 flex gap-2">
        <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t('taskCenter.prompt')} className="flex-1 h-11 px-4 rounded-md border border-ink/30 bg-paper outline-none focus:border-ember text-sm" />
        <button type="submit" disabled={submitting || !prompt.trim()} className="h-11 px-5 rounded-md bg-ember text-paper font-semibold text-sm disabled:opacity-50">{submitting ? t('taskCenter.creating') : t('taskCenter.start')}</button>
      </form>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </header>
  )
}
