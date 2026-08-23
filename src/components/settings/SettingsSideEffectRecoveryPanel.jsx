import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import {
  listSideEffectRecoveryHistoryApi,
  listUnknownSideEffectsApi,
  resolveUnknownSideEffectApi,
} from '../../lib/sideEffectRecoveryClient.js'
import SettingsModelRequestRecoveryCard from './SettingsModelRequestRecoveryCard.jsx'
import { SettingsGroup, SettingsPanel } from './SettingsPrimitives.jsx'

function recordKey(record) {
  return JSON.stringify([
    record.scopeKey || record.sessionId || record.jobId || record.scopeKind,
    record.stepId || record.turnId || '',
    record.toolCallId,
  ])
}

function mergeRecords(current, incoming) {
  const merged = new Map()
  for (const record of [...current, ...incoming]) merged.set(recordKey(record), record)
  return [...merged.values()]
}

function timestampDate(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date : null
}

function formatTimestamp(value, lang, fallback) {
  const date = timestampDate(value)
  if (!date) return fallback
  try {
    return new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}

function timestampDateTime(value) {
  return timestampDate(value)?.toISOString()
}

function contextLabel(record, t) {
  if (record.jobId) return t('sideEffectRecovery.jobContext', { id: record.jobId })
  if (record.turnId) return t('sideEffectRecovery.turnContext', { id: record.turnId })
  if (record.sessionId) return t('sideEffectRecovery.sessionContext', { id: record.sessionId })
  return t('sideEffectRecovery.scopeContext', { kind: record.scopeKind || 'runtime' })
}

function EvidenceValues({ values }) {
  if (!Array.isArray(values) || values.length === 0) return null
  return (
    <ul className="mt-1 grid gap-1">
      {values.map((value, index) => (
        <li className="break-all font-mono text-xs text-ink-soft" key={`${value}-${index}`}>
          {value}
        </li>
      ))}
    </ul>
  )
}

function verifiedOutputText(output, t) {
  if (!output || typeof output !== 'object') return ''
  return [
    output.target,
    output.artifactId
      ? t('sideEffectRecovery.artifactReference', { id: output.artifactId })
      : '',
    output.receiptId
      ? t('sideEffectRecovery.receiptReference', { id: output.receiptId })
      : '',
    output.sha256
      ? t('sideEffectRecovery.sha256Reference', { digest: output.sha256 })
      : '',
    Number.isFinite(output.size)
      ? t('sideEffectRecovery.sizeReference', { size: output.size })
      : '',
  ].filter(Boolean).join(' · ')
}

function RecoveryEvidence({ record, t }) {
  const evidence = record.evidence && typeof record.evidence === 'object'
    ? record.evidence
    : {}
  const targetSummary = Array.isArray(evidence.targetSummary) ? evidence.targetSummary : []
  const changedPaths = Array.isArray(evidence.changedPaths) ? evidence.changedPaths : []
  const verifiedOutputs = Array.isArray(evidence.verifiedOutputs)
    ? evidence.verifiedOutputs.map((output) => verifiedOutputText(output, t)).filter(Boolean)
    : []
  const artifactIds = Array.isArray(evidence.artifactIds) ? evidence.artifactIds : []
  const hasEvidence = targetSummary.length > 0
    || changedPaths.length > 0
    || verifiedOutputs.length > 0
    || artifactIds.length > 0

  return (
    <div
      className="mt-3 rounded-md border border-ink/10 bg-ink/[0.025] px-3 py-3"
      data-testid="side-effect-recovery-evidence"
    >
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-ink">{t('sideEffectRecovery.toolCallIdLabel')}</dt>
          <dd className="mt-1 break-all font-mono text-xs text-ink-soft">{record.toolCallId}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink">{t('sideEffectRecovery.argsDigestLabel')}</dt>
          <dd className="mt-1 break-all font-mono text-xs text-ink-soft">{record.argsDigest}</dd>
        </div>
        {record.stepId ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.stepIdLabel')}</dt>
            <dd className="mt-1 break-all font-mono text-xs text-ink-soft">{record.stepId}</dd>
          </div>
        ) : null}
        {targetSummary.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.targetSummaryLabel')}</dt>
            <dd><EvidenceValues values={targetSummary} /></dd>
          </div>
        ) : null}
        {changedPaths.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.changedPathsLabel')}</dt>
            <dd><EvidenceValues values={changedPaths} /></dd>
          </div>
        ) : null}
        {verifiedOutputs.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.verifiedOutputsLabel')}</dt>
            <dd><EvidenceValues values={verifiedOutputs} /></dd>
          </div>
        ) : null}
        {artifactIds.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-ink">{t('sideEffectRecovery.artifactIdsLabel')}</dt>
            <dd><EvidenceValues values={artifactIds} /></dd>
          </div>
        ) : null}
      </dl>
      {!hasEvidence ? (
        <p className="mt-2 text-xs leading-5 text-ink-fade">{t('sideEffectRecovery.noEvidence')}</p>
      ) : null}
    </div>
  )
}

