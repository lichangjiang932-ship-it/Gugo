import { isLocalOwnerUser } from '../adapters/authAccount.js'
import { authenticateRequest } from '../middleware.js'
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
import {
  createEvolutionCanaryRollbackPolicy,
} from '../services/evolutionRollbackService.js'
import {
  createEvolutionReplaySuite,
  getEvolutionReplayRun,
  getEvolutionReplaySuite,
  listEvolutionReplayRuns,
  listEvolutionReplaySuites,
  runEvolutionReplay,
} from '../services/evolutionReplayService.js'
import { readJson, sendJson } from '../utils.js'
import { isLoopbackRequest } from '../utils/loopbackRequest.js'

function errorBody(code, message) {
  return { ok: false, error: { code, message } }
}

function authorizeLocalOwner(req, res, userId, env) {
  if (isLoopbackRequest(req) && isLocalOwnerUser(userId, env)) return true
  sendJson(res, 403, errorBody(
    'LOCAL_OWNER_ONLY',
    '演进批准与 canary 只能由服务宿主机的本地所有者操作',
  ))
  return false
}

export async function handleEvolutionRequest(req, res, {
  env = process.env,
  evaluatorModelName,
  runCandidateModel,
  runEvaluationModel,
  runReplayModel,
} = {}) {
  res.setHeader('Cache-Control', 'no-store')
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, errorBody('UNAUTHORIZED', '请先登录'))
  const url = new URL(req.url, 'http://localhost')
  const approvalReviewMatch = url.pathname.match(/^\/api\/evolution\/approval-reviews\/([^/]+)$/u)
  const approvalMatch = url.pathname.match(/^\/api\/evolution\/approvals\/([^/]+)$/u)
  const canaryPolicyMatch = url.pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/rollback-policy$/u)
  const canaryStartMatch = url.pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/start$/u)
  const canaryStopMatch = url.pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/stop$/u)
  const canaryMatch = url.pathname.match(/^\/api\/evolution\/canaries\/([^/]+)$/u)
  const localOwnerPath = url.pathname === '/api/evolution/approvals'
    || url.pathname === '/api/evolution/canaries'
    || Boolean(approvalReviewMatch)
    || Boolean(approvalMatch)
    || Boolean(canaryPolicyMatch)
    || Boolean(canaryStartMatch)
    || Boolean(canaryStopMatch)
    || Boolean(canaryMatch)
  if (localOwnerPath && !authorizeLocalOwner(req, res, userId, env)) return
  try {
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
        modelName: body.modelName,
        ...(typeof runCandidateModel === 'function' ? { runModel: runCandidateModel } : {}),
      })
      return sendJson(res, 201, { ok: true, candidate })
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
        modelName: body.modelName,
        parameters: body.parameters,
        ...(typeof runReplayModel === 'function' ? { runModel: runReplayModel } : {}),
      })
      return sendJson(res, 201, { ok: true, replay })
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
        ...(evaluatorModelName !== undefined ? { evaluatorModelName } : {}),
        ...(typeof runEvaluationModel === 'function' ? { runModel: runEvaluationModel } : {}),
      })
      return sendJson(res, 201, { ok: true, evaluation })
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
      const canary = createEvolutionCanary({
        userId,
        approvalId: body.approvalId,
        sessionIds: body.sessionIds,
        trafficPercent: body.trafficPercent,
        reason: body.reason,
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
    if (canaryMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      const canary = getEvolutionCanary({ userId, id: decodeURIComponent(canaryMatch[1]) })
      return sendJson(res, 200, { ok: true, canary })
    }
    return sendJson(res, 404, errorBody('NOT_FOUND', '证据端点不存在'))
  } catch (error) {
    return sendJson(res, error?.statusCode || 500, errorBody(
      error?.code || 'EVOLUTION_EVIDENCE_FAILED',
      error?.statusCode && error.statusCode < 500 ? error.message : '证据操作失败',
    ))
  }
}
