import { isLocalOwnerUser } from '../adapters/authAccount.js'
import { authenticateRequest } from '../middleware.js'
import {
  buildEvolutionApprovalReview,
  decideEvolutionApproval,
  getEvolutionApprovalDecision,
  listEvolutionApprovalDecisions,
} from '../services/evolutionApprovalService.js'
import {
  applyEvolutionConfigCandidate,
  buildEvolutionConfigApplyReview,
  buildEvolutionConfigApprovalReview,
  decideEvolutionConfigApproval,
  getEvolutionConfigApproval,
  getEvolutionConfigChange,
  listEvolutionConfigApprovals,
  listEvolutionConfigChanges,
  reverseEvolutionConfigChange,
} from '../services/evolutionConfigChangeService.js'
import {
  evaluateEvolutionConfigReplay,
  getEvolutionConfigEvaluation,
  getEvolutionConfigReplay,
  listEvolutionConfigEvaluations,
  listEvolutionConfigReplays,
  runEvolutionConfigReplay,
} from '../services/evolutionConfigReplayService.js'
import { reconcileEvolutionConfigJournal } from '../services/evolutionConfigJournalService.js'
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
import {
  getEvolutionOperation,
  getEvolutionOperationForResult,
  listEvolutionOperations,
  recoverEvolutionOperationNotSent,
} from '../services/evolutionOperationService.js'
import { resumeEvolutionOperation } from '../services/evolutionOperationRuntime.js'
import { readJson, sendJson } from '../utils.js'
import { isLoopbackRequest } from '../utils/loopbackRequest.js'

function errorBody(code, message, operationId = null) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(operationId ? { operationId } : {}),
    },
  }
}

function requestIdempotencyKey(req, body) {
  const rawHeader = req.headers?.['idempotency-key']
  const header = String(Array.isArray(rawHeader) ? rawHeader[0] : rawHeader || '').trim()
  const bodyKey = String(body?.idempotencyKey || '').trim()
  if (header && bodyKey && header !== bodyKey) {
    throw Object.assign(new Error('Idempotency-Key header and body idempotencyKey must match'), {
      code: 'EVOLUTION_IDEMPOTENCY_KEY_CONFLICT',
      statusCode: 409,
    })
  }
  return header || bodyKey || undefined
}

function operationForResult(res, { userId, resultType, resultId }) {
  const operation = getEvolutionOperationForResult({ userId, resultType, resultId })
  if (operation) res.setHeader('X-Evolution-Operation-Id', operation.id)
  return operation
}

function authorizeLocalOwner(req, res, userId, env) {
  if (isLoopbackRequest(req) && isLocalOwnerUser(userId, env)) return true
  sendJson(res, 403, errorBody(
    'LOCAL_OWNER_ONLY',
    '演进批准、canary 与生产推广只能由服务宿主机的本地所有者操作',
  ))
  return false
}

