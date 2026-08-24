import { SettingsGroup } from '../SettingsPrimitives.jsx'
import {
  providerModels,
  recordLabel,
  shortId,
} from './evolutionUtils.js'

export default function EvolutionWorkflowGroup({ busy, providers, workflow, t }) {
  const {
    prepareWorkflow,
    runWorkflow,
    selectedRecordIds,
    setWorkflowDraft,
    toggleWorkflowRecord,
    workflowDataset,
    workflowDraft,
  } = workflow

  return (
    <SettingsGroup title={t('evolution.workflow')} description={t('evolution.workflowHint')}>
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void prepareWorkflow()}>
            {t('evolution.prepareWorkflow')}
          </button>
          {workflowDataset ? (
            <span className="font-mono text-xs text-ink-fade">
              {t('evolution.datasetFingerprint')}: {shortId(workflowDataset.datasetFingerprint)}
            </span>
          ) : null}
        </div>
        {workflowDataset?.records?.length ? (
          <fieldset className="grid max-h-40 gap-2 overflow-y-auto rounded-control border border-ink/10 p-3 sm:grid-cols-2">
            <legend className="px-1 text-xs font-medium text-ink-soft">{t('evolution.sourceRecords')}</legend>
            {workflowDataset.records.slice(0, 20).map((record) => (
              <label key={record.id} className="flex min-w-0 items-start gap-2 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  checked={selectedRecordIds.includes(record.id)}
                  onChange={() => toggleWorkflowRecord(record.id)}
                />
                <span className="min-w-0 truncate" title={recordLabel(record)}>{recordLabel(record)}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="settings-input" value={workflowDraft.target} onChange={(event) => setWorkflowDraft((value) => ({ ...value, target: event.target.value }))} placeholder={t('evolution.target')} aria-label={t('evolution.target')} />
          <input className="settings-input" value={workflowDraft.objective} onChange={(event) => setWorkflowDraft((value) => ({ ...value, objective: event.target.value }))} placeholder={t('evolution.objective')} aria-label={t('evolution.objective')} />
          <input className="settings-input" list="evolution-provider-options" value={workflowDraft.candidateProviderId} onChange={(event) => setWorkflowDraft((value) => ({ ...value, candidateProviderId: event.target.value }))} placeholder={t('evolution.candidateProvider')} aria-label={t('evolution.candidateProvider')} />
          <input className="settings-input" list="evolution-candidate-model-options" value={workflowDraft.candidateModel} onChange={(event) => setWorkflowDraft((value) => ({ ...value, candidateModel: event.target.value }))} placeholder={t('evolution.candidateModel')} aria-label={t('evolution.candidateModel')} />
          <input className="settings-input" list="evolution-provider-options" value={workflowDraft.replayProviderId} onChange={(event) => setWorkflowDraft((value) => ({ ...value, replayProviderId: event.target.value }))} placeholder={t('evolution.replayProvider')} aria-label={t('evolution.replayProvider')} />
          <input className="settings-input" list="evolution-replay-model-options" value={workflowDraft.replayModel} onChange={(event) => setWorkflowDraft((value) => ({ ...value, replayModel: event.target.value }))} placeholder={t('evolution.replayModel')} aria-label={t('evolution.replayModel')} />
          <input className="settings-input" list="evolution-provider-options" value={workflowDraft.evaluatorProviderId} onChange={(event) => setWorkflowDraft((value) => ({ ...value, evaluatorProviderId: event.target.value }))} placeholder={t('evolution.evaluatorProvider')} aria-label={t('evolution.evaluatorProvider')} />
          <input className="settings-input" list="evolution-evaluator-model-options" value={workflowDraft.evaluatorModel} onChange={(event) => setWorkflowDraft((value) => ({ ...value, evaluatorModel: event.target.value }))} placeholder={t('evolution.evaluatorModel')} aria-label={t('evolution.evaluatorModel')} />
          <datalist id="evolution-provider-options">
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </datalist>
          <datalist id="evolution-candidate-model-options">
            {providerModels(providers, workflowDraft.candidateProviderId).map((model) => <option key={model} value={model} />)}
          </datalist>
          <datalist id="evolution-replay-model-options">
            {providerModels(providers, workflowDraft.replayProviderId).map((model) => <option key={model} value={model} />)}
          </datalist>
          <datalist id="evolution-evaluator-model-options">
            {providerModels(providers, workflowDraft.evaluatorProviderId).map((model) => <option key={model} value={model} />)}
          </datalist>
        </div>
        <textarea className="settings-input min-h-24 w-full" value={workflowDraft.baselineContent} onChange={(event) => setWorkflowDraft((value) => ({ ...value, baselineContent: event.target.value }))} placeholder={t('evolution.baselineContent')} aria-label={t('evolution.baselineContent')} />
        <textarea className="settings-input min-h-24 w-full" value={workflowDraft.cases} onChange={(event) => setWorkflowDraft((value) => ({ ...value, cases: event.target.value }))} placeholder={t('evolution.replayCases')} aria-label={t('evolution.replayCases')} />
        <p className="text-xs text-ink-fade">{t('evolution.workflowBoundary')}</p>
        <button type="button" className="settings-action-button settings-action-button-primary" disabled={Boolean(busy) || !workflowDataset?.records?.length} onClick={() => void runWorkflow()}>
          {busy === 'run-workflow' ? t('evolution.runningWorkflow') : t('evolution.runWorkflow')}
        </button>
      </div>
    </SettingsGroup>
  )
}
