import {
  buildEvolutionApprovalReview,
  decideEvolutionApproval,
  getEvolutionApprovalDecision,
  listEvolutionApprovalDecisions,
} from '../services/evolutionApprovalService.js'
import {
  generateEvolutionCandidate,
  getEvolutionCandidate,
  listEvolutionCandidates,
} from '../services/evolutionCandidateService.js'
import {
  createEvolutionCanary,
  getEvolutionCanary,
  listEvolutionCanaries,
  startEvolutionCanary,
  stopEvolutionCanary,
} from '../services/evolutionCanaryService.js'
import {
  buildEvolutionDataset,
  listEvolutionExclusions,
  setEvolutionEvidenceExcluded,
} from '../services/evolutionDatasetService.js'
import {
  appendEvolutionFeedback,
  listEvolutionEvidence,
} from '../services/evolutionEvidenceStore.js'
import {
  evaluateEvolutionReplay,
  getEvolutionEvaluation,
  listEvolutionEvaluations,
} from '../services/evolutionEvaluationService.js'
import { createEvolutionCanaryRollbackPolicy } from '../services/evolutionRollbackService.js'
import {
  createEvolutionCanaryGraderPolicy,
  getEvolutionCanaryOnlineGradeState,
  runEvolutionCanaryOnlineGrade,
} from '../services/evolutionOnlineGraderService.js'
import {
  buildEvolutionPromotionReview,
  createEvolutionPromotion,
  getEvolutionPromotion,
  listEvolutionPromotions,
  revokeEvolutionPromotion,
} from '../services/evolutionPromotionService.js'
import {
  createEvolutionReplaySuite,
  getEvolutionReplayRun,
  getEvolutionReplaySuite,
  listEvolutionReplayRuns,
  listEvolutionReplaySuites,
  runEvolutionReplay,
} from '../services/evolutionReplayService.js'
import { readJson, sendJson } from '../utils.js'
import {
  errorBody,
  operationForResult,
  requestIdempotencyKey,
} from './evolutionRouteSupport.js'

