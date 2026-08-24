import { RefreshCw, XCircle } from 'lucide-react'
import { SettingsGroup } from '../SettingsPrimitives.jsx'
import RecoveryHistoryRecord from './RecoveryHistoryRecord.jsx'
import RecoveryRecord from './RecoveryRecord.jsx'
import { recordKey } from './recoveryUtils.js'

export function PendingRecoveryGroup({
  historyLoading,
  historyLoadingMore,
  loadError,
  loading,
  loadingMore,
  loadMorePending,
  nextCursor,
  records,
  refreshRecords,
  resolveRecord,
  resolvingKey,
  lang,
  t,
}) {
  return (
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
          <p className="flex items-start gap-2 text-danger">
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
        <p className="border-t border-ink/10 px-4 py-3 text-xs text-danger" role="alert">{loadError}</p>
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
  )
}

export function RecoveryHistoryGroup({
  historyError,
  historyLoading,
  historyLoadingMore,
  historyNextCursor,
  historyRecords,
  loadMoreHistory,
  refreshRecords,
  lang,
  t,
}) {
  return (
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
          <p className="flex items-start gap-2 text-danger">
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
        <p className="border-t border-ink/10 px-4 py-3 text-xs text-danger" role="alert">{historyError}</p>
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
  )
}
