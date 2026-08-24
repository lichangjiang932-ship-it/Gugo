import { AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import {
  getModelRequestRecoveryApi,
  resolveModelRequestRecoveryApi,
  resumeResolvedModelRequestApi,
} from '../../lib/modelRequestRecoveryClient.js'
import { SettingsGroup } from './SettingsPrimitives.jsx'

function copyFor(t) {
  return {
    title: t('modelRequestRecovery.title'),
    hint: t('modelRequestRecovery.hint'),
    loading: t('modelRequestRecovery.loading'),
    empty: t('modelRequestRecovery.empty'),
    retry: t('modelRequestRecovery.retry'),
    warning: t('modelRequestRecovery.warning'),
    provider: t('modelRequestRecovery.provider'),
    lastProvider: t('modelRequestRecovery.lastProvider'),
    physicalAttempt: t('modelRequestRecovery.physicalAttempt'),
    revision: t('modelRequestRecovery.revision'),
    requestId: t('modelRequestRecovery.requestId'),
    idempotencyKey: t('modelRequestRecovery.idempotencyKey'),
    notSent: t('modelRequestRecovery.notSent'),
    notSentHint: t('modelRequestRecovery.notSentHint'),
    completed: t('modelRequestRecovery.completed'),
    completedHint: t('modelRequestRecovery.completedHint'),
    unknown: t('modelRequestRecovery.unknown'),
    unknownHint: t('modelRequestRecovery.unknownHint'),
    response: t('modelRequestRecovery.response'),
    receipt: t('modelRequestRecovery.receipt'),
    note: t('modelRequestRecovery.note'),
    verify: t('modelRequestRecovery.verify'),
    confirm: t('modelRequestRecovery.confirm'),
    submit: t('modelRequestRecovery.submit'),
    saving: t('modelRequestRecovery.saving'),
    savedBlocked: t('modelRequestRecovery.savedBlocked'),
    savedReady: t('modelRequestRecovery.savedReady'),
    continue: t('modelRequestRecovery.continue'),
    continuing: t('modelRequestRecovery.continuing'),
  }
}

function parseJson(value, label, { object = false, t } = {}) {
  let parsed
  try { parsed = JSON.parse(value) } catch {
    throw new Error(t('modelRequestRecovery.invalidJson', { label }))
  }
  if (object && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error(t('modelRequestRecovery.jsonObjectRequired', { label }))
  }
  return parsed
}

export default function SettingsModelRequestRecoveryCard({ onOpenOriginalTask, t, target }) {
  const copy = copyFor(t)
  const fieldId = useId()
  const [recovery, setRecovery] = useState(null)
  const [loading, setLoading] = useState(Boolean(target))
  const [error, setError] = useState('')
  const [resolution, setResolution] = useState('')
  const [responseText, setResponseText] = useState('')
  const [receiptText, setReceiptText] = useState('')
  const [note, setNote] = useState('')
  const [verified, setVerified] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const [notice, setNotice] = useState('')
  const ready = recovery?.status === 'resolved_pending_resume'
    && ['not_sent', 'completed'].includes(recovery?.resolution)

  const load = useCallback(async ({ signal } = {}) => {
    if (!target) return
    setLoading(true)
    setError('')
    try {
      const result = await getModelRequestRecoveryApi({ ...target, signal })
      if (target.modelRequestId && result?.modelRequestId !== target.modelRequestId) {
        throw new Error(t('modelRequestRecovery.requestMismatch'))
      }
      setRecovery(result)
      setNotice('')
    } catch (loadError) {
      if (loadError?.name !== 'AbortError') setError(loadError?.message || String(loadError))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [t, target])

  useEffect(() => {
    if (!target) return undefined
    const controller = new AbortController()
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) return load({ signal: controller.signal })
      return undefined
    })
    return () => controller.abort()
  }, [load, target])

  if (!target) return null

  const submit = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const completed = resolution === 'completed'
      const result = await resolveModelRequestRecoveryApi({
        ...target,
        recovery,
        resolution,
        verificationConfirmed: verified,
        confirmModelRequestId: confirmation,
        ...(completed ? {
          response: parseJson(responseText, copy.response, { object: true, t }),
          receipt: parseJson(receiptText, copy.receipt, { t }),
        } : {}),
        note,
      })
      setRecovery(result.recovery)
      setNotice(result.resume?.ready ? copy.savedReady : copy.savedBlocked)
    } catch (saveError) {
      setError(saveError?.message || String(saveError))
    } finally {
      setSaving(false)
    }
  }

  const resume = async () => {
    setContinuing(true)
    setError('')
    try {
      await resumeResolvedModelRequestApi(target)
      const scopeKind = recovery?.scopeKind === 'job' || target.scopeKind === 'job'
        ? 'job'
        : 'turn'
      onOpenOriginalTask?.(scopeKind === 'job'
        ? {
            record: {
              scopeKind,
              jobId: recovery?.jobId || target.jobId,
              stepId: recovery?.stepId || target.stepId,
            },
            resume: null,
          }
        : {
            record: {
              scopeKind,
              sessionId: recovery?.sessionId || target.sessionId,
              turnId: recovery?.turnId || target.turnId,
            },
            resume: null,
          })
    } catch (resumeError) {
      setError(resumeError?.message || String(resumeError))
    } finally {
      setContinuing(false)
    }
  }

  const canSubmit = Boolean(recovery && resolution && verified
    && confirmation.trim() === recovery.modelRequestId
    && !saving
    && !ready
    && (resolution !== 'completed' || (responseText.trim() && receiptText.trim())))

  return (
    <SettingsGroup title={copy.title} description={copy.hint}>
      {loading ? (
        <p className="px-4 py-6 text-center text-xs text-ink-fade" role="status">{copy.loading}</p>
      ) : error && !recovery ? (
        <div className="px-4 py-5 text-xs" role="alert">
          <p className="flex items-start gap-2 text-danger"><XCircle className="h-4 w-4" />{error}</p>
          <button type="button" className="settings-action-button mt-3" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" />{copy.retry}
          </button>
        </div>
      ) : !recovery ? (
        <p className="px-4 py-6 text-center text-xs text-ink-fade">{copy.empty}</p>
      ) : (
        <div className="grid gap-4 px-4 py-4" data-testid="model-request-recovery-card">
          <div className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-3 text-xs leading-5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>{copy.warning}</span>
          </div>
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            <div><dt className="font-semibold">{copy.provider}</dt><dd className="break-all font-mono text-ink-soft">{recovery.providerId || '—'} / {recovery.modelName || '—'} · {copy.revision} {recovery.configRevision ?? '—'}</dd></div>
            {recovery.lastProviderAttempt ? (
              <div data-testid="model-request-last-provider">
                <dt className="font-semibold">{copy.lastProvider}</dt>
                <dd className="break-all font-mono text-ink-soft">
                  {recovery.lastProviderAttempt.providerId || '—'} / {recovery.lastProviderAttempt.modelName || '—'}
                  {' · '}{recovery.lastProviderAttempt.providerKind || '—'}
                  {' · '}{copy.physicalAttempt} {recovery.lastProviderAttempt.sequence ?? '—'}
                </dd>
              </div>
            ) : null}
            <div><dt className="font-semibold">{copy.requestId}</dt><dd className="break-all font-mono text-ink-soft">{recovery.modelRequestId}</dd></div>
            <div className="sm:col-span-2"><dt className="font-semibold">{copy.idempotencyKey}</dt><dd className="break-all font-mono text-ink-soft">{recovery.idempotencyKey}</dd></div>
          </dl>
          {!ready ? (
            <>
              <fieldset className="grid gap-2">
                {[
                  ['not_sent', copy.notSent, copy.notSentHint],
                  ['completed', copy.completed, copy.completedHint],
                  ['unknown', copy.unknown, copy.unknownHint],
                ].map(([value, label, hint]) => (
                  <label className="flex items-start gap-2 rounded-md border border-ink/10 px-3 py-2" key={value}>
                    <input type="radio" name={`${fieldId}-resolution`} value={value} checked={resolution === value} onChange={(event) => setResolution(event.target.value)} />
                    <span className="text-xs leading-5"><strong className="block">{label}</strong><span className="text-ink-fade">{hint}</span></span>
                  </label>
                ))}
              </fieldset>
              {resolution === 'completed' ? (
                <div className="grid gap-3">
                  <label className="text-xs font-semibold">{copy.response}<textarea className="settings-input mt-2 min-h-28 w-full font-mono" value={responseText} onChange={(event) => setResponseText(event.target.value)} /></label>
                  <label className="text-xs font-semibold">{copy.receipt}<textarea className="settings-input mt-2 min-h-20 w-full font-mono" value={receiptText} onChange={(event) => setReceiptText(event.target.value)} /></label>
                </div>
              ) : null}
              <label className="text-xs font-semibold">{copy.note}<textarea className="settings-input mt-2 min-h-16 w-full" maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
              <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} /><span>{copy.verify}</span></label>
              <label className="text-xs font-semibold">{copy.confirm}<input className="settings-input mt-2 w-full font-mono" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
              <div className="flex justify-end"><button type="button" className="settings-action-button settings-action-button-primary" disabled={!canSubmit} onClick={() => void submit()}>{saving ? copy.saving : copy.submit}</button></div>
            </>
          ) : null}
          {notice ? <p className="flex items-start gap-2 text-xs text-success" role="status"><CheckCircle2 className="h-4 w-4" />{notice}</p> : null}
          {error && recovery ? <p className="flex items-start gap-2 text-xs text-danger" role="alert"><XCircle className="h-4 w-4" />{error}</p> : null}
          {ready ? <div className="flex justify-end"><button type="button" className="settings-action-button settings-action-button-primary" disabled={continuing} onClick={() => void resume()}>{continuing ? copy.continuing : copy.continue}</button></div> : null}
        </div>
      )}
    </SettingsGroup>
  )
}
