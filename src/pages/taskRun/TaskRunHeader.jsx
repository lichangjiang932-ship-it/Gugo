import { describeTaskModelReadiness } from './taskModelReadiness.js'

const MODEL_READINESS_TONE = Object.freeze({
  loading: 'border-ink-fade/40 bg-paper-2 text-ink-soft',
  unconfigured: 'border-warning/60 bg-warning/5 text-warning',
  untested: 'border-warning/60 bg-warning/5 text-warning',
  'chat-only': 'border-warning/60 bg-warning/5 text-warning',
  'agent-ready': 'border-success/60 bg-success/5 text-success',
  unavailable: 'border-danger/60 bg-danger/5 text-danger',
})

export default function TaskRunHeader({
  prompt,
  setPrompt,
  submitting,
  error,
  errorAction,
  modelName = '',
  modelReadiness = { kind: 'loading', canSend: false },
  onConfigureModels,
  onOpenModelRecovery,
  onRetryModelStatus,
  onCreate,
  t,
}) {
  const modelStatus = describeTaskModelReadiness(modelReadiness)
  const taskCanStart = modelReadiness?.kind === 'ready'
  return (
    <header className="px-7 py-5 border-b border-dashed border-ink-fade/40">
      <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{t('taskCenter.kicker')}</span>
      <h1 className="font-semibold text-[28px] text-ink mt-1.5">{t('taskCenter.title')}</h1>
      <form onSubmit={onCreate} className="mt-4 flex gap-2">
        <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t('taskCenter.prompt')} className="flex-1 h-11 px-4 rounded-md border border-ink/30 bg-paper outline-none focus:border-focus text-sm" />
        <button type="submit" disabled={submitting || !prompt.trim() || !taskCanStart} className="h-11 px-5 rounded-md bg-accent text-accent-contrast font-semibold text-sm disabled:opacity-50">{submitting ? t('taskCenter.creating') : t('taskCenter.start')}</button>
      </form>
      <div
        className={`mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-sm ${MODEL_READINESS_TONE[modelStatus.state]}`}
        data-state={modelStatus.state}
        data-testid="task-model-readiness"
        role="status"
      >
        <span className="font-medium">{t('taskCenter.modelReadiness.title')}</span>
        <span className="rounded-full border border-current/30 px-2 py-0.5 font-semibold">{t(modelStatus.label)}</span>
        {modelName && <span className="max-w-64 truncate font-mono" title={modelName}>{modelName}</span>}
        <span className="min-w-48 flex-1 opacity-80">{t(modelStatus.detail)}</span>
        {modelReadiness?.kind === 'error' && onRetryModelStatus && (
          <button type="button" onClick={onRetryModelStatus} className="shrink-0 font-medium underline underline-offset-2">
            {t('taskCenter.modelReadiness.retry')}
          </button>
        )}
        <button type="button" onClick={onConfigureModels} className="shrink-0 font-medium underline underline-offset-2">
          {t('taskCenter.modelReadiness.configure')}
        </button>
      </div>
      {error && (
        <div className="mt-2 flex items-center gap-2 text-xs text-danger" role="alert">
          <span>{error}</span>
          {errorAction === 'configure_model' && (
            <button type="button" onClick={onConfigureModels} className="shrink-0 font-medium underline underline-offset-2">
              {t('modelProviders.manage')}
            </button>
          )}
          {errorAction === 'verify_model_request' && onOpenModelRecovery && (
            <button type="button" onClick={onOpenModelRecovery} className="shrink-0 font-medium underline underline-offset-2">
              {t('chatMessages.openModelRequestRecovery')}
            </button>
          )}
        </div>
      )}
    </header>
  )
}
