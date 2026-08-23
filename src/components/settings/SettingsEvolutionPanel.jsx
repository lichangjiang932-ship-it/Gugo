import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createEvolutionReplaySuiteApi,
  createEvolutionCanaryApi,
  createEvolutionCanaryGraderPolicyApi,
  createEvolutionCanaryRollbackPolicyApi,
  createEvolutionPromotionApi,
  decideEvolutionApprovalApi,
  evaluateEvolutionReplayApi,
  generateEvolutionCandidateApi,
  getEvolutionDatasetApi,
  getEvolutionApprovalReviewApi,
  getEvolutionCanaryOnlineGradesApi,
  getEvolutionPromotionReviewApi,
  listEvolutionApprovalsApi,
  listEvolutionCanariesApi,
  listEvolutionCandidatesApi,
  listEvolutionEvaluationsApi,
  listEvolutionEvidenceApi,
  listEvolutionPromotionsApi,
  revokeEvolutionPromotionApi,
  runEvolutionCanaryOnlineGradeApi,
  runEvolutionReplayApi,
  startEvolutionCanaryApi,
  stopEvolutionCanaryApi,
} from '../../lib/evolutionClient.js'
import { listModelProviders } from '../../lib/modelClient.js'
import { buildEvolutionDecisionInput } from './evolutionDecision.js'
import { SettingsGroup, SettingsPanel, SettingsRow } from './SettingsPrimitives.jsx'

const DEFAULT_ROLLBACK_POLICY = Object.freeze({
  windowSize: 20,
  minimumCandidateOutcomes: 3,
  minimumBaselineOutcomes: 3,
  maximumCandidateFailureRate: 0.34,
  maximumCandidateCancellationRate: 0.34,
  maximumLatencyRatio: 1.5,
})

const DEFAULT_ONLINE_GRADER_POLICY = Object.freeze({
  minimumQualityScore: 2,
  maximumQualityRegression: 0,
  maximumSafetyFailureRate: 0,
})

const DEFAULT_WORKFLOW_DRAFT = Object.freeze({
  target: 'prompt:workspace-instructions',
  objective: '',
  candidateProviderId: '',
  candidateModel: '',
  replayProviderId: '',
  replayModel: '',
  evaluatorProviderId: '',
  evaluatorModel: '',
  baselineContent: '',
  cases: '',
})

function workflowCaseInputs(value) {
  return String(value || '').split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).slice(0, 10)
}

function recordLabel(record) {
  const feedback = String(record?.payload?.feedback || '').trim()
  const summary = String(record?.payload?.summary || '').trim()
  return feedback || summary || record?.cluster || shortId(record?.id)
}

function shortId(value) {
  const text = String(value || '')
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text
}

function candidateBoundary(candidate, t) {
  return candidate?.kind === 'prompt'
    ? t('evolution.promptBoundary')
    : t('evolution.unsupportedBoundary')
}

function actionMessage(error, t) {
  return error?.message || t('evolution.actionFailed')
}

function providerModels(providers, providerId) {
  return providers.find((provider) => provider.id === String(providerId || '').trim())?.models || []
}

async function loadEvolutionSnapshot() {
  const [evidence, candidates, evaluations, approvals, canaries, promotions, providers] = await Promise.all([
    listEvolutionEvidenceApi({ limit: 25 }),
    listEvolutionCandidatesApi({ limit: 20 }),
    listEvolutionEvaluationsApi({ limit: 20 }),
    listEvolutionApprovalsApi({ limit: 20 }),
    listEvolutionCanariesApi({ limit: 20 }),
    listEvolutionPromotionsApi({ limit: 20 }),
    listModelProviders().catch(() => ({ providers: [] })),
  ])
  return {
    evidence: evidence.evidence || [],
    candidates: candidates.candidates || [],
    evaluations: evaluations.evaluations || [],
    approvals: approvals.approvals || [],
    canaries: canaries.canaries || [],
    promotions: promotions.promotions || [],
    providers: (providers.providers || []).filter((provider) => provider.enabled),
  }
}

