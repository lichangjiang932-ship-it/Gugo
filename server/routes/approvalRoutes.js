/**
 * 审批收件箱路由(approval inbox)。薄壳:只做 HTTP ↔ service 翻译,不写业务逻辑。
 *
 *   GET  /api/approvals?status=pending   → { approvals }
 *   GET  /api/approvals/pending-count    → { count }
 *   GET  /api/approvals/:id              → { approval }
 *   POST /api/approvals/:id/decide       → body { decision, args? }
 *   GET  /api/approvals/stream           → SSE(复用 notifications 的 approval kind)
 */
import { authenticateRequest } from '../middleware.js'
import { readJson, sendJson } from '../utils.js'
import { subscribeNotifications } from '../services/notificationsStore.js'
import {
  countPendingApprovals,
  getPendingApproval,
  listPendingApprovals,
} from '../services/approvalStore.js'
import {
  clearRememberedTools,
  changeApprovalMode,
  forgetTool,
  getApprovalSettings,
  preparePermissionModeChange,
  setRiskOverride,
} from '../services/approvalSettingsStore.js'
import { decideApprovalRequest } from '../services/approvalDecisionService.js'
import { createStreamTicket, consumeStreamTicket } from '../utils/streamTicket.js'

const VALID_DECISIONS = new Set(['approve', 'deny', 'edit'])
const VALID_STATUS_FILTERS = new Set(['pending', 'approved', 'denied', 'edited', 'expired', 'cancelled', 'all'])

function unauthorized(res) {
  return sendJson(res, 401, { error: { code: 'unauthorized', message: '请先登录' } })
}

function notFound(res) {
  // 跨用户访问也走 404,不泄露「这个 id 存在」
  return sendJson(res, 404, { error: { code: 'not_found', message: '审批不存在' } })
}

function badRequest(res, message) {
  return sendJson(res, 400, { error: { code: 'bad_request', message } })
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function updateApprovalSettings(req, res, userId) {
  const body = await readJson(req)
  let modeTransition = null
  if (body?.mode !== undefined) {
    try {
      const requestedMode = String(body.mode)
      const prepared = preparePermissionModeChange({
        userId,
        mode: requestedMode,
        justification: body.justification,
      })
      if (!prepared.changed) {
        modeTransition = prepared
      } else if (prepared.widened) {
        if (body.approveEscalation !== true) {
          const error = new Error('放宽权限需要明确批准')
          error.code = 'PERMISSION_ESCALATION_REQUIRED'
          error.statusCode = 409
          error.currentMode = prepared.previousMode
          error.requestedMode = requestedMode
          throw error
        }
        modeTransition = changeApprovalMode({
          userId,
          mode: requestedMode,
          approveEscalation: true,
          justification: body.justification,
        })
      } else {
        modeTransition = changeApprovalMode({
          userId,
          mode: requestedMode,
          justification: body.justification,
        })
      }
    } catch (err) {
      return sendJson(res, err?.statusCode || 400, {
        error: {
          code: err?.code || 'bad_request',
          message: err?.message || '非法模式',
          currentMode: err?.currentMode,
          requestedMode: err?.requestedMode,
        },
      })
    }
  }
  if (body?.forgetTool) forgetTool({ userId, toolName: String(body.forgetTool) })
  if (body?.clearRemembered) clearRememberedTools({ userId })
  if (body?.riskOverride && typeof body.riskOverride === 'object') {
    setRiskOverride({
      userId,
      toolName: body.riskOverride.toolName,
      riskClass: body.riskOverride.riskClass,
    })
  }
  return sendJson(res, 200, { ...getApprovalSettings({ userId }), modeTransition })
}

export async function handleApprovalRequest(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const { pathname } = url

  if (req.method === 'POST' && pathname === '/api/approvals/stream-ticket') {
    const userId = authenticateRequest(req)
    if (!userId) return unauthorized(res)
    return sendJson(res, 201, { ticket: createStreamTicket(userId), expiresIn: 60 })
  }

  // SSE 放在鉴权之前:EventSource 不能带 header,允许 ?token= 兜底(与 notifications 一致)
  if (req.method === 'GET' && pathname === '/api/approvals/stream') {
    let userId = authenticateRequest(req)
    if (!userId) {
      const ticket = url.searchParams.get('ticket')
      if (ticket) userId = consumeStreamTicket(ticket)
    }
    if (!userId) return unauthorized(res)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    sendSse(res, 'ready', { ok: true })
    const unsubscribe = subscribeNotifications(userId, (notification) => {
      if (notification?.kind === 'approval') {
        sendSse(res, 'approval', notification)
      }
    })
    req.on('close', unsubscribe)
    return undefined
  }

  const userId = authenticateRequest(req)
  if (!userId) return unauthorized(res)

  try {
    if (req.method === 'GET' && pathname === '/api/approvals/settings') {
      return sendJson(res, 200, getApprovalSettings({ userId }))
    }

    if (req.method === 'POST' && pathname === '/api/approvals/settings') {
      return updateApprovalSettings(req, res, userId)
    }

    if (req.method === 'GET' && pathname === '/api/approvals') {
      const status = url.searchParams.get('status') || 'pending'
      if (!VALID_STATUS_FILTERS.has(status)) return badRequest(res, `非法 status: ${status}`)
      const limit = Number(url.searchParams.get('limit') || 100)
      return sendJson(res, 200, { approvals: listPendingApprovals({ userId, status, limit }) })
    }

    if (req.method === 'GET' && pathname === '/api/approvals/pending-count') {
      return sendJson(res, 200, { count: countPendingApprovals({ userId }) })
    }

    const decideMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/)
    if (decideMatch) {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: { code: 'method_not_allowed', message: '仅支持 POST' } })
      }
      const id = decodeURIComponent(decideMatch[1])
      const body = await readJson(req)
      const decision = String(body?.decision || '')
      if (!VALID_DECISIONS.has(decision)) {
        return badRequest(res, `decision 必须是 approve / deny / edit,收到:${decision || '(空)'}`)
      }
      const result = decideApprovalRequest({
        userId,
        id,
        decision,
        editedArgs: decision === 'edit' ? body?.args : null,
        remember: body?.remember === true,
        decidedBy: userId,
      })
      return sendJson(res, 200, result)
    }

    const detailMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/)
    if (detailMatch) {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: { code: 'method_not_allowed', message: '仅支持 GET' } })
      }
      const approval = getPendingApproval({ userId, id: decodeURIComponent(detailMatch[1]) })
      if (!approval) return notFound(res)
      return sendJson(res, 200, { approval })
    }

    return notFound(res)
  } catch (err) {
    const status = err?.statusCode || 400
    return sendJson(res, status, {
      error: {
        code: err?.code || 'approval_error',
        message: err?.message || String(err),
        ...(err?.currentMode ? { currentMode: err.currentMode } : {}),
        ...(err?.requestedMode ? { requestedMode: err.requestedMode } : {}),
      },
      ...(err?.approval ? { approval: err.approval } : {}),
    })
  }
}
