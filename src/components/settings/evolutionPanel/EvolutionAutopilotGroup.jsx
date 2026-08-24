import { SettingsGroup, SettingsRow, SettingsToggle } from '../SettingsPrimitives.jsx'

function modelLabel(model) {
  if (!model) return '—'
  return `${model.providerId} / ${model.modelName}`
}

function runStateLabel(run, t) {
  const key = String(run?.state || 'queued')
  return t(`evolution.autoState.${key}`)
}

function runDescription(run, t) {
  if (!run) return t('evolution.autopilotNoRuns')
  const stage = String(run.stage || '').trim()
  const signal = Number(run.signalCount || 0)
  return [stage ? `${t('evolution.autopilotStage')}: ${stage}` : '', `${t('evolution.autopilotSignals')}: ${signal}`]
    .filter(Boolean)
    .join(' · ')
}

export default function EvolutionAutopilotGroup({ autopilot, t }) {
  const enabled = Boolean(autopilot.config?.enabled)
  const run = autopilot.latestRun
  const hasFailure = Boolean(run?.errorCode || run?.errorMessage)

  return (
    <SettingsGroup
      title={t('evolution.autopilot')}
      description={t('evolution.autopilotHint')}
      className="evolution-autopilot"
    >
      <SettingsRow
        title={enabled ? t('evolution.autopilotOn') : t('evolution.autopilotOff')}
        description={enabled ? t('evolution.autopilotOnHint') : t('evolution.autopilotOffHint')}
      >
        <SettingsToggle
          checked={enabled}
          disabled={autopilot.loading || autopilot.busy}
          label={t('evolution.autopilotToggle')}
          onChange={(next) => void autopilot.setEnabled(next)}
        />
      </SettingsRow>

      <SettingsRow title={t('evolution.autopilotModels')} description={t('evolution.autopilotModelsHint')} align="start">
        <div className="evolution-model-plan">
          <span>{t('evolution.autopilotGenerate')}: {modelLabel(autopilot.models?.generator)}</span>
          <span>{t('evolution.autopilotReplay')}: {modelLabel(autopilot.models?.replay)}</span>
          <span>{t('evolution.autopilotEvaluate')}: {modelLabel(autopilot.models?.evaluator)}</span>
        </div>
      </SettingsRow>

      <SettingsRow title={run ? runStateLabel(run, t) : t('evolution.autopilotWaiting')} description={runDescription(run, t)}>
        {run ? <span className={`evolution-run-state evolution-run-state-${run.state}`}>{runStateLabel(run, t)}</span> : null}
      </SettingsRow>

      {!autopilot.models && !enabled ? (
        <div className="evolution-autopilot-alert" role="alert">
          <strong>{t('evolution.autopilotCannotStart')}</strong>
          <span>{t('evolution.autopilotMissingModels')}</span>
        </div>
      ) : null}

      {hasFailure ? (
        <div className="evolution-autopilot-alert" role="alert">
          <strong>{t('evolution.autopilotFailure')}</strong>
          {run.errorCode ? <code>{run.errorCode}</code> : null}
          {run.errorMessage ? <span>{run.errorMessage}</span> : null}
        </div>
      ) : null}

      <p className="evolution-autopilot-boundary">{t('evolution.autopilotBoundary')}</p>
    </SettingsGroup>
  )
}
