import { authHeaders, jsonOk } from './agentClient.js'

export async function recordChatFeedback(value, sessionId) {
  const feedback = String(value || '').trim()
  if (!feedback) return false
  const resp = await fetch('/api/evolution/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ feedback, sessionId: sessionId || null }),
  })
  await jsonOk(resp)
  return true
}

export async function listEvolutionEvidenceApi({ limit = 100 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/evidence?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionDatasetApi({ limit = 200 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/dataset?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function listEvolutionExclusionsApi() {
  const resp = await fetch('/api/evolution/exclusions', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function setEvolutionEvidenceExcludedApi(evidenceId, excluded, reason = null) {
  const resp = await fetch('/api/evolution/exclusions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ evidenceId, excluded, reason }),
  })
  return jsonOk(resp)
}

export async function generateEvolutionCandidateApi(input) {
  const resp = await fetch('/api/evolution/candidates/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionCandidatesApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/candidates?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionCandidateApi(id) {
  const resp = await fetch(`/api/evolution/candidates/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function createEvolutionReplaySuiteApi(input) {
  const resp = await fetch('/api/evolution/replay-suites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionReplaySuitesApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/replay-suites?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function runEvolutionReplayApi(input) {
  const resp = await fetch('/api/evolution/replays/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionReplayRunsApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/replays?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionReplayRunApi(id) {
  const resp = await fetch(`/api/evolution/replays/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function evaluateEvolutionReplayApi(replayId, evaluator = {}) {
  const evaluatorProviderId = String(evaluator?.providerId || '').trim()
  const evaluatorModelName = String(evaluator?.modelName || '').trim()
  const resp = await fetch('/api/evolution/evaluations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      replayId,
      ...(evaluatorProviderId ? { evaluatorProviderId } : {}),
      ...(evaluatorModelName ? { evaluatorModelName } : {}),
    }),
  })
  return jsonOk(resp)
}

export async function listEvolutionEvaluationsApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/evaluations?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionEvaluationApi(id) {
  const resp = await fetch(`/api/evolution/evaluations/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function getEvolutionApprovalReviewApi(evaluationId) {
  const resp = await fetch(
    `/api/evolution/approval-reviews/${encodeURIComponent(String(evaluationId || ''))}`,
    { headers: authHeaders() },
  )
  return jsonOk(resp)
}

export async function decideEvolutionApprovalApi(input) {
  const resp = await fetch('/api/evolution/approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionApprovalsApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/approvals?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionApprovalApi(id) {
  const resp = await fetch(`/api/evolution/approvals/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function createEvolutionCanaryApi(input) {
  const resp = await fetch('/api/evolution/canaries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionCanariesApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/canaries?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionCanaryApi(id) {
  const resp = await fetch(`/api/evolution/canaries/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function createEvolutionCanaryRollbackPolicyApi(id, input) {
  const resp = await fetch(
    `/api/evolution/canaries/${encodeURIComponent(String(id || ''))}/rollback-policy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(input || {}),
    },
  )
  return jsonOk(resp)
}

export async function startEvolutionCanaryApi(id, reason) {
  const resp = await fetch(`/api/evolution/canaries/${encodeURIComponent(String(id || ''))}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ reason }),
  })
  return jsonOk(resp)
}

export async function stopEvolutionCanaryApi(id, reason) {
  const resp = await fetch(`/api/evolution/canaries/${encodeURIComponent(String(id || ''))}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ reason }),
  })
  return jsonOk(resp)
}

export async function getEvolutionOperationApi(id) {
  const resp = await fetch(`/api/evolution/operations/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function resumeEvolutionOperationApi(id) {
  const resp = await fetch(
    `/api/evolution/operations/${encodeURIComponent(String(id || ''))}/resume`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: '{}',
    },
  )
  return jsonOk(resp)
}

export async function recoverEvolutionOperationNotSentApi(id, input) {
  const resp = await fetch(
    `/api/evolution/operations/${encodeURIComponent(String(id || ''))}/recover-not-sent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(input || {}),
    },
  )
  return jsonOk(resp)
}

export async function runEvolutionConfigReplayApi(candidateId) {
  const resp = await fetch('/api/evolution/config-replays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ candidateId }),
  })
  return jsonOk(resp)
}

export async function evaluateEvolutionConfigReplayApi(replayId) {
  const resp = await fetch('/api/evolution/config-evaluations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ replayId }),
  })
  return jsonOk(resp)
}

export async function getEvolutionConfigApprovalReviewApi(evaluationId) {
  const resp = await fetch(
    `/api/evolution/config-approval-reviews/${encodeURIComponent(String(evaluationId || ''))}`,
    { headers: authHeaders() },
  )
  return jsonOk(resp)
}

export async function decideEvolutionConfigApprovalApi(input) {
  const resp = await fetch('/api/evolution/config-approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function getEvolutionConfigApplyReviewApi(approvalId) {
  const resp = await fetch(
    `/api/evolution/config-apply-reviews/${encodeURIComponent(String(approvalId || ''))}`,
    { headers: authHeaders() },
  )
  return jsonOk(resp)
}

export async function applyEvolutionConfigCandidateApi(input) {
  const resp = await fetch('/api/evolution/config-changes/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionConfigChangesApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/config-changes?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function reverseEvolutionConfigChangeApi(id, operation, input) {
  const resp = await fetch(
    `/api/evolution/config-changes/${encodeURIComponent(String(id || ''))}/${operation}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(input || {}),
    },
  )
  return jsonOk(resp)
}

export async function createEvolutionCanaryGraderPolicyApi(id, input) {
  const resp = await fetch(
    `/api/evolution/canaries/${encodeURIComponent(String(id || ''))}/online-grader-policy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(input || {}),
    },
  )
  return jsonOk(resp)
}

export async function getEvolutionCanaryOnlineGradesApi(id, { limit = 100 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(
    `/api/evolution/canaries/${encodeURIComponent(String(id || ''))}/online-grades?${query}`,
    { headers: authHeaders() },
  )
  return jsonOk(resp)
}

export async function runEvolutionCanaryOnlineGradeApi(id, outcomeId) {
  const resp = await fetch(
    `/api/evolution/canaries/${encodeURIComponent(String(id || ''))}/online-grades`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ outcomeId }),
    },
  )
  return jsonOk(resp)
}

export async function getEvolutionPromotionReviewApi(canaryReleaseId) {
  const resp = await fetch(
    `/api/evolution/canaries/${encodeURIComponent(String(canaryReleaseId || ''))}/promotion-review`,
    { headers: authHeaders() },
  )
  return jsonOk(resp)
}

export async function createEvolutionPromotionApi(input) {
  const resp = await fetch('/api/evolution/promotions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input || {}),
  })
  return jsonOk(resp)
}

export async function listEvolutionPromotionsApi({ limit = 50 } = {}) {
  const query = new URLSearchParams({ limit: String(limit) })
  const resp = await fetch(`/api/evolution/promotions?${query}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getEvolutionPromotionApi(id) {
  const resp = await fetch(`/api/evolution/promotions/${encodeURIComponent(String(id || ''))}`, {
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export async function revokeEvolutionPromotionApi(id, reason) {
  const resp = await fetch(
    `/api/evolution/promotions/${encodeURIComponent(String(id || ''))}/revoke`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ reason }),
    },
  )
  return jsonOk(resp)
}