export async function handleEvolutionRequest(req, res, {
  cwd = process.cwd(),
  env = process.env,
  hostEnv = process.env,
  readCanarySession = null,
  activateRuntimeConfig,
  evaluatorProviderId,
  evaluatorModelName,
  runCandidateModel,
  runEvaluationModel,
  runOnlineGraderModel = runEvaluationModel,
  runReplayModel,
} = {}) {
  res.setHeader('Cache-Control', 'no-store')
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, errorBody('UNAUTHORIZED', '请先登录'))
  const url = new URL(req.url, 'http://localhost')
  const approvalReviewMatch = url.pathname.match(/^\/api\/evolution\/approval-reviews\/([^/]+)$/u)
  const approvalMatch = url.pathname.match(/^\/api\/evolution\/approvals\/([^/]+)$/u)
  const canaryPolicyMatch = url.pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/rollback-policy$/u)
  const canaryGraderPolicyMatch = url.pathname.match(
    /^\/api\/evolution\/canaries\/([^/]+)\/online-grader-policy$/u,
  )
  const canaryGradesMatch = url.pathname.match(
    /^\/api\/evolution\/canaries\/([^/]+)\/online-grades$/u,
  )
  const canaryStartMatch = url.pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/start$/u)
  const canaryStopMatch = url.pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/stop$/u)
  const promotionReviewMatch = url.pathname.match(
    /^\/api\/evolution\/canaries\/([^/]+)\/promotion-review$/u,
  )
  const canaryMatch = url.pathname.match(/^\/api\/evolution\/canaries\/([^/]+)$/u)
  const promotionRevokeMatch = url.pathname.match(/^\/api\/evolution\/promotions\/([^/]+)\/revoke$/u)
  const promotionMatch = url.pathname.match(/^\/api\/evolution\/promotions\/([^/]+)$/u)
  const operationRecoverMatch = url.pathname.match(
    /^\/api\/evolution\/operations\/([^/]+)\/recover-not-sent$/u,
  )
  const operationResumeMatch = url.pathname.match(/^\/api\/evolution\/operations\/([^/]+)\/resume$/u)
  const operationMatch = url.pathname.match(/^\/api\/evolution\/operations\/([^/]+)$/u)
  const localOwnerPath = url.pathname.startsWith('/api/evolution/config-')
    || url.pathname === '/api/evolution/approvals'
    || url.pathname === '/api/evolution/canaries'
    || Boolean(approvalReviewMatch)
    || Boolean(approvalMatch)
    || Boolean(canaryPolicyMatch)
    || Boolean(canaryGraderPolicyMatch)
    || Boolean(canaryGradesMatch)
    || Boolean(canaryStartMatch)
    || Boolean(canaryStopMatch)
    || Boolean(canaryMatch)
    || url.pathname === '/api/evolution/promotions'
    || Boolean(promotionReviewMatch)
    || Boolean(promotionRevokeMatch)
    || Boolean(promotionMatch)
  if (localOwnerPath && !authorizeLocalOwner(req, res, userId, env)) return
  try {
    if (url.pathname === '/api/evolution/operations') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        operations: listEvolutionOperations({
          userId,
          kind: url.searchParams.get('kind'),
          state: url.searchParams.get('state'),
          limit: url.searchParams.get('limit') || 50,
        }),
      })
    }
    if (operationRecoverMatch) {
      if (req.method !== 'POST') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
      }
      const operationId = decodeURIComponent(operationRecoverMatch[1])
      const body = await readJson(req, { maxBytes: 8 * 1024 })
      const operation = recoverEvolutionOperationNotSent({
        userId,
        id: operationId,
        verificationConfirmed: body.verificationConfirmed,
        confirmOperationId: body.confirmOperationId,
        recoveryChallenge: body.recoveryChallenge,
        recoveryRevision: body.recoveryRevision,
      })
      return sendJson(res, 200, { ok: true, operation })
    }
    if (operationResumeMatch) {
      if (req.method !== 'POST') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
      }
      const result = await resumeEvolutionOperation({
        userId,
        id: decodeURIComponent(operationResumeMatch[1]),
        ...(typeof runCandidateModel === 'function' ? { runCandidateModel } : {}),
        ...(typeof runReplayModel === 'function' ? { runReplayModel } : {}),
        ...(typeof runEvaluationModel === 'function' ? { runEvaluationModel } : {}),
      })
      res.setHeader('X-Evolution-Operation-Id', result.operation.id)
      return sendJson(res, 200, { ok: true, ...result })
    }
    if (operationMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      const operation = getEvolutionOperation({
        userId,
        id: decodeURIComponent(operationMatch[1]),
      })
      return sendJson(res, 200, { ok: true, operation })
    }
    if (url.pathname.startsWith('/api/evolution/config-')) {
      reconcileEvolutionConfigJournal({
        userId,
        cwd,
        env,
        ...(typeof activateRuntimeConfig === 'function' ? { activate: activateRuntimeConfig } : {}),
      })
    }
    if (url.pathname === '/api/evolution/config-replays') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          schemaVersion: 1,
          replays: listEvolutionConfigReplays({ userId, limit: url.searchParams.get('limit') }),
        })
      }
      if (req.method !== 'POST') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
      }
      const body = await readJson(req, { maxBytes: 8 * 1024 })
      const replay = runEvolutionConfigReplay({
        userId,
        candidateId: body.candidateId,
        cwd,
        env,
        hostEnv,
      })
      return sendJson(res, 201, { ok: true, replay })
    }
    const configReplayMatch = url.pathname.match(/^\/api\/evolution\/config-replays\/([^/]+)$/u)
    if (configReplayMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      const replay = getEvolutionConfigReplay({
        userId,
        id: decodeURIComponent(configReplayMatch[1]),
      })
      return sendJson(res, 200, { ok: true, replay })
    }
    if (url.pathname === '/api/evolution/config-evaluations') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          schemaVersion: 1,
          evaluations: listEvolutionConfigEvaluations({ userId, limit: url.searchParams.get('limit') }),
        })
      }
      if (req.method !== 'POST') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
      }
      const body = await readJson(req, { maxBytes: 8 * 1024 })
      const evaluation = evaluateEvolutionConfigReplay({ userId, replayId: body.replayId })
      return sendJson(res, 201, { ok: true, evaluation })
    }
    const configEvaluationMatch = url.pathname.match(
      /^\/api\/evolution\/config-evaluations\/([^/]+)$/u,
    )
    if (configEvaluationMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      const evaluation = getEvolutionConfigEvaluation({
        userId,
        id: decodeURIComponent(configEvaluationMatch[1]),
      })
      return sendJson(res, 200, { ok: true, evaluation })
    }
    const configApprovalReviewMatch = url.pathname.match(
      /^\/api\/evolution\/config-approval-reviews\/([^/]+)$/u,
    )
    if (configApprovalReviewMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      const review = buildEvolutionConfigApprovalReview({
        userId,
        evaluationId: decodeURIComponent(configApprovalReviewMatch[1]),
      })
      return sendJson(res, 200, { ok: true, review })
    }
    if (url.pathname === '/api/evolution/config-approvals') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          schemaVersion: 1,
          approvals: listEvolutionConfigApprovals({ userId, limit: url.searchParams.get('limit') }),
        })
      }
      if (req.method !== 'POST') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
      }
      const body = await readJson(req, { maxBytes: 16 * 1024 })
      const approval = decideEvolutionConfigApproval({
        userId,
        evaluationId: body.evaluationId,
        decision: body.decision,
        reason: body.reason,
        confirmations: body.confirmations,
      })
      return sendJson(res, 201, { ok: true, approval })
    }
    const configApprovalMatch = url.pathname.match(
      /^\/api\/evolution\/config-approvals\/([^/]+)$/u,
    )
    if (configApprovalMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      const approval = getEvolutionConfigApproval({
        userId,
        id: decodeURIComponent(configApprovalMatch[1]),
      })
      return sendJson(res, 200, { ok: true, approval })
    }
    const configApplyReviewMatch = url.pathname.match(
      /^\/api\/evolution\/config-apply-reviews\/([^/]+)$/u,
    )
    if (configApplyReviewMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      const review = buildEvolutionConfigApplyReview({
        userId,
        approvalId: decodeURIComponent(configApplyReviewMatch[1]),
        cwd,
        env,
        hostEnv,
      })
      return sendJson(res, 200, { ok: true, review })
    }
    if (url.pathname === '/api/evolution/config-changes/apply') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
      }
      const body = await readJson(req, { maxBytes: 16 * 1024 })
      const change = applyEvolutionConfigCandidate({
        userId,
        approvalId: body.approvalId,
        reason: body.reason,
        confirmationSha256: body.confirmationSha256,
        cwd,
        env,
        hostEnv,
        ...(typeof activateRuntimeConfig === 'function' ? { activate: activateRuntimeConfig } : {}),
      })
      return sendJson(res, 201, { ok: true, change })
    }
    if (url.pathname === '/api/evolution/config-changes') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        changes: listEvolutionConfigChanges({ userId, limit: url.searchParams.get('limit') }),
      })
    }
    const configReversalMatch = url.pathname.match(
      /^\/api\/evolution\/config-changes\/([^/]+)\/(rollback|revoke)$/u,
    )
    if (configReversalMatch) {
      if (req.method !== 'POST') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
      }
      const body = await readJson(req, { maxBytes: 16 * 1024 })
      const change = reverseEvolutionConfigChange({
        userId,
        applyId: decodeURIComponent(configReversalMatch[1]),
        operation: configReversalMatch[2],
        reason: body.reason,
        confirmationSha256: body.confirmationSha256,
        cwd,
        env,
        hostEnv,
        ...(typeof activateRuntimeConfig === 'function' ? { activate: activateRuntimeConfig } : {}),
      })
      return sendJson(res, 201, { ok: true, change })
    }
    const configChangeMatch = url.pathname.match(/^\/api\/evolution\/config-changes\/([^/]+)$/u)
    if (configChangeMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      const change = getEvolutionConfigChange({
        userId,
        id: decodeURIComponent(configChangeMatch[1]),
      })
      return sendJson(res, 200, { ok: true, change })
    }
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
  } catch (error) {
    return sendJson(res, error?.statusCode || 500, errorBody(
      error?.code || 'EVOLUTION_EVIDENCE_FAILED',
      error?.statusCode && error.statusCode < 500 ? error.message : '证据操作失败',
      error?.operationId || null,
    ))
  }
}
