import { useState } from 'react'
import {
  createEvolutionReplaySuiteApi,
  evaluateEvolutionReplayApi,
  generateEvolutionCandidateApi,
  getEvolutionDatasetApi,
  runEvolutionReplayApi,
} from '../../../lib/evolutionClient.js'
import {
  actionMessage,
  DEFAULT_WORKFLOW_DRAFT,
  workflowCaseInputs,
} from './evolutionUtils.js'

export default function useEvolutionWorkflow({ refresh, setBusy, setMessage, t }) {
  const [workflowDataset, setWorkflowDataset] = useState(null)
  const [selectedRecordIds, setSelectedRecordIds] = useState([])
  const [workflowDraft, setWorkflowDraft] = useState({ ...DEFAULT_WORKFLOW_DRAFT })

  const prepareWorkflow = async () => {
    setBusy('prepare-workflow')
    try {
      const result = await getEvolutionDatasetApi({ limit: 200 })
      const dataset = result.dataset || null
      setWorkflowDataset(dataset)
      setSelectedRecordIds((dataset?.records || []).slice(0, 3).map((record) => record.id))
      setMessage(t('evolution.workflowDatasetReady', { count: dataset?.records?.length || 0 }))
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const toggleWorkflowRecord = (recordId) => {
    setSelectedRecordIds((current) => (
      current.includes(recordId)
        ? current.filter((id) => id !== recordId)
        : current.length < 10 ? [...current, recordId] : current
    ))
  }

  const runWorkflow = async () => {
    const selected = selectedRecordIds.filter((id) => workflowDataset?.records?.some((record) => record.id === id))
    const caseInputs = workflowCaseInputs(workflowDraft.cases)
    const required = [
      workflowDraft.target,
      workflowDraft.objective,
      workflowDraft.candidateProviderId,
      workflowDraft.candidateModel,
      workflowDraft.replayProviderId,
      workflowDraft.replayModel,
      workflowDraft.evaluatorProviderId,
      workflowDraft.evaluatorModel,
      workflowDraft.baselineContent,
    ].every((value) => String(value || '').trim())
    if (!workflowDataset || !selected.length || !required) {
      setMessage(t('evolution.workflowRequired'))
      return
    }
    if (caseInputs.length !== selected.length) {
      setMessage(t('evolution.workflowCaseCount', { count: selected.length }))
      return
    }
    if (
      workflowDraft.replayProviderId.trim() === workflowDraft.evaluatorProviderId.trim()
      && workflowDraft.replayModel.trim() === workflowDraft.evaluatorModel.trim()
    ) {
      setMessage(t('evolution.workflowIndependentModel'))
      return
    }
    setBusy('run-workflow')
    try {
      const generated = await generateEvolutionCandidateApi({
        kind: 'prompt',
        target: workflowDraft.target.trim(),
        objective: workflowDraft.objective.trim(),
        datasetFingerprint: workflowDataset.datasetFingerprint,
        sourceRecordIds: selected,
        providerId: workflowDraft.candidateProviderId.trim(),
        modelName: workflowDraft.candidateModel.trim(),
      })
      const suiteResult = await createEvolutionReplaySuiteApi({
        name: workflowDraft.objective.trim().slice(0, 160),
        datasetFingerprint: workflowDataset.datasetFingerprint,
        cases: selected.map((sourceRecordId, index) => ({
          sourceRecordId,
          title: `${workflowDraft.target.trim()} #${index + 1}`,
          input: caseInputs[index],
        })),
      })
      const replayResult = await runEvolutionReplayApi({
        suiteId: suiteResult.suite.id,
        candidateId: generated.candidate.id,
        baselineContent: workflowDraft.baselineContent.trim(),
        providerId: workflowDraft.replayProviderId.trim(),
        modelName: workflowDraft.replayModel.trim(),
        parameters: { temperature: 0, maxTokens: 1_024 },
      })
      const evaluationResult = await evaluateEvolutionReplayApi(
        replayResult.replay.id,
        {
          providerId: workflowDraft.evaluatorProviderId.trim(),
          modelName: workflowDraft.evaluatorModel.trim(),
        },
      )
      await refresh()
      setMessage(t('evolution.workflowCompleted', { verdict: evaluationResult.evaluation.verdict }))
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  return {
    prepareWorkflow,
    runWorkflow,
    selectedRecordIds,
    setWorkflowDraft,
    toggleWorkflowRecord,
    workflowDataset,
    workflowDraft,
  }
}
