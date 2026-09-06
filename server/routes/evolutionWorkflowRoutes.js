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
import { appendEvolutionFeedback, listEvolutionEvidence } from '../services/evolutionEvidenceStore.js'
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
import { errorBody, operationForResult, requestIdempotencyKey } from './evolutionRouteSupport.js'

function methodError(res, allowed) {
  sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', `仅支持 ${allowed}`))
  return true
}

async function handleEvidenceAndCandidateRoutes(req, res, runtime) {
  const { url, userId, runCandidateModel } = runtime
  if (url.pathname === '/api/evolution/feedback') {
    if (req.method !== 'POST') return methodError(res, 'POST')
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const evidence = appendEvolutionFeedback({
      userId, sessionId: body.sessionId, feedback: body.feedback,
    })
    sendJson(res, 201, { ok: true, evidence })
    return true
  }
  if (url.pathname === '/api/evolution/evidence') {
    if (req.method !== 'GET') return methodError(res, 'GET')
    const evidence = listEvolutionEvidence({ userId, limit: url.searchParams.get('limit') })
    sendJson(res, 200, { ok: true, schemaVersion: 1, evidence })
    return true
  }
  if (url.pathname === '/api/evolution/dataset') {
    if (req.method !== 'GET') return methodError(res, 'GET')
    const dataset = buildEvolutionDataset({
      userId, limit: url.searchParams.get('limit') || undefined,
    })
    sendJson(res, 200, { ok: true, dataset })
    return true
  }
  if (url.pathname === '/api/evolution/exclusions') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, exclusions: listEvolutionExclusions({ userId }) })
      return true
    }
    if (req.method !== 'POST') return methodError(res, 'GET 或 POST')
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    if (typeof body.excluded !== 'boolean') {
      sendJson(res, 400, errorBody('EVOLUTION_EXCLUDED_FLAG_INVALID', 'excluded must be boolean'))
      return true
    }
    const exclusion = setEvolutionEvidenceExcluded({
      userId, evidenceId: body.evidenceId, excluded: body.excluded, reason: body.reason,
    })
    sendJson(res, 200, { ok: true, exclusion })
    return true
  }
  if (url.pathname === '/api/evolution/candidates/generate') {
    if (req.method !== 'POST') return methodError(res, 'POST')
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
      userId, resultType: 'candidate', resultId: candidate.id,
    })
    sendJson(res, 201, { ok: true, candidate, operation })
    return true
  }
  if (url.pathname === '/api/evolution/candidates') {
    if (req.method !== 'GET') return methodError(res, 'GET')
    const candidates = listEvolutionCandidates({ userId, limit: url.searchParams.get('limit') })
    sendJson(res, 200, { ok: true, schemaVersion: 1, candidates })
    return true
  }
  const match = url.pathname.match(/^\/api\/evolution\/candidates\/([^/]+)$/u)
  if (!match) return false
  if (req.method !== 'GET') return methodError(res, 'GET')
  const candidate = getEvolutionCandidate({ userId, id: decodeURIComponent(match[1]) })
  sendJson(res, 200, { ok: true, candidate })
  return true
}

