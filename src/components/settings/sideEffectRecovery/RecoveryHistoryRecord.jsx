import RecoveryEvidence from './RecoveryEvidence.jsx'
import {
  contextLabel,
  formatTimestamp,
  timestampDateTime,
} from './recoveryUtils.js'

export default function RecoveryHistoryRecord({ record, lang, t }) {
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
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${committed ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
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
