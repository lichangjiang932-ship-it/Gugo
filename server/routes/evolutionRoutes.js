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

function evolutionRouteMatches(pathname) {
  return {
    approvalReviewMatch: pathname.match(/^\/api\/evolution\/approval-reviews\/([^/]+)$/u),
    approvalMatch: pathname.match(/^\/api\/evolution\/approvals\/([^/]+)$/u),
    canaryPolicyMatch: pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/rollback-policy$/u),
    canaryGraderPolicyMatch: pathname.match(
      /^\/api\/evolution\/canaries\/([^/]+)\/online-grader-policy$/u,
    ),
    canaryGradesMatch: pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/online-grades$/u),
    canaryStartMatch: pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/start$/u),
    canaryStopMatch: pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/stop$/u),
    promotionReviewMatch: pathname.match(/^\/api\/evolution\/canaries\/([^/]+)\/promotion-review$/u),
    canaryMatch: pathname.match(/^\/api\/evolution\/canaries\/([^/]+)$/u),
    promotionRevokeMatch: pathname.match(/^\/api\/evolution\/promotions\/([^/]+)\/revoke$/u),
    promotionMatch: pathname.match(/^\/api\/evolution\/promotions\/([^/]+)$/u),
    operationRecoverMatch: pathname.match(/^\/api\/evolution\/operations\/([^/]+)\/recover-not-sent$/u),
    operationResumeMatch: pathname.match(/^\/api\/evolution\/operations\/([^/]+)\/resume$/u),
    operationMatch: pathname.match(/^\/api\/evolution\/operations\/([^/]+)$/u),
    configReplayMatch: pathname.match(/^\/api\/evolution\/config-replays\/([^/]+)$/u),
    configEvaluationMatch: pathname.match(/^\/api\/evolution\/config-evaluations\/([^/]+)$/u),
    configApprovalReviewMatch: pathname.match(/^\/api\/evolution\/config-approval-reviews\/([^/]+)$/u),
    configApprovalMatch: pathname.match(/^\/api\/evolution\/config-approvals\/([^/]+)$/u),
    configApplyReviewMatch: pathname.match(/^\/api\/evolution\/config-apply-reviews\/([^/]+)$/u),
    configReversalMatch: pathname.match(/^\/api\/evolution\/config-changes\/([^/]+)\/(rollback|revoke)$/u),
    configChangeMatch: pathname.match(/^\/api\/evolution\/config-changes\/([^/]+)$/u),
  }
}

function requiresLocalOwner(req, url, matches) {
  return url.pathname.startsWith('/api/evolution/config-')
    || (url.pathname === '/api/evolution/auto-config' && req.method === 'PUT')
    || url.pathname === '/api/evolution/approvals'
    || url.pathname === '/api/evolution/canaries'
    || Boolean(matches.approvalReviewMatch)
    || Boolean(matches.approvalMatch)
    || Boolean(matches.canaryPolicyMatch)
    || Boolean(matches.canaryGraderPolicyMatch)
    || Boolean(matches.canaryGradesMatch)
    || Boolean(matches.canaryStartMatch)
    || Boolean(matches.canaryStopMatch)
    || Boolean(matches.canaryMatch)
    || url.pathname === '/api/evolution/promotions'
    || Boolean(matches.promotionReviewMatch)
    || Boolean(matches.promotionRevokeMatch)
    || Boolean(matches.promotionMatch)
}

