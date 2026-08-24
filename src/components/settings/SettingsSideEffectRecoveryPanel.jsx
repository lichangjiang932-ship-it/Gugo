import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import SettingsModelRequestRecoveryCard from './SettingsModelRequestRecoveryCard.jsx'
import { SettingsPanel } from './SettingsPrimitives.jsx'
import {
  PendingRecoveryGroup,
  RecoveryHistoryGroup,
} from './sideEffectRecovery/RecoveryGroups.jsx'
import useSideEffectRecovery from './sideEffectRecovery/useSideEffectRecovery.js'

export default function SettingsSideEffectRecoveryPanel({
  lang,
  modelRecoveryTarget = null,
  onOpenOriginalTask,
  t,
}) {
  const recovery = useSideEffectRecovery(t)

  return (
    <SettingsPanel
      title={t('sideEffectRecovery.title')}
      description={t('sideEffectRecovery.subtitle')}
      testId="side-effect-recovery-settings"
    >
      <div
        className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4 text-xs leading-5 text-ink-soft"
        role="alert"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
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

      <PendingRecoveryGroup {...recovery} lang={lang} t={t} />
      <RecoveryHistoryGroup {...recovery} lang={lang} t={t} />

      {recovery.actionError ? (
        <p className="flex items-start gap-2 text-xs text-danger" role="alert">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{recovery.actionError}</span>
        </p>
      ) : null}
      {recovery.notice ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-success" role="status">
          <p className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{recovery.notice}</span>
          </p>
          {recovery.continuation && typeof onOpenOriginalTask === 'function' ? (
            <button
              type="button"
              className="settings-action-button settings-action-button-primary"
              data-testid="side-effect-recovery-continue"
              onClick={() => onOpenOriginalTask(recovery.continuation)}
            >
              {t(recovery.continuation.resume
                ? 'sideEffectRecovery.continueOriginalTask'
                : 'sideEffectRecovery.openOriginalTask')}
            </button>
          ) : null}
        </div>
      ) : null}
    </SettingsPanel>
  )
}