async function handleReplayAndEvaluationRoutes(req, res, runtime) {
  const { url, userId, evaluatorProviderId, evaluatorModelName,
    runReplayModel, runEvaluationModel } = runtime
  if (url.pathname === '/api/evolution/replay-suites') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        suites: listEvolutionReplaySuites({ userId, limit: url.searchParams.get('limit') }),
      })
      return true
    }
    if (req.method !== 'POST') return methodError(res, 'GET 或 POST')
    const body = await readJson(req, { maxBytes: 64 * 1024 })
    const suite = createEvolutionReplaySuite({
      userId,
      name: body.name,
      datasetFingerprint: body.datasetFingerprint,
      cases: body.cases,
    })
    sendJson(res, 201, { ok: true, suite })
    return true
  }
  const suiteMatch = url.pathname.match(/^\/api\/evolution\/replay-suites\/([^/]+)$/u)
  if (suiteMatch) {
    if (req.method !== 'GET') return methodError(res, 'GET')
    const suite = getEvolutionReplaySuite({ userId, id: decodeURIComponent(suiteMatch[1]) })
    sendJson(res, 200, { ok: true, suite })
    return true
  }
  if (url.pathname === '/api/evolution/replays/run') {
    if (req.method !== 'POST') return methodError(res, 'POST')
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
    const operation = operationForResult(res, { userId, resultType: 'replay', resultId: replay.id })
    sendJson(res, 201, { ok: true, replay, operation })
    return true
  }
  if (url.pathname === '/api/evolution/replays') {
    if (req.method !== 'GET') return methodError(res, 'GET')
    sendJson(res, 200, {
      ok: true,
      schemaVersion: 1,
      replays: listEvolutionReplayRuns({ userId, limit: url.searchParams.get('limit') }),
    })
    return true
  }
  const replayMatch = url.pathname.match(/^\/api\/evolution\/replays\/([^/]+)$/u)
  if (replayMatch) {
    if (req.method !== 'GET') return methodError(res, 'GET')
    const replay = getEvolutionReplayRun({ userId, id: decodeURIComponent(replayMatch[1]) })
    sendJson(res, 200, { ok: true, replay })
    return true
  }
  if (url.pathname === '/api/evolution/evaluations') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        evaluations: listEvolutionEvaluations({ userId, limit: url.searchParams.get('limit') }),
      })
      return true
    }
    if (req.method !== 'POST') return methodError(res, 'GET 或 POST')
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const evaluation = await evaluateEvolutionReplay({
      userId,
      replayId: body.replayId,
      ...(body.evaluatorProviderId !== undefined
        ? { evaluatorProviderId: body.evaluatorProviderId }
        : evaluatorProviderId !== undefined ? { evaluatorProviderId } : {}),
      ...(body.evaluatorModelName !== undefined
        ? { evaluatorModelName: body.evaluatorModelName }
        : evaluatorModelName !== undefined ? { evaluatorModelName } : {}),
      idempotencyKey: requestIdempotencyKey(req, body),
      ...(typeof runEvaluationModel === 'function' ? { runModel: runEvaluationModel } : {}),
    })
    const operation = operationForResult(res, {
      userId, resultType: 'evaluation', resultId: evaluation.id,
    })
    sendJson(res, 201, { ok: true, evaluation, operation })
    return true
  }
  const evaluationMatch = url.pathname.match(/^\/api\/evolution\/evaluations\/([^/]+)$/u)
  if (!evaluationMatch) return false
  if (req.method !== 'GET') return methodError(res, 'GET')
  const evaluation = getEvolutionEvaluation({ userId, id: decodeURIComponent(evaluationMatch[1]) })
  sendJson(res, 200, { ok: true, evaluation })
  return true
}

async function handleApprovalRoutes(req, res, runtime) {
  const { url, userId, matches } = runtime
  if (matches.approvalReviewMatch) {
    if (req.method !== 'GET') return methodError(res, 'GET')
    const review = buildEvolutionApprovalReview({
      userId, evaluationId: decodeURIComponent(matches.approvalReviewMatch[1]),
    })
    sendJson(res, 200, { ok: true, review })
    return true
  }
  if (url.pathname === '/api/evolution/approvals') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        approvals: listEvolutionApprovalDecisions({ userId, limit: url.searchParams.get('limit') }),
      })
      return true
    }
    if (req.method !== 'POST') return methodError(res, 'GET 或 POST')
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const approval = decideEvolutionApproval({
      userId,
      evaluationId: body.evaluationId,
      decision: body.decision,
      reason: body.reason,
      confirmations: body.confirmations,
    })
    sendJson(res, 201, { ok: true, approval })
    return true
  }
  if (!matches.approvalMatch) return false
  if (req.method !== 'GET') return methodError(res, 'GET')
  const approval = getEvolutionApprovalDecision({
    userId, id: decodeURIComponent(matches.approvalMatch[1]),
  })
  sendJson(res, 200, { ok: true, approval })
  return true
}

