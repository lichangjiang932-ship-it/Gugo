import { AlertTriangle, LoaderCircle } from 'lucide-react'
import useInlineSideEffectRecovery from './useInlineSideEffectRecovery.js'

function OperationEvidence({ record, t }) {
  if (!record) return null
  const intent = record.intentSummary || {}
  const targets = [...new Set([
    ...(Array.isArray(intent.targets) ? intent.targets.map((target) => target?.value) : []),
    ...(Array.isArray(record.evidence?.targetSummary) ? record.evidence.targetSummary : []),
  ].filter((value) => typeof value === 'string' && value).map((value) => value.slice(0, 1000)))].slice(0, 6)
  const failures = []
  for (let current = record.failure; current && failures.length < 3; current = current.cause) {
    failures.push({ code: String(current.code || '').slice(0, 128), message: String(current.message || '').slice(0, 1000), hint: String(current.hint || '').slice(0, 1000) })
  }
  return <div className="mt-2 space-y-2" data-testid="inline-side-effect-evidence">
    <code className="text-xs font-medium text-ink">{record.toolName || t('sideEffectRecovery.unknownTool')}</code>
    {intent.command && <pre className="whitespace-pre-wrap break-all rounded bg-paper px-2 py-1 text-xs text-ink-soft">{String(intent.command).slice(0, 1000)}</pre>}
    {targets.length > 0 && <ul className="space-y-1 text-xs text-ink-soft">{targets.map((target) => <li key={target} className="break-all">{target}</li>)}</ul>}
    {failures.map((failure, index) => <div key={index} className="space-y-1 text-xs text-ink-soft" data-testid="inline-side-effect-failure">
      {failure.code && <code className="rounded bg-ink/5 px-1">{failure.code}</code>}
      {failure.message && <p className="whitespace-pre-wrap break-words">{failure.message}</p>}
      {failure.hint && <p className="whitespace-pre-wrap break-words">{failure.hint}</p>}
    </div>)}
    <details className="text-xs text-ink-fade">
      <summary className="cursor-pointer">{t('sideEffectRecovery.inlineIdentity')}</summary>
      <dl className="mt-1 space-y-1 break-all">
        <div><dt>{t('sideEffectRecovery.toolCallIdLabel')}</dt><dd className="font-mono">{record.toolCallId}</dd></div>
        <div><dt>{t('sideEffectRecovery.argsDigestLabel')}</dt><dd className="font-mono">{record.argsDigest}</dd></div>
      </dl>
    </details>
  </div>
}

const actionClass = 'min-h-8 rounded-control border border-ink/20 px-3 py-1.5 text-xs text-ink transition-colors hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/45 disabled:cursor-not-allowed disabled:opacity-40'

export default function InlineSideEffectRecoveryCard({ sessionId, msg, ownerScope, onResolved, t, loadInteraction, resolveInteraction }) {
  const recovery = useInlineSideEffectRecovery({ sessionId, msg, ownerScope, onResolved, loadInteraction, resolveInteraction })
  const busy = recovery.phase === 'loading' || recovery.phase === 'resolving'
  const ready = recovery.phase === 'ready'
  const resolved = recovery.phase === 'resolved'
  const deferred = recovery.phase === 'deferred'
  return <section className="mt-3 rounded-control border border-warning/35 bg-warning/5 p-3 text-ui text-ink"
    data-testid="side-effect-recovery-blocked" aria-busy={busy} aria-label={t('sideEffectRecovery.inlineTitle')}>
    <div className="flex items-start gap-2">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <strong className="text-sm font-semibold">{t('sideEffectRecovery.inlineTitle')}</strong>
        {!deferred && !resolved && <p className="mt-1 text-xs leading-5 text-ink-soft">{t('sideEffectRecovery.inlineWarning')}</p>}
        {!deferred && <OperationEvidence record={recovery.record} t={t} />}
        {busy && <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-soft" role="status">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {t(recovery.phase === 'loading' ? 'sideEffectRecovery.inlineLoading' : 'sideEffectRecovery.resolving')}
        </p>}
        {recovery.phase === 'unavailable' && <p className="mt-2 text-xs text-ink-soft" role="status">{t('sideEffectRecovery.inlineUnavailable')}</p>}
        {deferred && <p className="mt-1 text-xs text-ink-soft" role="status">{t('sideEffectRecovery.inlineDeferred')}</p>}
        {resolved && <p className="mt-2 text-xs text-ink-soft" role="status">{t(recovery.resolution === 'committed'
          ? 'sideEffectRecovery.inlineCommitted' : 'sideEffectRecovery.inlineFailed')}</p>}
        {recovery.error && <p className="mt-2 text-xs text-danger" role="alert">{t(`sideEffectRecovery.${recovery.error}`)}</p>}
        <div className="mt-3 flex flex-wrap gap-2" data-testid="inline-side-effect-actions">
          {!deferred && !resolved && <>
            <button type="button" className={actionClass} disabled={!ready} onClick={() => recovery.confirm('failed')}
              data-testid="inline-side-effect-failed">{t('sideEffectRecovery.inlineConfirmFailed')}</button>
            <button type="button" className={actionClass} disabled={!ready} onClick={() => recovery.confirm('committed')}
              data-testid="inline-side-effect-committed">{t('sideEffectRecovery.inlineConfirmCommitted')}</button>
            <button type="button" className={actionClass} disabled={recovery.phase === 'resolving'} onClick={recovery.defer}
              data-testid="inline-side-effect-defer">{t('sideEffectRecovery.inlineDefer')}</button>
          </>}
          {!resolved && !ready && <button type="button" className={actionClass} disabled={busy || !recovery.canRefresh} onClick={recovery.refresh}
            data-testid="inline-side-effect-refresh">{t(deferred ? 'sideEffectRecovery.inlineReview' : 'sideEffectRecovery.inlineRefresh')}</button>}
          {resolved && !recovery.resumeRequested && <button type="button" className={actionClass} onClick={recovery.resume}
            data-testid="inline-side-effect-continue">{t('sideEffectRecovery.continueOriginalTask')}</button>}
        </div>
      </div>
    </div>
  </section>
}