async function handleEvolutionRuntimeRoutes(req, res, runtime) {
  const { url, userId, matches } = runtime
  if (url.pathname === '/api/evolution/auto-config') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, config: getEvolutionAutoConfig({ userId }) })
      return true
    }
    if (req.method !== 'PUT') {
      sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 PUT'))
      return true
    }
    const body = await readJson(req, { maxBytes: 32 * 1024 })
    const config = await configureEvolutionAutoLoop({
      userId, input: body, readSession: runtime.readCanarySession,
    })
    sendJson(res, 200, { ok: true, config })
    return true
  }
  if (url.pathname === '/api/evolution/auto-runs') {
    sendJson(res, req.method === 'GET' ? 200 : 405, req.method === 'GET'
      ? {
          ok: true,
          schemaVersion: 1,
          runs: listEvolutionAutoRuns({ userId, limit: url.searchParams.get('limit') }),
        }
      : errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    return true
  }
  if (url.pathname === '/api/evolution/operations') {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    else sendJson(res, 200, {
      ok: true,
      schemaVersion: 1,
      operations: listEvolutionOperations({
        userId,
        kind: url.searchParams.get('kind'),
        state: url.searchParams.get('state'),
        limit: url.searchParams.get('limit') || 50,
      }),
    })
    return true
  }
  if (matches.operationRecoverMatch) {
    if (req.method !== 'POST') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    else {
      const body = await readJson(req, { maxBytes: 8 * 1024 })
      const operation = recoverEvolutionOperationNotSent({
        userId,
        id: decodeURIComponent(matches.operationRecoverMatch[1]),
        verificationConfirmed: body.verificationConfirmed,
        confirmOperationId: body.confirmOperationId,
        recoveryChallenge: body.recoveryChallenge,
        recoveryRevision: body.recoveryRevision,
      })
      sendJson(res, 200, { ok: true, operation })
    }
    return true
  }
  if (matches.operationResumeMatch) {
    if (req.method !== 'POST') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    else {
      const result = await resumeEvolutionOperation({
        userId,
        id: decodeURIComponent(matches.operationResumeMatch[1]),
        ...(typeof runtime.runCandidateModel === 'function' ? { runCandidateModel: runtime.runCandidateModel } : {}),
        ...(typeof runtime.runReplayModel === 'function' ? { runReplayModel: runtime.runReplayModel } : {}),
        ...(typeof runtime.runEvaluationModel === 'function' ? { runEvaluationModel: runtime.runEvaluationModel } : {}),
      })
      res.setHeader('X-Evolution-Operation-Id', result.operation.id)
      sendJson(res, 200, { ok: true, ...result })
    }
    return true
  }
  if (matches.operationMatch) {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    else sendJson(res, 200, {
      ok: true,
      operation: getEvolutionOperation({
        userId, id: decodeURIComponent(matches.operationMatch[1]),
      }),
    })
    return true
  }
  return false
}

async function handleEvolutionConfigEvidenceRoutes(req, res, runtime) {
  const { url, userId, matches, cwd, env, hostEnv } = runtime
  if (url.pathname === '/api/evolution/config-reviews') {
    if (req.method !== 'POST') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    else {
      const body = await readJson(req, { maxBytes: 8 * 1024 })
      sendJson(res, 201, {
        ok: true,
        review: reviewEvolutionConfigCandidate({ userId, candidateId: body.candidateId, cwd, env, hostEnv }),
      })
    }
    return true
  }
  if (url.pathname === '/api/evolution/config-replays') {
    if (req.method === 'GET') sendJson(res, 200, {
      ok: true,
      schemaVersion: 1,
      replays: listEvolutionConfigReplays({ userId, limit: url.searchParams.get('limit') }),
    })
    else if (req.method === 'POST') {
      const body = await readJson(req, { maxBytes: 8 * 1024 })
      sendJson(res, 201, {
        ok: true,
        replay: runEvolutionConfigReplay({ userId, candidateId: body.candidateId, cwd, env, hostEnv }),
      })
    } else sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    return true
  }
  if (matches.configReplayMatch) {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    else sendJson(res, 200, {
      ok: true,
      replay: getEvolutionConfigReplay({ userId, id: decodeURIComponent(matches.configReplayMatch[1]) }),
    })
    return true
  }
  if (url.pathname === '/api/evolution/config-evaluations') {
    if (req.method === 'GET') sendJson(res, 200, {
      ok: true,
      schemaVersion: 1,
      evaluations: listEvolutionConfigEvaluations({ userId, limit: url.searchParams.get('limit') }),
    })
    else if (req.method === 'POST') {
      const body = await readJson(req, { maxBytes: 8 * 1024 })
      sendJson(res, 201, {
        ok: true,
        evaluation: evaluateEvolutionConfigReplay({ userId, replayId: body.replayId }),
      })
    } else sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    return true
  }
  if (matches.configEvaluationMatch) {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    else sendJson(res, 200, {
      ok: true,
      evaluation: getEvolutionConfigEvaluation({
        userId, id: decodeURIComponent(matches.configEvaluationMatch[1]),
      }),
    })
    return true
  }
  if (matches.configApprovalReviewMatch) {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    else sendJson(res, 200, {
      ok: true,
      review: buildEvolutionConfigApprovalReview({
        userId, evaluationId: decodeURIComponent(matches.configApprovalReviewMatch[1]),
      }),
    })
    return true
  }
  if (url.pathname === '/api/evolution/config-approvals') {
    if (req.method === 'GET') sendJson(res, 200, {
      ok: true,
      schemaVersion: 1,
      approvals: listEvolutionConfigApprovals({ userId, limit: url.searchParams.get('limit') }),
    })
    else if (req.method === 'POST') {
      const body = await readJson(req, { maxBytes: 16 * 1024 })
      sendJson(res, 201, {
        ok: true,
        approval: decideEvolutionConfigApproval({
          userId,
          evaluationId: body.evaluationId,
          decision: body.decision,
          reason: body.reason,
          confirmations: body.confirmations,
        }),
      })
    } else sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
    return true
  }
  if (matches.configApprovalMatch) {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    else sendJson(res, 200, {
      ok: true,
      approval: getEvolutionConfigApproval({
        userId, id: decodeURIComponent(matches.configApprovalMatch[1]),
      }),
    })
    return true
  }
  return false
}