function RecoveryRecord({ record, busy, disabled: panelDisabled, lang, onResolve, t }) {
  const fieldId = useId()
  const [resolution, setResolution] = useState('')
  const [note, setNote] = useState('')
  const [verified, setVerified] = useState(false)
  const [permanentConfirmed, setPermanentConfirmed] = useState(false)
  const disabled = panelDisabled || !resolution || !verified || !permanentConfirmed
  const chooseResolution = (value) => {
    setResolution(value)
    setPermanentConfirmed(false)
  }

  return (
    <article
      className="border-t border-ink/10 px-4 py-4 first:border-t-0"
      data-testid="side-effect-recovery-record"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-all text-sm font-semibold text-ink">
            {record.toolName || t('sideEffectRecovery.unknownTool')}
          </h3>
          <p className="mt-1 break-all text-xs text-ink-fade">{contextLabel(record, t)}</p>
        </div>
        <time className="text-xs text-ink-fade" dateTime={timestampDateTime(record.updatedAt)}>
          {formatTimestamp(record.updatedAt, lang, t('sideEffectRecovery.unknownTime'))}
        </time>
      </header>

      <RecoveryEvidence record={record} t={t} />

      <p className="mt-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-5 text-ink-soft">
        {t('sideEffectRecovery.recordWarning')}
      </p>

      <fieldset className="mt-4 grid gap-2" disabled={panelDisabled}>
        <legend className="mb-1 text-xs font-semibold text-ink">
          {t('sideEffectRecovery.decisionLabel')}
        </legend>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-ink/10 px-3 py-2">
          <input
            type="radio"
            name={`${fieldId}-resolution`}
            value="committed"
            checked={resolution === 'committed'}
            onChange={(event) => chooseResolution(event.target.value)}
          />
          <span className="text-xs leading-5">
            <strong className="block text-ink">{t('sideEffectRecovery.confirmCommitted')}</strong>
            <span className="text-ink-fade">{t('sideEffectRecovery.confirmCommittedHint')}</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-ink/10 px-3 py-2">
          <input
            type="radio"
            name={`${fieldId}-resolution`}
            value="failed"
            checked={resolution === 'failed'}
            onChange={(event) => chooseResolution(event.target.value)}
          />
          <span className="text-xs leading-5">
            <strong className="block text-ink">{t('sideEffectRecovery.confirmFailed')}</strong>
            <span className="text-ink-fade">{t('sideEffectRecovery.confirmFailedHint')}</span>
          </span>
        </label>
      </fieldset>

      <label className="mt-4 block text-xs font-semibold text-ink" htmlFor={`${fieldId}-note`}>
        {t('sideEffectRecovery.noteLabel')}
      </label>
      <textarea
        id={`${fieldId}-note`}
        className="settings-input mt-2 min-h-20 w-full resize-y"
        maxLength={2000}
        value={note}
        disabled={panelDisabled}
        placeholder={t('sideEffectRecovery.notePlaceholder')}
        onChange={(event) => setNote(event.target.value)}
      />

      <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-ink-soft">
        <input
          type="checkbox"
          checked={verified}
          disabled={panelDisabled}
          onChange={(event) => setVerified(event.target.checked)}
        />
        <span>{t('sideEffectRecovery.verificationRequired')}</span>
      </label>

      <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-3">
        <p className="text-xs font-semibold text-red-800">
          {t('sideEffectRecovery.permanentDecisionWarning')}
        </p>
        <label className="mt-2 flex items-start gap-2 text-xs leading-5 text-ink-soft">
          <input
            type="checkbox"
            checked={permanentConfirmed}
            data-testid="side-effect-recovery-permanent-confirmation"
            disabled={panelDisabled || !resolution}
            onChange={(event) => setPermanentConfirmed(event.target.checked)}
          />
          <span>{t('sideEffectRecovery.permanentDecisionRequired', {
            decision: resolution
              ? t(resolution === 'committed'
                ? 'sideEffectRecovery.confirmCommitted'
                : 'sideEffectRecovery.confirmFailed')
              : t('sideEffectRecovery.noDecisionSelected'),
            toolCallId: record.toolCallId,
          })}</span>
        </label>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="settings-action-button settings-action-button-primary"
          disabled={disabled}
          onClick={() => onResolve(record, resolution, note, {
            verificationConfirmed: verified && permanentConfirmed,
            confirmToolCallId: record.toolCallId,
          })}
        >
          {busy ? t('sideEffectRecovery.resolving') : t('sideEffectRecovery.submitDecision')}
        </button>
      </div>
    </article>
  )
}