async function handleCanaryRoutes(req, res, runtime) {
  const { url, userId, matches, env, readCanarySession, runOnlineGraderModel } = runtime
  if (url.pathname === '/api/evolution/canaries') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        canaries: listEvolutionCanaries({ userId, limit: url.searchParams.get('limit') }),
      })
      return true
    }
    if (req.method !== 'POST') return methodError(res, 'GET 或 POST')
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
    sendJson(res, 201, { ok: true, canary })
    return true
  }
  if (matches.canaryPolicyMatch) {
    if (req.method !== 'POST') return methodError(res, 'POST')
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const policy = createEvolutionCanaryRollbackPolicy({
      userId,
      releaseId: decodeURIComponent(matches.canaryPolicyMatch[1]),
      policy: body.policy,
      reason: body.reason,
    })
    sendJson(res, 201, { ok: true, policy })
    return true
  }
  if (matches.canaryGraderPolicyMatch) {
    if (req.method !== 'POST') return methodError(res, 'POST')
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const policy = createEvolutionCanaryGraderPolicy({
      userId,
      releaseId: decodeURIComponent(matches.canaryGraderPolicyMatch[1]),
      graderProviderId: body.graderProviderId,
      graderModelName: body.graderModelName,
      graderModelRevision: body.graderModelRevision,
      policy: body.policy,
      reason: body.reason,
    })
    sendJson(res, 201, { ok: true, policy })
    return true
  }
  if (matches.canaryGradesMatch) {
    const releaseId = decodeURIComponent(matches.canaryGradesMatch[1])
    if (req.method === 'GET') {
      const state = getEvolutionCanaryOnlineGradeState({
        userId, releaseId, limit: url.searchParams.get('limit') || 100,
      })
      sendJson(res, 200, { ok: true, state })
      return true
    }
    if (req.method !== 'POST') return methodError(res, 'GET 或 POST')
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const grade = await runEvolutionCanaryOnlineGrade({
      userId,
      releaseId,
      outcomeId: body.outcomeId,
      ...(typeof runOnlineGraderModel === 'function' ? { runModel: runOnlineGraderModel } : {}),
    })
    sendJson(res, 201, { ok: true, grade })
    return true
  }
  if (matches.canaryStartMatch || matches.canaryStopMatch) {
    if (req.method !== 'POST') return methodError(res, 'POST')
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const match = matches.canaryStartMatch || matches.canaryStopMatch
    const canary = matches.canaryStartMatch
      ? startEvolutionCanary({ userId, id: decodeURIComponent(match[1]), reason: body.reason, env })
      : stopEvolutionCanary({ userId, id: decodeURIComponent(match[1]), reason: body.reason })
    sendJson(res, 200, { ok: true, canary })
    return true
  }
  if (matches.promotionReviewMatch) {
    if (req.method !== 'GET') return methodError(res, 'GET')
    const review = buildEvolutionPromotionReview({
      userId, canaryReleaseId: decodeURIComponent(matches.promotionReviewMatch[1]), env,
    })
    sendJson(res, 200, { ok: true, review })
    return true
  }
  if (!matches.canaryMatch) return false
  if (req.method !== 'GET') return methodError(res, 'GET')
  const canary = getEvolutionCanary({ userId, id: decodeURIComponent(matches.canaryMatch[1]) })
  sendJson(res, 200, { ok: true, canary })
  return true
}

async function handlePromotionRoutes(req, res, runtime) {
  const { url, userId, matches, env } = runtime
  if (url.pathname === '/api/evolution/promotions') {
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        promotions: listEvolutionPromotions({ userId, limit: url.searchParams.get('limit') }),
      })
      return true
    }
    if (req.method !== 'POST') return methodError(res, 'GET 或 POST')
    const body = await readJson(req, { maxBytes: 16 * 1024 })
    const promotion = createEvolutionPromotion({
      userId,
      canaryReleaseId: body.canaryReleaseId,
      reason: body.reason,
      confirmations: body.confirmations,
      env,
    })
    sendJson(res, 201, { ok: true, promotion })
    return true
  }
  if (matches.promotionRevokeMatch) {
    if (req.method !== 'POST') return methodError(res, 'POST')
    const body = await readJson(req, { maxBytes: 8 * 1024 })
    const promotion = revokeEvolutionPromotion({
      userId, id: decodeURIComponent(matches.promotionRevokeMatch[1]), reason: body.reason,
    })
    sendJson(res, 200, { ok: true, promotion })
    return true
  }
  if (!matches.promotionMatch) return false
  if (req.method !== 'GET') return methodError(res, 'GET')
  const promotion = getEvolutionPromotion({
    userId, id: decodeURIComponent(matches.promotionMatch[1]),
  })
  sendJson(res, 200, { ok: true, promotion })
  return true
}

export async function handleEvolutionWorkflowRequest(req, res, runtime) {
  if (await handleEvidenceAndCandidateRoutes(req, res, runtime)) return
  if (await handleReplayAndEvaluationRoutes(req, res, runtime)) return
  if (await handleApprovalRoutes(req, res, runtime)) return
  if (await handleCanaryRoutes(req, res, runtime)) return
  if (await handlePromotionRoutes(req, res, runtime)) return
  return sendJson(res, 404, errorBody('NOT_FOUND', '证据端点不存在'))
}
