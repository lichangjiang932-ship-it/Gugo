import { useId, useState } from 'react'
import RecoveryEvidence from './RecoveryEvidence.jsx'
import {
  contextLabel,
  formatTimestamp,
  timestampDateTime,
} from './recoveryUtils.js'

export default function RecoveryRecord({ record, busy, disabled: panelDisabled, lang, onResolve, t }) {
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

      <p className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-xs leading-5 text-ink-soft">
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

      <div className="mt-3 rounded-md border border-danger/25 bg-danger/[0.06] px-3 py-3">
        <p className="text-xs font-semibold text-danger">
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