export default function SettingsEvolutionPanel({ t }) {
  const [snapshot, setSnapshot] = useState({ evidence: [], candidates: [], evaluations: [], approvals: [], canaries: [], promotions: [], providers: [] })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [review, setReview] = useState(null)
  const [decisionReason, setDecisionReason] = useState('')
  const [canaryDraft, setCanaryDraft] = useState({
    approvalId: '',
    sessionIds: '',
    trafficPercent: '5',
    graderProviderId: '',
    graderModel: '',
    graderModelRevision: '',
  })
  const [onlineGradeStates, setOnlineGradeStates] = useState({})
  const [promotionReview, setPromotionReview] = useState(null)
  const [promotionReason, setPromotionReason] = useState('')
  const [promotionConfirmed, setPromotionConfirmed] = useState(false)
  const [workflowDataset, setWorkflowDataset] = useState(null)
  const [selectedRecordIds, setSelectedRecordIds] = useState([])
  const [workflowDraft, setWorkflowDraft] = useState({ ...DEFAULT_WORKFLOW_DRAFT })

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSnapshot(await loadEvolutionSnapshot())
      setMessage('')
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    let active = true
    void loadEvolutionSnapshot()
      .then((nextSnapshot) => {
        if (!active) return
        setSnapshot(nextSnapshot)
        setMessage('')
      })
      .catch((error) => {
        if (active) setMessage(actionMessage(error, t))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [t])

  const approved = useMemo(
    () => snapshot.approvals.filter((item) => item.decision === 'approved'),
    [snapshot.approvals],
  )

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

  const openReview = async (evaluationId) => {
    setBusy(`review:${evaluationId}`)
    try {
      const result = await getEvolutionApprovalReviewApi(evaluationId)
      setReview(result.review)
      setDecisionReason('')
      setMessage('')
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const decide = async (decision) => {
    const input = buildEvolutionDecisionInput(review, decision, decisionReason)
    if (!input) {
      setMessage(t('evolution.reasonRequired'))
      return
    }
    setBusy(`decision:${review.evaluationId}`)
    try {
      await decideEvolutionApprovalApi(input)
      setReview(null)
      setMessage(t(decision === 'approved' ? 'evolution.approved' : 'evolution.rejected'))
      await refresh()
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const createCanary = async () => {
    const sessionIds = canaryDraft.sessionIds.split(',').map((item) => item.trim()).filter(Boolean)
    const trafficPercent = Number(canaryDraft.trafficPercent)
    if (!canaryDraft.approvalId || sessionIds.length === 0
      || !canaryDraft.graderProviderId.trim()
      || !canaryDraft.graderModel.trim()
      || !canaryDraft.graderModelRevision.trim()) {
      setMessage(t('evolution.canaryScopeRequired'))
      return
    }
    setBusy('create-canary')
    try {
      const created = await createEvolutionCanaryApi({
        approvalId: canaryDraft.approvalId,
        sessionIds,
        trafficPercent,
        reason: t('evolution.canaryCreateReason'),
      })
      await configureCanaryGuardrails(created.canary, { configureRollback: true, configureGrader: true })
      setCanaryDraft((current) => ({ ...current, sessionIds: '' }))
      await refresh()
      setMessage(t('evolution.canaryCreated'))
    } catch (error) {
      try { setSnapshot(await loadEvolutionSnapshot()) } catch { /* preserve the actionable create error */ }
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const graderPolicyInput = () => ({
    graderProviderId: canaryDraft.graderProviderId.trim(),
    graderModelName: canaryDraft.graderModel.trim(),
    graderModelRevision: canaryDraft.graderModelRevision.trim(),
    policy: DEFAULT_ONLINE_GRADER_POLICY,
    reason: t('evolution.onlineGraderPolicyReason'),
  })

  const configureCanaryGuardrails = async (canary, {
    configureRollback = !canary.rollbackPolicyConfigured,
    configureGrader = !canary.onlineGraderPolicyConfigured,
  } = {}) => {
    if (configureRollback) await createEvolutionCanaryRollbackPolicyApi(canary.id, {
      policy: DEFAULT_ROLLBACK_POLICY,
      reason: t('evolution.rollbackPolicyReason'),
    })
    if (configureGrader) await createEvolutionCanaryGraderPolicyApi(canary.id, graderPolicyInput())
  }

  const resumeCanaryGuardrails = async (canary) => {
    if (!canaryDraft.graderProviderId.trim()
      || !canaryDraft.graderModel.trim()
      || !canaryDraft.graderModelRevision.trim()) {
      setMessage(t('evolution.canaryScopeRequired'))
      return
    }
    setBusy(`configure-guardrails:${canary.id}`)
    try {
      await configureCanaryGuardrails(canary)
      await refresh()
      setMessage(t('evolution.canaryCreated'))
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const loadOnlineEvidence = async (canary) => {
    setBusy(`online-evidence:${canary.id}`)
    try {
      const result = await getEvolutionCanaryOnlineGradesApi(canary.id, { limit: 100 })
      setOnlineGradeStates((current) => ({ ...current, [canary.id]: result.state }))
      setMessage('')
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const gradeOnlineOutcome = async (canary, outcomeId) => {
    setBusy(`online-grade:${outcomeId}`)
    try {
      await runEvolutionCanaryOnlineGradeApi(canary.id, outcomeId)
      const result = await getEvolutionCanaryOnlineGradesApi(canary.id, { limit: 100 })
      setOnlineGradeStates((current) => ({ ...current, [canary.id]: result.state }))
      setMessage(t('evolution.onlineGradeRecorded'))
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const changeCanaryState = async (canary, action) => {
    setBusy(`${action}:${canary.id}`)
    try {
      if (action === 'start') await startEvolutionCanaryApi(canary.id, t('evolution.canaryStartReason'))
      else await stopEvolutionCanaryApi(canary.id, t('evolution.canaryStopReason'))
      setMessage(t(action === 'start' ? 'evolution.canaryStarted' : 'evolution.canaryStopped'))
      await refresh()
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const openPromotionReview = async (canary) => {
    setBusy(`promotion-review:${canary.id}`)
    try {
      const result = await getEvolutionPromotionReviewApi(canary.id)
      setPromotionReview(result.review)
      setPromotionReason('')
      setPromotionConfirmed(false)
      setMessage('')
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const promote = async () => {
    if (!promotionReview || !promotionReason.trim() || !promotionConfirmed) {
      setMessage(t('evolution.promotionConfirmationRequired'))
      return
    }
    setBusy(`promote:${promotionReview.canaryReleaseId}`)
    try {
      await createEvolutionPromotionApi({
        canaryReleaseId: promotionReview.canaryReleaseId,
        reason: promotionReason.trim(),
        confirmations: promotionReview.confirmations,
      })
      setPromotionReview(null)
      setPromotionReason('')
      setPromotionConfirmed(false)
      setMessage(t('evolution.promotionActivated'))
      await refresh()
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const revokePromotion = async (promotion) => {
    setBusy(`revoke-promotion:${promotion.id}`)
    try {
      await revokeEvolutionPromotionApi(promotion.id, t('evolution.promotionRevokeReason'))
      setMessage(t('evolution.promotionRevoked'))
      await refresh()
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const empty = (items) => !loading && items.length === 0

  return (
    <SettingsPanel title={t('evolution.title')} description={t('evolution.subtitle')} testId="settings-evolution">
      <div className="flex items-center justify-between gap-3 text-xs text-ink-fade" role="status">
        <span>{loading ? t('evolution.loading') : message}</span>
        <button type="button" className="settings-action-button" disabled={loading || Boolean(busy)} onClick={() => void refresh()}>
          {t('evolution.refresh')}
        </button>
      </div>

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
              {snapshot.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            </datalist>
            <datalist id="evolution-candidate-model-options">
              {providerModels(snapshot.providers, workflowDraft.candidateProviderId).map((model) => <option key={model} value={model} />)}
            </datalist>
            <datalist id="evolution-replay-model-options">
              {providerModels(snapshot.providers, workflowDraft.replayProviderId).map((model) => <option key={model} value={model} />)}
            </datalist>
            <datalist id="evolution-evaluator-model-options">
              {providerModels(snapshot.providers, workflowDraft.evaluatorProviderId).map((model) => <option key={model} value={model} />)}
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

      <SettingsGroup title={t('evolution.evidence')} description={t('evolution.evidenceHint')}>
        {empty(snapshot.evidence) ? <SettingsRow title={t('evolution.emptyEvidence')} /> : snapshot.evidence.slice(0, 5).map((item) => (
          <SettingsRow key={item.id} title={item.signal || item.source || shortId(item.id)} description={item.source || shortId(item.id)}>
            <span className="settings-inline-status">{item.occurrenceCount || 1}</span>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('evolution.candidates')} description={t('evolution.candidateHint')}>
        {empty(snapshot.candidates) ? <SettingsRow title={t('evolution.emptyCandidates')} /> : snapshot.candidates.slice(0, 6).map((candidate) => (
          <SettingsRow key={candidate.id} align="start" title={candidate.title || shortId(candidate.id)} description={`${candidate.summary || candidate.target || ''} · ${candidateBoundary(candidate, t)}`}>
            <span className="settings-inline-status">{candidate.kind}</span>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('evolution.evaluations')} description={t('evolution.evaluationHint')}>
        {empty(snapshot.evaluations) ? <SettingsRow title={t('evolution.emptyEvaluations')} /> : snapshot.evaluations.slice(0, 6).map((evaluation) => (
          <SettingsRow key={evaluation.id} align="start" title={evaluation.summary || shortId(evaluation.id)} description={`${t('evolution.verdict')}: ${evaluation.verdict}`}>
            <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void openReview(evaluation.id)}>
              {t('evolution.review')}
            </button>
          </SettingsRow>
        ))}
        {review ? (
          <div className="space-y-3 border-t border-ink/10 p-4 text-xs">
            <p className="font-medium">{review.candidate.title}</p>
            <p className="text-ink-fade">{review.candidate.summary}</p>
            <p className="font-mono text-xs text-ink-fade">{t('evolution.candidateHash')}: {review.confirmations.candidateContentSha256}</p>
            {!review.eligibility.canApprove ? <p role="alert" className="text-amber-700">{t('evolution.notEligible')}: {review.eligibility.issues.join(', ')}</p> : null}
            <input className="settings-input w-full" value={decisionReason} onChange={(event) => setDecisionReason(event.target.value)} placeholder={t('evolution.reasonPlaceholder')} aria-label={t('evolution.reason')} />
            <div className="flex gap-2">
              <button type="button" className="settings-action-button settings-action-button-primary" disabled={!review.eligibility.canApprove || Boolean(busy) || Boolean(review.existingDecision)} onClick={() => void decide('approved')}>{t('evolution.approve')}</button>
              <button type="button" className="settings-action-button" disabled={Boolean(busy) || Boolean(review.existingDecision)} onClick={() => void decide('rejected')}>{t('evolution.reject')}</button>
            </div>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t('evolution.canaries')} description={t('evolution.canaryHint')}>
        <div className="grid gap-2 p-4 sm:grid-cols-3">
          <select className="settings-select" value={canaryDraft.approvalId} onChange={(event) => setCanaryDraft((value) => ({ ...value, approvalId: event.target.value }))} aria-label={t('evolution.approval')}>
            <option value="">{t('evolution.selectApproval')}</option>
            {approved.map((item) => <option key={item.id} value={item.id}>{shortId(item.id)}</option>)}
          </select>
          <input className="settings-input" value={canaryDraft.sessionIds} onChange={(event) => setCanaryDraft((value) => ({ ...value, sessionIds: event.target.value }))} placeholder={t('evolution.sessionIds')} aria-label={t('evolution.sessionIds')} />
          <input className="settings-input" type="number" min="1" max="10" value={canaryDraft.trafficPercent} onChange={(event) => setCanaryDraft((value) => ({ ...value, trafficPercent: event.target.value }))} aria-label={t('evolution.trafficPercent')} />
          <input className="settings-input" list="evolution-provider-options" value={canaryDraft.graderProviderId} onChange={(event) => setCanaryDraft((value) => ({ ...value, graderProviderId: event.target.value }))} placeholder={t('evolution.onlineGraderProvider')} aria-label={t('evolution.onlineGraderProvider')} />
          <input className="settings-input" list="evolution-canary-grader-model-options" value={canaryDraft.graderModel} onChange={(event) => setCanaryDraft((value) => ({ ...value, graderModel: event.target.value }))} placeholder={t('evolution.onlineGraderModel')} aria-label={t('evolution.onlineGraderModel')} />
          <input className="settings-input" value={canaryDraft.graderModelRevision} onChange={(event) => setCanaryDraft((value) => ({ ...value, graderModelRevision: event.target.value }))} placeholder={t('evolution.onlineGraderRevision')} aria-label={t('evolution.onlineGraderRevision')} />
          <datalist id="evolution-canary-grader-model-options">
            {providerModels(snapshot.providers, canaryDraft.graderProviderId).map((model) => <option key={model} value={model} />)}
          </datalist>
          <button type="button" className="settings-action-button sm:col-span-3" disabled={Boolean(busy) || approved.length === 0} onClick={() => void createCanary()}>{t('evolution.createCanary')}</button>
        </div>
        {empty(snapshot.canaries) ? <SettingsRow title={t('evolution.emptyCanaries')} /> : snapshot.canaries.slice(0, 6).map((canary) => {
          const onlineState = onlineGradeStates[canary.id]
          const promotionReady = onlineState?.currentEvidence?.decision === 'continue'
            && onlineState.currentEvidence.latestEvaluationCurrent === true
          return (
            <div key={canary.id}>
              <SettingsRow title={`${shortId(canary.id)} · ${t(`evolution.state.${canary.state}`)}`} description={`${canary.trafficPercent}% · ${canary.target}`}>
                {canary.state === 'created' ? <button type="button" className="settings-action-button" disabled={Boolean(busy) || !canary.rollbackPolicyConfigured || !canary.onlineGraderPolicyConfigured} onClick={() => void changeCanaryState(canary, 'start')}>{t('evolution.start')}</button> : null}
                {canary.state === 'created' && (!canary.rollbackPolicyConfigured || !canary.onlineGraderPolicyConfigured) ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void resumeCanaryGuardrails(canary)}>{t('evolution.configureCanaryGuardrails')}</button> : null}
                {canary.state === 'active' ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void changeCanaryState(canary, 'stop')}>{t('evolution.stop')}</button> : null}
                {canary.state !== 'created' ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void loadOnlineEvidence(canary)}>{t('evolution.onlineEvidence')}</button> : null}
                {canary.state === 'stopped' ? <button type="button" className="settings-action-button" disabled={Boolean(busy) || !promotionReady} onClick={() => void openPromotionReview(canary)}>{t('evolution.reviewPromotion')}</button> : null}
              </SettingsRow>
              {onlineState ? (
                <div className="space-y-2 border-t border-ink/10 px-4 py-3 text-xs">
                  <p>{t('evolution.onlineEvidenceDecision')}: {onlineState.currentEvidence?.decision || 'insufficient_evidence'}</p>
                  {onlineState.currentEvidence?.blockers?.length ? <p role="alert" className="text-amber-700">{onlineState.currentEvidence.blockers.join(', ')}</p> : null}
                  {(onlineState.outcomes || []).map((outcome) => (
                    <div key={outcome.id} className="flex items-center justify-between gap-3">
                      <span>{outcome.variant} · {outcome.terminalState} · {outcome.gradeStatus || t('evolution.onlineGradePending')}</span>
                      {!outcome.graded ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void gradeOnlineOutcome(canary, outcome.id)}>{t('evolution.runOnlineGrade')}</button> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </SettingsGroup>

      <SettingsGroup title={t('evolution.promotions')} description={t('evolution.promotionHint')}>
        {promotionReview ? (
          <div className="space-y-3 border-b border-ink/10 p-4 text-xs">
            <p className="font-medium">{promotionReview.candidate.title}</p>
            <p className="text-ink-fade">{promotionReview.candidate.summary}</p>
            <p>{t('evolution.promotionGuard')}: {promotionReview.guard.decision}</p>
            <div className="space-y-1 break-all font-mono text-xs text-ink-fade">
              <p>{t('evolution.releaseFingerprint')}: {promotionReview.confirmations.canaryReleaseFingerprint}</p>
              <p>{t('evolution.candidateHash')}: {promotionReview.confirmations.candidateContentSha256}</p>
              <p>{t('evolution.baselineFingerprint')}: {promotionReview.confirmations.rollbackBaselineSha256}</p>
              <p>{t('evolution.policyFingerprint')}: {promotionReview.confirmations.rollbackPolicyFingerprint}</p>
            </div>
            <label className="flex items-start gap-2 text-ink-soft">
              <input type="checkbox" checked={promotionConfirmed} onChange={(event) => setPromotionConfirmed(event.target.checked)} />
              <span>{t('evolution.confirmPromotionFingerprints')}</span>
            </label>
            <input className="settings-input w-full" value={promotionReason} onChange={(event) => setPromotionReason(event.target.value)} placeholder={t('evolution.promotionReasonPlaceholder')} aria-label={t('evolution.promotionReason')} />
            <div className="flex gap-2">
              <button type="button" className="settings-action-button settings-action-button-primary" disabled={Boolean(busy) || !promotionConfirmed || !promotionReason.trim()} onClick={() => void promote()}>{t('evolution.activatePromotion')}</button>
              <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => setPromotionReview(null)}>{t('common.cancel')}</button>
            </div>
          </div>
        ) : null}
        {empty(snapshot.promotions) ? <SettingsRow title={t('evolution.emptyPromotions')} /> : snapshot.promotions.slice(0, 6).map((promotion) => (
          <SettingsRow key={promotion.id} title={`${shortId(promotion.id)} · ${t(promotion.state === 'active' ? 'evolution.promotionStateActive' : 'evolution.promotionStateRevoked')}`} description={`100% · ${promotion.target}`}>
            {promotion.state === 'active' ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void revokePromotion(promotion)}>{t('evolution.revokePromotion')}</button> : null}
          </SettingsRow>
        ))}
      </SettingsGroup>
    </SettingsPanel>
  )
}
