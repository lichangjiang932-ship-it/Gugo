import { SettingsPanel } from './SettingsPrimitives.jsx'
import EvolutionAutopilotGroup from './evolutionPanel/EvolutionAutopilotGroup.jsx'
import EvolutionCanaryGroup from './evolutionPanel/EvolutionCanaryGroup.jsx'
import EvolutionOverviewGroups from './evolutionPanel/EvolutionOverviewGroups.jsx'
import EvolutionPromotionGroup from './evolutionPanel/EvolutionPromotionGroup.jsx'
import EvolutionWorkflowGroup from './evolutionPanel/EvolutionWorkflowGroup.jsx'
import useEvolutionApproval from './evolutionPanel/useEvolutionApproval.js'
import useEvolutionAutopilot from './evolutionPanel/useEvolutionAutopilot.js'
import useEvolutionCanary from './evolutionPanel/useEvolutionCanary.js'
import useEvolutionPromotion from './evolutionPanel/useEvolutionPromotion.js'
import useEvolutionSnapshot from './evolutionPanel/useEvolutionSnapshot.js'
import useEvolutionWorkflow from './evolutionPanel/useEvolutionWorkflow.js'

export default function SettingsEvolutionPanel({ t }) {
  const state = useEvolutionSnapshot(t)
  const sharedActions = {
    refresh: state.refresh,
    setBusy: state.setBusy,
    setMessage: state.setMessage,
    t,
  }
  const workflow = useEvolutionWorkflow(sharedActions)
  const approval = useEvolutionApproval(sharedActions)
  const canary = useEvolutionCanary({
    ...sharedActions,
    setSnapshot: state.setSnapshot,
    snapshot: state.snapshot,
  })
  const promotion = useEvolutionPromotion(sharedActions)
  const autopilot = useEvolutionAutopilot({ providers: state.snapshot.providers, t })

  const refreshAll = async () => {
    await Promise.all([state.refresh(), autopilot.refresh()])
  }

  return (
    <SettingsPanel title={t('evolution.title')} description={t('evolution.subtitle')} testId="settings-evolution">
      <div className="flex items-center justify-between gap-3 text-xs text-ink-fade" role="status">
        <span>{state.loading || autopilot.loading ? t('evolution.loading') : (state.message || autopilot.message)}</span>
        <button type="button" className="settings-action-button" disabled={state.loading || autopilot.loading || Boolean(state.busy)} onClick={() => void refreshAll()}>
          {t('evolution.refresh')}
        </button>
      </div>

      <EvolutionAutopilotGroup autopilot={autopilot} t={t} />

      <details className="evolution-advanced">
        <summary>
          <span>{t('evolution.advancedAudit')}</span>
          <small>{t('evolution.advancedAuditHint')}</small>
        </summary>
        <div className="evolution-advanced-body">
          <EvolutionWorkflowGroup
            busy={state.busy}
            providers={state.snapshot.providers}
            workflow={workflow}
            t={t}
          />
          <EvolutionOverviewGroups
            approval={approval}
            busy={state.busy}
            loading={state.loading}
            snapshot={state.snapshot}
            t={t}
          />
          <EvolutionCanaryGroup
            busy={state.busy}
            canary={canary}
            loading={state.loading}
            openPromotionReview={promotion.openPromotionReview}
            providers={state.snapshot.providers}
            records={state.snapshot.canaries}
            t={t}
          />
          <EvolutionPromotionGroup
            busy={state.busy}
            loading={state.loading}
            promotion={promotion}
            records={state.snapshot.promotions}
            t={t}
          />
        </div>
      </details>
    </SettingsPanel>
  )
}
