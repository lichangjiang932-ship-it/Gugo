import { invokePluginService } from '../plugins/pluginRegistry.js'

const SERVICE_NAME = 'task-review-guard'
const VERDICTS = new Set(['pass', 'fixable', 'blocked', 'needs_user'])
const MAX_OBJECTIVE_CHARS = 8_000
const MAX_VERIFICATION_CHARS = 24_000
const MAX_EVIDENCE_CHARS = 12_000

function clean(value, max = 512) {
  return String(value || '').trim().slice(0, max)
}

function cleanList(value, { maxItems = 50, maxChars = 1_000 } = {}) {
  return Object.freeze((Array.isArray(value) ? value : [])
    .map((item) => clean(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems))
}

function frozenReviewer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.freeze({
    independent: value.independent === true,
    mode: clean(value.mode, 120) || 'unknown',
    reviewerModel: clean(value.reviewerModel, 512) || null,
    workerModel: clean(value.workerModel, 512) || null,
  })
}

function guardScope({ acceptance, job, step, text, evidence, artifactIds, workerModelName }) {
  const reviewer = frozenReviewer(acceptance?.reviewer)
  return Object.freeze({
    objective: clean(job?.prompt, MAX_OBJECTIVE_CHARS),
    acceptanceCriteria: cleanList(step?.input?.acceptance, { maxItems: 50, maxChars: 1_000 }),
    workerModel: clean(workerModelName || job?.modelName, 512) || null,
    workerVerification: clean(text, MAX_VERIFICATION_CHARS),
    evidence: cleanList(evidence, { maxItems: 50, maxChars: MAX_EVIDENCE_CHARS }),
    artifactIds: cleanList(artifactIds, { maxItems: 100, maxChars: 160 }),
    baseAcceptance: Object.freeze({
      verdict: 'pass',
      summary: clean(acceptance?.summary, 2_000),
      issues: cleanList(acceptance?.issues, { maxItems: 50, maxChars: 1_000 }),
      evidence: cleanList(acceptance?.evidence, { maxItems: 50, maxChars: MAX_EVIDENCE_CHARS }),
      source: clean(acceptance?.source, 120) || 'structured',
      ...(reviewer ? { reviewer } : {}),
    }),
  })
}

function guardMetadata({ pluginId, decision, error = null }) {
  return Object.freeze({
    pluginId: clean(pluginId, 80) || 'unknown',
    service: SERVICE_NAME,
    mode: 'veto_only',
    decision,
    ...(error ? { error: clean(error, 120) } : {}),
  })
}

function withGuard(acceptance, guard) {
  return { ...acceptance, guard }
}

function blockedByGuard(acceptance, { pluginId, code }) {
  return {
    verdict: 'blocked',
    summary: 'Runtime task review guard failed closed and blocked completion',
    issues: [code],
    evidence: Array.isArray(acceptance?.evidence) ? [...acceptance.evidence] : [],
    source: 'runtime_review_guard',
    ...(acceptance?.reviewer ? { reviewer: acceptance.reviewer } : {}),
    guard: guardMetadata({ pluginId, decision: 'error', error: code }),
  }
}

function normalizeGuardResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const verdict = clean(value.verdict, 40).toLowerCase()
  if (!VERDICTS.has(verdict)) return null
  return {
    verdict,
    summary: clean(value.summary, 2_000),
    issues: cleanList(value.issues, { maxItems: 50, maxChars: 1_000 }),
  }
}

export async function applyRuntimeTaskReviewGuard(input = {}, dependencies = {}) {
  const acceptance = input.acceptance
  if (!acceptance || acceptance.verdict !== 'pass') return acceptance
  const invokeService = dependencies.invokePluginService || invokePluginService
  let invoked
  try {
    invoked = await invokeService(SERVICE_NAME, 'review', [guardScope(input)])
  } catch (error) {
    return blockedByGuard(acceptance, {
      pluginId: error?.pluginId,
      code: clean(error?.code, 120) || 'PLUGIN_SERVICE_CALL_FAILED',
    })
  }
  if (!invoked?.found) return acceptance
  const result = normalizeGuardResult(invoked.value)
  if (!result) {
    return blockedByGuard(acceptance, {
      pluginId: invoked.pluginId,
      code: 'TASK_REVIEW_GUARD_RESULT_INVALID',
    })
  }
  const guard = guardMetadata({
    pluginId: invoked.pluginId,
    decision: result.verdict === 'pass' ? 'pass' : 'veto',
  })
  if (result.verdict === 'pass') return withGuard(acceptance, guard)
  return {
    verdict: result.verdict,
    summary: result.summary || 'Runtime task review guard vetoed completion',
    issues: [...result.issues],
    evidence: Array.isArray(acceptance.evidence) ? [...acceptance.evidence] : [],
    source: 'runtime_review_guard',
    ...(acceptance.reviewer ? { reviewer: acceptance.reviewer } : {}),
    guard,
  }
}

export const TASK_REVIEW_GUARD_SERVICE = SERVICE_NAME
