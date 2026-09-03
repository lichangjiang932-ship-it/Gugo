/**
 * 审批门控执行器 —— 服务端 agent 循环共用的 pause/resume 原语。
 *
 * 这是本批次的核心:openworker 的招牌能力「consequential action 触发 check-in」。
 *
 * 设计要点:
 *   - 内存 Map 是快路径(同进程内决策毫秒级唤醒),DB 轮询是兜底(进程重启后仍能 resume)。
 *     决策的权威永远是 DB,内存只是通知渠道。
 *   - 尊重 AbortSignal:job 被取消时立刻解除等待,不泄漏 timer。
 *   - 不 throw 打断 agent 循环:被拒绝返回 { proceed:false },由 caller 把拒绝结果
 *     喂回模型让它改道,而不是硬失败(AGENTS.md 2.5.3 的精神)。
 */
import {
  cancelApprovalsForJob,
  cancelApprovalsForTurn,
  cancelPendingApproval,
  createPendingApproval,
  expireStaleApprovals,
  getApprovalById,
} from './approvalStore.js'
import { createNotification, jobApprovalNotificationData } from './notificationsStore.js'
import { resolveApprovalTimeoutMs } from '../utils/approvalPolicy.js'
import { getActiveRuntimePolicyProvenance } from '../core/runtimePolicyRuntime.js'
import {
  authorizeApprovalRequest,
  terminalDecisionForCurrentMode,
} from './approvalGateAuthorization.js'

export {
  formatDeniedToolResult,
  revalidateHookAuthorization,
  revalidateToolPermission,
} from './approvalGateAuthorization.js'

/** approvalId → Set<resolve>。同进程决策时立刻唤醒等待者。 */
const waiters = new Map()
/** 轮询间隔:兜底用,不是主路径。Windows CI 下 5000ms 足够宽松(AGENTS.md 五)。 */
const POLL_INTERVAL_MS = 5_000
function notifyWaiters(approvalId) {
  const set = waiters.get(approvalId)
  if (!set) return
  for (const resolve of set) {
    try {
      resolve()
    } catch {
      /* 唤醒失败不影响其他等待者 */
    }
  }
  waiters.delete(approvalId)
}

/**
 * 决策落库后调用,唤醒正在等待的 agent 循环。
 * 由 approvalRoutes 在 decideApproval 成功后调。
 */
export function releaseApproval(approvalId) {
  if (approvalId) notifyWaiters(approvalId)
}

/** job 终止时清掉它名下的挂起审批,并唤醒等待者(它们会读到 cancelled)。 */
export function releaseApprovalsForJob(jobId) {
  if (!jobId) return 0
  const changed = cancelApprovalsForJob({ jobId })
  // 唤醒所有等待者:它们各自去 DB 读状态,读到 cancelled 就返回 proceed:false
  for (const id of [...waiters.keys()]) notifyWaiters(id)
  return changed
}

export function releaseApprovalsForTurn({ userId, sessionId, turnId } = {}) {
  const changed = cancelApprovalsForTurn({ userId, sessionId, turnId })
  for (const id of [...waiters.keys()]) notifyWaiters(id)
  return changed
}

/**
 * Persist one approval request and publish the standard inbox notification.
 * Administrative callers use this non-blocking primitive; tool execution
 * calls it and then waits through waitForDecision().
 */
export function enqueueApprovalRequest({
  userId,
  origin = 'job',
  jobId = null,
  stepId = null,
  sessionId = null,
  toolName,
  args = {},
  risk = 'medium',
  metadataSource = 'fallback',
  policyProvenance = null,
  reason = null,
  expiresAt = null,
  notificationTitle = null,
  notificationBody = null,
  notificationData = jobApprovalNotificationData({ origin, jobId }),
} = {}) {
  const approval = createPendingApproval({
    userId,
    origin,
    jobId,
    stepId,
    sessionId,
    toolName,
    args,
    risk,
    metadataSource,
    policyProvenance,
    reason,
    expiresAt,
  })

  try {
    createNotification({
      userId,
      kind: 'approval',
      title: notificationTitle || `需要批准:${toolName}`,
      body: notificationBody || reason || '有一个操作等待你的批准',
      link: `/approvals?id=${encodeURIComponent(approval.id)}`,
      data: {
        ...(notificationData && typeof notificationData === 'object' ? notificationData : {}),
        approvalId: approval.id,
        toolName,
        risk,
        metadataSource: approval.metadataSource,
        jobId,
        origin,
      },
    })
  } catch (err) {
    // The durable inbox row is authoritative; realtime notification is best effort.
    console.error('[approval] 通知发送失败:', err?.stack || err)
  }
  return approval
}

/**
 * 请求审批。不需要审批时立即放行,需要时挂起等待人决策。
 *
 * @returns {Promise<{ proceed: boolean, args?: object, approvalId?: string, reason?: string, edited?: boolean }>}
 */