function RecoveryHistoryRecord({ record, lang, t }) {
  const resolvedAt = record.audit?.confirmedAt ?? record.finishedAt ?? record.updatedAt
  const note = String(record.audit?.note || record.note || '').trim()
  const committed = record.status === 'committed'
  return (
    <article
      className="border-t border-ink/10 px-4 py-4 first:border-t-0"
      data-testid="side-effect-recovery-history-record"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-all text-sm font-semibold text-ink">
            {record.toolName || t('sideEffectRecovery.unknownTool')}
          </h3>
          <p className="mt-1 break-all text-xs text-ink-fade">{contextLabel(record, t)}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${committed ? 'bg-emerald-500/10 text-emerald-700' : 'bg-red-500/10 text-red-700'}`}>
            {t(committed
              ? 'sideEffectRecovery.historyCommitted'
              : 'sideEffectRecovery.historyFailed')}
          </span>
          <time className="text-xs text-ink-fade" dateTime={timestampDateTime(resolvedAt)}>
            {formatTimestamp(resolvedAt, lang, t('sideEffectRecovery.unknownTime'))}
          </time>
        </div>
      </header>
      <RecoveryEvidence record={record} t={t} />
      <div className="mt-3 rounded-md border border-ink/10 bg-ink/[0.025] px-3 py-2 text-xs leading-5">
        <strong className="text-ink">{t('sideEffectRecovery.historyNoteLabel')}</strong>
        <p className="mt-1 whitespace-pre-wrap break-words text-ink-soft">
          {note || t('sideEffectRecovery.historyNoNote')}
        </p>
      </div>
    </article>
  )
}

export default function SettingsSideEffectRecoveryPanel({
  lang,
  modelRecoveryTarget = null,
  onOpenOriginalTask,
  t,
}) {
  const [records, setRecords] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [historyRecords, setHistoryRecords] = useState([])
  const [historyNextCursor, setHistoryNextCursor] = useState(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [continuation, setContinuation] = useState(null)
  const [resolvingKey, setResolvingKey] = useState('')

  const refreshRecords = useCallback(async ({ signal } = {}) => {
    setLoading(true)
    setHistoryLoading(true)
    setNextCursor(null)
    setHistoryNextCursor(null)
    setLoadError('')
    setHistoryError('')
    setContinuation(null)
    const [pendingResult, historyResult] = await Promise.allSettled([
      listUnknownSideEffectsApi({ signal }),
      listSideEffectRecoveryHistoryApi({ signal }),
    ])
    if (signal?.aborted) return
    if (pendingResult.status === 'fulfilled') {
      setRecords(pendingResult.value.records)
      setNextCursor(pendingResult.value.nextCursor)
    } else if (pendingResult.reason?.name !== 'AbortError') {
      setLoadError(t('sideEffectRecovery.loadFailed', {
        reason: pendingResult.reason?.message || pendingResult.reason,
      }))
    }
    if (historyResult.status === 'fulfilled') {
      setHistoryRecords(historyResult.value.records)
      setHistoryNextCursor(historyResult.value.nextCursor)
    } else if (historyResult.reason?.name !== 'AbortError') {
      setHistoryError(t('sideEffectRecovery.historyLoadFailed', {
        reason: historyResult.reason?.message || historyResult.reason,
      }))
    }
    setLoading(false)
    setHistoryLoading(false)
  }, [t])

  const loadMorePending = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setLoadError('')
    try {
      const page = await listUnknownSideEffectsApi({ cursor: nextCursor })
      setRecords((current) => mergeRecords(current, page.records))
      setNextCursor(page.nextCursor)
    } catch (error) {
      setLoadError(t('sideEffectRecovery.loadFailed', { reason: error?.message || error }))
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, nextCursor, t])

  const loadMoreHistory = useCallback(async () => {
    if (!historyNextCursor || historyLoadingMore) return
    setHistoryLoadingMore(true)
    setHistoryError('')
    try {
      const page = await listSideEffectRecoveryHistoryApi({ cursor: historyNextCursor })
      setHistoryRecords((current) => mergeRecords(current, page.records))
      setHistoryNextCursor(page.nextCursor)
    } catch (error) {
      setHistoryError(t('sideEffectRecovery.historyLoadFailed', { reason: error?.message || error }))
    } finally {
      setHistoryLoadingMore(false)
    }
  }, [historyLoadingMore, historyNextCursor, t])

  useEffect(() => {
    const controller = new AbortController()
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) return refreshRecords({ signal: controller.signal })
      return undefined
    })
    return () => controller.abort()
  }, [refreshRecords])

  const resolveRecord = useCallback(async (record, resolution, note, confirmation) => {
    const key = recordKey(record)
    setResolvingKey(key)
    setActionError('')
    setNotice('')
    setContinuation(null)
    try {
      const result = await resolveUnknownSideEffectApi({
        record,
        scopeKey: record.scopeKey,
        toolCallId: record.toolCallId,
        verificationConfirmed: confirmation?.verificationConfirmed,
        confirmToolCallId: confirmation?.confirmToolCallId,
        resolution,
        note,
      })
      const resolvedRecord = {
        ...record,
        ...(result.record || {}),
        scopeKind: record.scopeKind,
        scopeKey: record.scopeKey,
        sessionId: record.sessionId,
        turnId: record.turnId,
        jobId: record.jobId,
        stepId: record.stepId,
        toolCallId: record.toolCallId,
        status: resolution,
      }
      setRecords((current) => current.filter((item) => recordKey(item) !== key))
      setHistoryRecords((current) => mergeRecords([resolvedRecord], current))
      setContinuation({ record: resolvedRecord, resume: result.resume })
      setNotice(t(
        resolution === 'committed'
          ? 'sideEffectRecovery.committedRecorded'
          : 'sideEffectRecovery.failedRecorded',
      ))
    } catch (error) {
      setActionError(t('sideEffectRecovery.resolveFailed', { reason: error?.message || error }))
      if (error?.status === 404 || error?.status === 409) await refreshRecords()
    } finally {
      setResolvingKey('')
    }
  }, [refreshRecords, t])

  return (
    <SettingsPanel
      title={t('sideEffectRecovery.title')}
      description={t('sideEffectRecovery.subtitle')}
      testId="side-effect-recovery-settings"
    >
      <div
        className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-5 text-ink-soft"
        role="alert"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div>
          <strong className="block text-ink">{t('sideEffectRecovery.safetyTitle')}</strong>
          <span>{t('sideEffectRecovery.safetyWarning')}</span>
        </div>
      </div>

      <SettingsModelRequestRecoveryCard
        target={modelRecoveryTarget}
        onOpenOriginalTask={onOpenOriginalTask}
        t={t}
      />

      <SettingsGroup
        title={t('sideEffectRecovery.pendingTitle', { count: records.length })}
        description={t('sideEffectRecovery.pendingHint')}
      >
        <div className="flex justify-end px-4 py-3">
          <button
            type="button"
            className="settings-action-button"
            disabled={loading || historyLoading || loadingMore || historyLoadingMore || Boolean(resolvingKey)}
            onClick={() => void refreshRecords()}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading || historyLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
            {t('sideEffectRecovery.refresh')}
          </button>
        </div>

        {loading ? (
          <p className="border-t border-ink/10 px-4 py-6 text-center text-xs text-ink-fade" role="status">
            {t('sideEffectRecovery.loading')}
          </p>
        ) : loadError ? (
          <div className="border-t border-ink/10 px-4 py-5 text-xs" role="alert">
            <p className="flex items-start gap-2 text-red-700">
              <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{loadError}</span>
            </p>
            <button type="button" className="settings-action-button mt-3" onClick={() => void refreshRecords()}>
              {t('sideEffectRecovery.retry')}
            </button>
          </div>
        ) : records.length === 0 ? (
          <p className="border-t border-ink/10 px-4 py-8 text-center text-xs text-ink-fade" role="status">
            {t('sideEffectRecovery.empty')}
          </p>
        ) : records.map((record) => (
          <RecoveryRecord
            key={recordKey(record)}
            record={record}
            busy={resolvingKey === recordKey(record)}
            disabled={Boolean(resolvingKey)}
            lang={lang}
            onResolve={resolveRecord}
            t={t}
          />
        ))}
        {records.length > 0 && loadError ? (
          <p className="border-t border-ink/10 px-4 py-3 text-xs text-red-700" role="alert">{loadError}</p>
        ) : null}
        {nextCursor ? (
          <div className="flex justify-center border-t border-ink/10 px-4 py-3">
            <button
              type="button"
              className="settings-action-button"
              data-testid="side-effect-recovery-load-more"
              disabled={loadingMore || Boolean(resolvingKey)}
              onClick={() => void loadMorePending()}
            >
              {t(loadingMore ? 'sideEffectRecovery.loadingMore' : 'sideEffectRecovery.loadMore')}
            </button>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title={t('sideEffectRecovery.historyTitle', { count: historyRecords.length })}
        description={t('sideEffectRecovery.historyHint')}
      >
        {historyLoading ? (
          <p className="px-4 py-6 text-center text-xs text-ink-fade" role="status">
            {t('sideEffectRecovery.historyLoading')}
          </p>
        ) : historyError && historyRecords.length === 0 ? (
          <div className="px-4 py-5 text-xs" role="alert">
            <p className="flex items-start gap-2 text-red-700">
              <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{historyError}</span>
            </p>
            <button type="button" className="settings-action-button mt-3" onClick={() => void refreshRecords()}>
              {t('sideEffectRecovery.retry')}
            </button>
          </div>
        ) : historyRecords.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-ink-fade" role="status">
            {t('sideEffectRecovery.historyEmpty')}
          </p>
        ) : historyRecords.map((record) => (
          <RecoveryHistoryRecord key={recordKey(record)} record={record} lang={lang} t={t} />
        ))}
        {historyRecords.length > 0 && historyError ? (
          <p className="border-t border-ink/10 px-4 py-3 text-xs text-red-700" role="alert">{historyError}</p>
        ) : null}
        {historyNextCursor ? (
          <div className="flex justify-center border-t border-ink/10 px-4 py-3">
            <button
              type="button"
              className="settings-action-button"
              data-testid="side-effect-recovery-history-load-more"
              disabled={historyLoadingMore}
              onClick={() => void loadMoreHistory()}
            >
              {t(historyLoadingMore ? 'sideEffectRecovery.loadingMore' : 'sideEffectRecovery.loadMore')}
            </button>
          </div>
        ) : null}
      </SettingsGroup>

      {actionError ? (
        <p className="flex items-start gap-2 text-xs text-red-700" role="alert">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{actionError}</span>
        </p>
      ) : null}
      {notice ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-emerald-700" role="status">
          <p className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </p>
          {continuation && typeof onOpenOriginalTask === 'function' ? (
            <button
              type="button"
              className="settings-action-button settings-action-button-primary"
              data-testid="side-effect-recovery-continue"
              onClick={() => onOpenOriginalTask(continuation)}
            >
              {t(continuation.resume
                ? 'sideEffectRecovery.continueOriginalTask'
                : 'sideEffectRecovery.openOriginalTask')}
            </button>
          ) : null}
        </div>
      ) : null}
    </SettingsPanel>
  )
}