async function handleEvolutionConfigMutationRoutes(req, res, runtime) {
  const { url, userId, matches, cwd, env, hostEnv, activateRuntimeConfig } = runtime
  if (matches.configApplyReviewMatch) {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    else sendJson(res, 200, {
      ok: true,
      review: buildEvolutionConfigApplyReview({
        userId, approvalId: decodeURIComponent(matches.configApplyReviewMatch[1]), cwd, env, hostEnv,
      }),
    })
    return true
  }
  if (url.pathname === '/api/evolution/config-changes/apply') {
    if (req.method !== 'POST') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    else {
      const body = await readJson(req, { maxBytes: 16 * 1024 })
      sendJson(res, 201, {
        ok: true,
        change: applyEvolutionConfigCandidate({
          userId,
          approvalId: body.approvalId,
          reason: body.reason,
          confirmationSha256: body.confirmationSha256,
          cwd,
          env,
          hostEnv,
          ...(typeof activateRuntimeConfig === 'function' ? { activate: activateRuntimeConfig } : {}),
        }),
      })
    }
    return true
  }
  if (url.pathname === '/api/evolution/config-changes') {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    else sendJson(res, 200, {
      ok: true,
      schemaVersion: 1,
      changes: listEvolutionConfigChanges({ userId, limit: url.searchParams.get('limit') }),
    })
    return true
  }
  if (matches.configReversalMatch) {
    if (req.method !== 'POST') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 POST'))
    else {
      const body = await readJson(req, { maxBytes: 16 * 1024 })
      sendJson(res, 201, {
        ok: true,
        change: reverseEvolutionConfigChange({
          userId,
          applyId: decodeURIComponent(matches.configReversalMatch[1]),
          operation: matches.configReversalMatch[2],
          reason: body.reason,
          confirmationSha256: body.confirmationSha256,
          cwd,
          env,
          hostEnv,
          ...(typeof activateRuntimeConfig === 'function' ? { activate: activateRuntimeConfig } : {}),
        }),
      })
    }
    return true
  }
  if (matches.configChangeMatch) {
    if (req.method !== 'GET') sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', '仅支持 GET'))
    else sendJson(res, 200, {
      ok: true,
      change: getEvolutionConfigChange({
        userId, id: decodeURIComponent(matches.configChangeMatch[1]),
      }),
    })
    return true
  }
  return false
}

export async function handleEvolutionRequest(req, res, options = {}) {
  const {
    cwd = process.cwd(), env = process.env, hostEnv = process.env,
    readCanarySession = null, activateRuntimeConfig, evaluatorProviderId,
    evaluatorModelName, runCandidateModel, runEvaluationModel,
    runOnlineGraderModel = runEvaluationModel, runReplayModel,
  } = options
  res.setHeader('Cache-Control', 'no-store')
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, errorBody('UNAUTHORIZED', '请先登录'))
  const url = new URL(req.url, 'http://localhost')
  const matches = evolutionRouteMatches(url.pathname)
  if (requiresLocalOwner(req, url, matches) && !authorizeLocalOwner(req, res, userId, env)) return
  const runtime = {
    url, userId, matches, cwd, env, hostEnv, readCanarySession, activateRuntimeConfig,
    evaluatorProviderId, evaluatorModelName, runCandidateModel, runEvaluationModel,
    runOnlineGraderModel, runReplayModel,
  }
  try {
    if (await handleEvolutionRuntimeRoutes(req, res, runtime)) return
    if (url.pathname.startsWith('/api/evolution/config-')) {
      reconcileEvolutionConfigJournal({
        userId, cwd, env,
        ...(typeof activateRuntimeConfig === 'function' ? { activate: activateRuntimeConfig } : {}),
      })
    }
    if (await handleEvolutionConfigEvidenceRoutes(req, res, runtime)) return
    if (await handleEvolutionConfigMutationRoutes(req, res, runtime)) return
    return await handleEvolutionWorkflowRequest(req, res, {
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
    })
  } catch (error) {
    return sendJson(res, error?.statusCode || 500, errorBody(
      error?.code || 'EVOLUTION_EVIDENCE_FAILED',
      error?.statusCode && error.statusCode < 500 ? error.message : '证据操作失败',
      error?.operationId || null,
    ))
  }
}