export async function requestApproval({
  userId,
  origin = 'job',
  jobId = null,
  stepId = null,
  sessionId = null,
  toolName,
  args = {},
  signal = null,
  mode = null,
  onPending = null,
  forceApproval = false,
  forceApprovalReason = null,
  preAuthorized = false,
  hookAuthorizationProvenance = null,
  requestId = null,
  toolCallId = null,
  taskGrants = [],
} = {}) {
  const authorization = authorizeApprovalRequest({
    userId,
    origin,
    jobId,
    stepId,
    sessionId,
    toolName,
    args,
    mode,
    forceApproval,
    forceApprovalReason,
    preAuthorized,
    hookAuthorizationProvenance,
    requestId,
    toolCallId,
    taskGrants,
  })
  if (authorization.gate) return authorization.gate
  const {
    metadataSource,
    policyProvenance,
    reason,
    risk,
  } = authorization.pending

  let approval
  try {
    approval = enqueueApprovalRequest({
      userId,
      origin,
      jobId,
      stepId,
      sessionId,
      toolName,
      args,
      risk,
      metadataSource,
      policyProvenance,
      reason,
      expiresAt: Date.now() + resolveApprovalTimeoutMs(),
    })
  } catch (err) {
    // 写不进审批表 = 无法保证门控 → 保守拒绝,不静默放行。
    // 但要让 caller 知道这是系统故障而非用户拒绝,否则模型会当成「用户不同意」放弃任务。
    console.error('[approval] 创建审批失败,保守拒绝:', err?.stack || err)
    return {
      proceed: false,
      reason: '审批系统暂时不可用,已保守拒绝',
      systemFailure: true,
      retryable: true,
      policyProvenance,
    }
  }

  if (typeof onPending === 'function') {
    try {
      await onPending(approval)
    } catch (err) {
      console.error('[approval] onPending 回调失败:', err?.stack || err)
    }
  }

  return waitForDecision({
    approvalId: approval.id,
    signal,
    cancelOnAbort: { userId, approvalId: approval.id },
    expectedApprovalContext: {
      userId,
      origin,
      jobId,
      stepId,
      sessionId,
      toolName,
      policyProvenance,
    },
  })
}

/**
 * 等待决策。内存唤醒 + 定时轮询双保险,任一触发都重新读 DB 定状态。
 */
export function waitForDecision({
  approvalId,
  signal = null,
  pollIntervalMs = POLL_INTERVAL_MS,
  cancelOnAbort = null,
  expectedApprovalContext = null,
} = {}) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer) clearInterval(timer)
      timer = null
      const set = waiters.get(approvalId)
      if (set) {
        set.delete(wake)
        if (set.size === 0) waiters.delete(approvalId)
      }
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    const settle = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    // 连续读失败次数。DB 短暂抖动可以忍,一直读不到就别干等到 24h 超时 ——
    // 那样调用方以为「人还没决定」,实际上是数据库挂了。
    let consecutiveReadFailures = 0
    const MAX_READ_FAILURES = 5

    const check = () => {
      if (settled) return
      let approval
      try {
        // 顺手把超时的置 expired —— 无需额外后台任务
        expireStaleApprovals()
        approval = getApprovalById(approvalId)
        consecutiveReadFailures = 0
      } catch (err) {
        consecutiveReadFailures += 1
        console.error(
          `[approval] 读取审批状态失败(${consecutiveReadFailures}/${MAX_READ_FAILURES}):`,
          err?.stack || err,
        )
        if (consecutiveReadFailures >= MAX_READ_FAILURES) {
          settle({
            proceed: false,
            reason: '审批系统读取持续失败,已保守拒绝',
            approvalId,
            systemFailure: true,
            retryable: true,
          })
        }
        return
      }
      const decision = terminalDecisionForCurrentMode(approval, expectedApprovalContext)
      if (decision) settle(decision)
    }

    function wake() {
      check()
    }

    function onAbort() {
      if (cancelOnAbort?.userId && cancelOnAbort?.approvalId === approvalId) {
        try {
          cancelPendingApproval({ userId: cancelOnAbort.userId, id: approvalId })
          notifyWaiters(approvalId)
        } catch (err) {
          console.error('[approval] 取消断连审批失败:', err?.stack || err)
        }
      }
      settle({ proceed: false, reason: '任务已中止', approvalId, cancelled: true })
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    if (!waiters.has(approvalId)) waiters.set(approvalId, new Set())
    waiters.get(approvalId).add(wake)

    timer = setInterval(check, pollIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()

    // 可能在挂上等待之前就已被决策(极窄竞态窗口),先查一次
    check()
  })
}

/**
 * Resume an approval that was already persisted before a process restart.
 * A terminal DB decision is returned immediately; a still-pending record uses
 * the same durable polling/wakeup path without creating a duplicate approval.
 */
export function resumePersistedApproval({
  approvalId,
  signal = null,
  expectedApprovalContext = null,
  requireTerminal = false,
} = {}) {
  if (!approvalId) {
    return Promise.resolve({
      proceed: false,
      reason: 'Missing persisted approval id',
      systemFailure: true,
      retryable: true,
    })
  }
  const approval = getApprovalById(approvalId)
  const decision = terminalDecisionForCurrentMode(
    approval,
    expectedApprovalContext,
  )
  if (!decision && requireTerminal) {
    return Promise.resolve({
      proceed: false,
      reason: '执行快照引用的审批仍未完成，已保守拒绝恢复执行',
      code: 'approval_not_terminal',
      approvalContextMismatch: true,
      retryable: false,
      approvalId,
      policyProvenance: getActiveRuntimePolicyProvenance(),
    })
  }
  return decision
    ? Promise.resolve(decision)
    : waitForDecision({ approvalId, signal, expectedApprovalContext })
}

/** 测试用:清空内存等待者,避免用例间串扰。 */
export function _resetWaiters() {
  waiters.clear()
}
