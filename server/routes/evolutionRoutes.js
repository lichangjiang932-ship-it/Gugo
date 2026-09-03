import { isLocalOwnerUser } from '../adapters/authAccount.js'
import { authenticateRequest } from '../middleware.js'
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
import { reviewEvolutionConfigCandidate } from '../services/evolutionConfigReviewService.js'
import {
  configureEvolutionAutoLoop,
  getEvolutionAutoConfig,
  listEvolutionAutoRuns,
} from '../services/evolutionAutoLoopService.js'
import {
  getEvolutionOperation,
  listEvolutionOperations,
  recoverEvolutionOperationNotSent,
} from '../services/evolutionOperationService.js'
import { resumeEvolutionOperation } from '../services/evolutionOperationRuntime.js'
import { readJson, sendJson } from '../utils.js'
import { isLoopbackRequest } from '../utils/loopbackRequest.js'
import { errorBody } from './evolutionRouteSupport.js'
import { handleEvolutionWorkflowRequest } from './evolutionWorkflowRoutes.js'

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
    || (url.pathname === '/api/evolution/auto-config' && req.method === 'PUT')
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
    if (url.pathname === '/api/evolution/auto-config') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          config: getEvolutionAutoConfig({ userId }),
        })
      }
      if (req.method !== 'PUT') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 PUT'))
      }
      const body = await readJson(req, { maxBytes: 32 * 1024 })
      const config = await configureEvolutionAutoLoop({
        userId,
        input: body,
        readSession: readCanarySession,
      })
      return sendJson(res, 200, { ok: true, config })
    }
    if (url.pathname === '/api/evolution/auto-runs') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
      }
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        runs: listEvolutionAutoRuns({ userId, limit: url.searchParams.get('limit') }),
      })
    }
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
    if (url.pathname === '/api/evolution/config-reviews') {
      if (req.method !== 'POST') return sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
      const body = await readJson(req, { maxBytes: 8 * 1024 })
      const review = reviewEvolutionConfigCandidate({
        userId, candidateId: body.candidateId, cwd, env, hostEnv,
      })
      return sendJson(res, 201, { ok: true, review })
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
    const workflowResponse = await handleEvolutionWorkflowRequest(req, res, {
      env,
      userId,
      url,
      matches: {
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
      },
      readCanarySession,
      evaluatorProviderId,
      evaluatorModelName,
      runCandidateModel,
      runEvaluationModel,
      runOnlineGraderModel,
      runReplayModel,
    })
    return workflowResponse
  } catch (error) {
    return sendJson(res, error?.statusCode || 500, errorBody(
      error?.code || 'EVOLUTION_EVIDENCE_FAILED',
      error?.statusCode && error.statusCode < 500 ? error.message : '证据操作失败',
      error?.operationId || null,
    ))
  }
}
