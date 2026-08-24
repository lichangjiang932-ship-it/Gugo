export const DEFAULT_ROLLBACK_POLICY = Object.freeze({
  windowSize: 20,
  minimumCandidateOutcomes: 3,
  minimumBaselineOutcomes: 3,
  maximumCandidateFailureRate: 0.34,
  maximumCandidateCancellationRate: 0.34,
  maximumLatencyRatio: 1.5,
})

export const DEFAULT_ONLINE_GRADER_POLICY = Object.freeze({
  minimumQualityScore: 2,
  maximumQualityRegression: 0,
  maximumSafetyFailureRate: 0,
})

export const DEFAULT_WORKFLOW_DRAFT = Object.freeze({
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

export const DEFAULT_CANARY_DRAFT = Object.freeze({
  approvalId: '',
  sessionIds: '',
  trafficPercent: '5',
  graderProviderId: '',
  graderModel: '',
  graderModelRevision: '',
})

export function workflowCaseInputs(value) {
  return String(value || '').split(/\r?\n/u).map((item) => item.trim()).filter(Boolean).slice(0, 10)
}

export function shortId(value) {
  const text = String(value || '')
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text
}

export function recordLabel(record) {
  const feedback = String(record?.payload?.feedback || '').trim()
  const summary = String(record?.payload?.summary || '').trim()
  return feedback || summary || record?.cluster || shortId(record?.id)
}

export function candidateBoundary(candidate, t) {
  return candidate?.kind === 'prompt'
    ? t('evolution.promptBoundary')
    : t('evolution.unsupportedBoundary')
}

export function actionMessage(error, t) {
  return error?.message || t('evolution.actionFailed')
}

export function providerModels(providers, providerId) {
  return providers.find((provider) => provider.id === String(providerId || '').trim())?.models || []
}