export async function handleEvolutionWorkflowRequest(req, res, {
  env,
  userId,
  url,
  matches,
  readCanarySession,
  evaluatorProviderId,
  evaluatorModelName,
  runCandidateModel,
  runEvaluationModel,
  runOnlineGraderModel,
  runReplayModel,
}) {
  const {
    approvalReviewMatch,
    approvalMatch,
    canaryPolicyMatch,
    canaryGraderPolicyMatch,
    canaryGradesMatch,
    canaryStartMatch,
    canaryStopMatch,
    promotionReviewMatch,
    canaryMatch,
    promotionRevokeMatch,
    promotionMatch,
  } = matches
  if (url.pathname === '/api/evolution/feedback') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    }
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const evidence = appendEvolutionFeedback({
      userId,
      sessionId: body.sessionId,
      feedback: body.feedback,
    })
    return sendJson(res, 201, { ok: true, evidence })
  }
  if (url.pathname === '/api/evolution/evidence') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const evidence = listEvolutionEvidence({
      userId,
      limit: url.searchParams.get('limit'),
    })
    return sendJson(res, 200, { ok: true, schemaVersion: 1, evidence })
  }
  if (url.pathname === '/api/evolution/dataset') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const dataset = buildEvolutionDataset({
      userId,
      limit: url.searchParams.get('limit') || undefined,
    })
    return sendJson(res, 200, { ok: true, dataset })
  }
  if (url.pathname === '/api/evolution/exclusions') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, exclusions: listEvolutionExclusions({ userId }) })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    }
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    if (typeof body.excluded !== 'boolean') {
      return sendJson(res, 400, errorBody('EVOLUTION_EXCLUDED_FLAG_INVALID', 'excluded must be boolean'))
    }
    const exclusion = setEvolutionEvidenceExcluded({
      userId,
      evidenceId: body.evidenceId,
      excluded: body.excluded,
      reason: body.reason,
    })
    return sendJson(res, 200, { ok: true, exclusion })
  }
  if (url.pathname === '/api/evolution/candidates/generate') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    }
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const candidate = await generateEvolutionCandidate({
      userId,
      kind: body.kind,
      target: body.target,
      objective: body.objective,
      datasetFingerprint: body.datasetFingerprint,
      sourceRecordIds: body.sourceRecordIds,
      providerId: body.providerId,
      modelName: body.modelName,
      idempotencyKey: requestIdempotencyKey(req, body),
      ...(typeof runCandidateModel === 'function' ? { runModel: runCandidateModel } : {}),
    })
    const operation = operationForResult(res, {
      userId,
      resultType: 'candidate',
      resultId: candidate.id,
    })
    return sendJson(res, 201, { ok: true, candidate, operation })
  }
  if (url.pathname === '/api/evolution/candidates') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const candidates = listEvolutionCandidates({
      userId,
      limit: url.searchParams.get('limit'),
    })
    return sendJson(res, 200, { ok: true, schemaVersion: 1, candidates })
  }
  const candidateMatch = url.pathname.match(/^\/api\/evolution\/candidates\/([^/]+)$/u)
  if (candidateMatch) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const candidate = getEvolutionCandidate({
      userId,
      id: decodeURIComponent(candidateMatch[1]),
    })
    return sendJson(res, 200, { ok: true, candidate })
  }
  if (url.pathname === '/api/evolution/replay-suites') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        suites: listEvolutionReplaySuites({ userId, limit: url.searchParams.get('limit') }),
      })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    }
    const body = await readJson(req, { maxBytes: 64 * 1024 })
    const suite = createEvolutionReplaySuite({
      userId,
      name: body.name,
      datasetFingerprint: body.datasetFingerprint,
      cases: body.cases,
    })
    return sendJson(res, 201, { ok: true, suite })
  }
  const suiteMatch = url.pathname.match(/^\/api\/evolution\/replay-suites\/([^/]+)$/u)
  if (suiteMatch) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const suite = getEvolutionReplaySuite({ userId, id: decodeURIComponent(suiteMatch[1]) })
    return sendJson(res, 200, { ok: true, suite })
  }
  if (url.pathname === '/api/evolution/replays/run') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    }
    const body = await readJson(req, { maxBytes: 48 * 1024 })
    const replay = await runEvolutionReplay({
      userId,
      suiteId: body.suiteId,
      candidateId: body.candidateId,
      baselineContent: body.baselineContent,
      providerId: body.providerId,
      modelName: body.modelName,
      parameters: body.parameters,
      idempotencyKey: requestIdempotencyKey(req, body),
      ...(typeof runReplayModel === 'function' ? { runModel: runReplayModel } : {}),
    })
    const operation = operationForResult(res, {
      userId,
      resultType: 'replay',
      resultId: replay.id,
    })
    return sendJson(res, 201, { ok: true, replay, operation })
  }
  if (url.pathname === '/api/evolution/replays') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    return sendJson(res, 200, {
      ok: true,
      schemaVersion: 1,
      replays: listEvolutionReplayRuns({ userId, limit: url.searchParams.get('limit') }),
    })
  }
  const replayMatch = url.pathname.match(/^\/api\/evolution\/replays\/([^/]+)$/u)
  if (replayMatch) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const replay = getEvolutionReplayRun({ userId, id: decodeURIComponent(replayMatch[1]) })
    return sendJson(res, 200, { ok: true, replay })
  }
  if (url.pathname === '/api/evolution/evaluations') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        evaluations: listEvolutionEvaluations({ userId, limit: url.searchParams.get('limit') }),
      })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    }
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const evaluation = await evaluateEvolutionReplay({
      userId,
      replayId: body.replayId,
      ...(body.evaluatorProviderId !== undefined
        ? { evaluatorProviderId: body.evaluatorProviderId }
        : evaluatorProviderId !== undefined
          ? { evaluatorProviderId }
          : {}),
      ...(body.evaluatorModelName !== undefined
        ? { evaluatorModelName: body.evaluatorModelName }
        : evaluatorModelName !== undefined
          ? { evaluatorModelName }
          : {}),
      idempotencyKey: requestIdempotencyKey(req, body),
      ...(typeof runEvaluationModel === 'function' ? { runModel: runEvaluationModel } : {}),
    })
    const operation = operationForResult(res, {
      userId,
      resultType: 'evaluation',
      resultId: evaluation.id,
    })
    return sendJson(res, 201, { ok: true, evaluation, operation })
  }
  const evaluationMatch = url.pathname.match(/^\/api\/evolution\/evaluations\/([^/]+)$/u)
  if (evaluationMatch) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const evaluation = getEvolutionEvaluation({
      userId,
      id: decodeURIComponent(evaluationMatch[1]),
    })
    return sendJson(res, 200, { ok: true, evaluation })
  }
  if (approvalReviewMatch) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const review = buildEvolutionApprovalReview({
      userId,
      evaluationId: decodeURIComponent(approvalReviewMatch[1]),
    })
    return sendJson(res, 200, { ok: true, review })
  }
  if (url.pathname === '/api/evolution/approvals') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        approvals: listEvolutionApprovalDecisions({ userId, limit: url.searchParams.get('limit') }),
      })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    }
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const approval = decideEvolutionApproval({
      userId,
      evaluationId: body.evaluationId,
      decision: body.decision,
      reason: body.reason,
      confirmations: body.confirmations,
    })
    return sendJson(res, 201, { ok: true, approval })
  }
  if (approvalMatch) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const approval = getEvolutionApprovalDecision({
      userId,
      id: decodeURIComponent(approvalMatch[1]),
    })
    return sendJson(res, 200, { ok: true, approval })
  }
  if (url.pathname === '/api/evolution/canaries') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        canaries: listEvolutionCanaries({ userId, limit: url.searchParams.get('limit') }),
      })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    }
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const canary = await createEvolutionCanary({
      userId,
      approvalId: body.approvalId,
      sessionIds: body.sessionIds,
      trafficPercent: body.trafficPercent,
      reason: body.reason,
      readSession: readCanarySession,
      env,
    })
    return sendJson(res, 201, { ok: true, canary })
  }
  if (canaryPolicyMatch) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    }
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const policy = createEvolutionCanaryRollbackPolicy({
      userId,
      releaseId: decodeURIComponent(canaryPolicyMatch[1]),
      policy: body.policy,
      reason: body.reason,
    })
    return sendJson(res, 201, { ok: true, policy })
  }
  if (canaryGraderPolicyMatch) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    }
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const policy = createEvolutionCanaryGraderPolicy({
      userId,
      releaseId: decodeURIComponent(canaryGraderPolicyMatch[1]),
      graderProviderId: body.graderProviderId,
      graderModelName: body.graderModelName,
      graderModelRevision: body.graderModelRevision,
      policy: body.policy,
      reason: body.reason,
    })
    return sendJson(res, 201, { ok: true, policy })
  }
  if (canaryGradesMatch) {
    const releaseId = decodeURIComponent(canaryGradesMatch[1])
    if (req.method === 'GET') {
      const state = getEvolutionCanaryOnlineGradeState({
        userId,
        releaseId,
        limit: url.searchParams.get('limit') || 100,
      })
      return sendJson(res, 200, { ok: true, state })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    }
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const grade = await runEvolutionCanaryOnlineGrade({
      userId,
      releaseId,
      outcomeId: body.outcomeId,
      ...(typeof runOnlineGraderModel === 'function' ? { runModel: runOnlineGraderModel } : {}),
    })
    return sendJson(res, 201, { ok: true, grade })
  }
  if (canaryStartMatch) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    }
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const canary = startEvolutionCanary({
      userId,
      id: decodeURIComponent(canaryStartMatch[1]),
      reason: body.reason,
      env,
    })
    return sendJson(res, 200, { ok: true, canary })
  }
  if (canaryStopMatch) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    }
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const canary = stopEvolutionCanary({
      userId,
      id: decodeURIComponent(canaryStopMatch[1]),
      reason: body.reason,
    })
    return sendJson(res, 200, { ok: true, canary })
  }
  if (promotionReviewMatch) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const review = buildEvolutionPromotionReview({
      userId,
      canaryReleaseId: decodeURIComponent(promotionReviewMatch[1]),
      env,
    })
    return sendJson(res, 200, { ok: true, review })
  }
  if (canaryMatch) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const canary = getEvolutionCanary({ userId, id: decodeURIComponent(canaryMatch[1]) })
    return sendJson(res, 200, { ok: true, canary })
  }
  if (url.pathname === '/api/evolution/promotions') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        promotions: listEvolutionPromotions({ userId, limit: url.searchParams.get('limit') }),
      })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    }
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const promotion = createEvolutionPromotion({
      userId,
      canaryReleaseId: body.canaryReleaseId,
      reason: body.reason,
      confirmations: body.confirmations,
      env,
    })
    return sendJson(res, 201, { ok: true, promotion })
  }
  if (promotionRevokeMatch) {
    if (req.method !== 'POST') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    }
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const promotion = revokeEvolutionPromotion({
      userId,
      id: decodeURIComponent(promotionRevokeMatch[1]),
      reason: body.reason,
    })
    return sendJson(res, 200, { ok: true, promotion })
  }
  if (promotionMatch) {
    if (req.method !== 'GET') {
      return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    }
    const promotion = getEvolutionPromotion({
      userId,
      id: decodeURIComponent(promotionMatch[1]),
    })
    return sendJson(res, 200, { ok: true, promotion })
  }
  return sendJson(res, 404, errorBody('NOT_FOUND', '证据端点不存在'))
}
