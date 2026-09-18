/**
 * 审批门控执行器 —— 服务端 agent 循环共用的 pause/resume 原语。
 *
 * 这是本批次的核心:openworker 的招牌能力「consequential action 触发 check-in」。
 *
 * 设计要点:
 *   - 内存 Map 是快路径(同进程内决策毫秒级唤醒),DB 轮询是兜底(进程重启后仍能 resume)。
 *     决策的权威永远是 DB,内存只是通知渠道。
 *   - 尊重 AbortSignal:job 被取消时立刻解除等待,不泄漏 timer。
 *   - 拒绝返回 { proceed:false }；循环保留已确认进展并停止本轮，不再为收尾请求模型。
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
  revalidateHookAuthorization,
  revalidateToolPermission,
} from './approvalGateAuthorization.js'

function localized(locale, zh, en) {
  return locale === 'zh' ? zh : en
}

/**
 * 把 gate 的拒绝结果翻译成给模型看的工具结果。
 * 关键是让模型能区分用户拒绝 / 系统故障 / 超时取消并采取不同行动。
 */
export function formatDeniedToolResult(gate, locale = 'zh') {
  const base = { ok: false, denied: true, error: gate?.reason || localized(locale, '调用未获批准', 'The call was not approved') }
  if (gate?.systemFailure) {
    const retryable = gate.retryable !== false
    return {
      ...base,
      denied: false, // 不是「被拒绝」,是没走成
      authorizationFailure: true,
      code: gate.code || 'approval_system_failed',
      systemFailure: true,
      retryable,
      error: retryable
        ? localized(locale,
          `${gate.reason || '审批系统暂时不可用'}。这是系统故障,不是用户拒绝 —— 可以稍后重试,不要因此放弃任务或要求用户手动操作。`,
          `${gate.reason || 'The approval system is temporarily unavailable'}. This is a system failure, not a user rejection — you can retry later; do not abandon the task or ask the user to act manually.`)
        : localized(locale,
          `${gate.reason || '授权已失效'}。这是安全校验失败,不是用户拒绝；必须重新发起工具调用获取新的授权。`,
          `${gate.reason || 'The authorization is no longer valid'}. This is a security check failure, not a user rejection; you must re-issue the tool call to obtain a fresh authorization.`),
    }
  }
  if (gate?.expired) {
    return {
      ...base,
      expired: true,
      code: 'approval_expired',
      retryable: false,
      error: localized(locale,
        `${gate.reason || '审批已过期'}。用户可能不在，本轮已停止；请返回后重新确认。`,
        `${gate.reason || 'Approval expired'}. The user may be away; this turn stopped and needs renewed confirmation.`),
    }
  }
  if (gate?.cancelled) {
    return { ...base, code: 'turn_cancelled', cancelled: true, retryable: false, error: gate.reason }
  }
  if (gate?.approvalRequired) {
    return {
      ...base,
      denied: false,
      code: 'approval_required',
      approvalRequired: true,
      retryable: true,
      permissionMode: gate.permissionMode || null,
      suggestedPermissionMode: gate.suggestedPermissionMode || 'normal',
      error: localized(locale,
        `${gate.reason || '本次工具调用尚未获得批准'}。请重新发起该工具调用以创建新的逐次审批请求；获得用户批准后再继续。`,
        `${gate.reason || 'This tool call has not been approved yet'}. Re-issue the tool call to create a new per-call approval request; continue after the user approves.`),
    }
  }
  if (gate?.policyDenied) {
    const currentMode = gate.permissionMode === 'plan'
      ? localized(locale, '计划模式', 'Plan mode')
      : String(gate.permissionMode || localized(locale, '当前模式', 'the current mode'))
    const suggestedMode = gate.suggestedPermissionMode === 'acceptEdits'
      ? localized(locale, '自动接受编辑模式', 'auto-accept edits mode')
      : localized(locale, '正常模式', 'normal mode')
    return {
      ...base,
      code: gate.permissionMode === 'plan'
        ? 'policy_denied_plan_mode'
        : 'policy_denied_permission_mode',
      policyDenied: true,
      permissionMode: gate.permissionMode || null,
      suggestedPermissionMode: gate.suggestedPermissionMode || 'normal',
      error: localized(locale,
        `该工具存在，但操作在${currentMode}下被策略禁止。请切换到${suggestedMode}后继续；不要将此解释为缺少写入或执行工具。`,
        `The tool exists, but the operation is forbidden by policy under ${currentMode}. Switch to ${suggestedMode} and continue; do not interpret this as a missing write or execution tool.`),
    }
  }
  return {
    ...base,
    code: 'approval_denied',
    deniedByUser: true,
    retryable: false,
    error: localized(locale,
      `${gate?.reason || '用户拒绝了这次调用'}。本轮已停止；请由用户明确选择其他方案后再继续。`,
      `${gate?.reason || 'The user rejected this call'}. This turn stopped; wait for the user to choose how to continue.`),
  }
}

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
  locale = 'zh',
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
      title: notificationTitle || localized(locale, `需要批准:${toolName}`, `Approval required: ${toolName}`),
      body: notificationBody || reason || localized(locale, '有一个操作等待你的批准', 'There is an operation waiting for your approval'),
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
  locale = 'zh',
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
    locale,
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
      locale,
    })
  } catch (err) {
    // 写不进审批表 = 无法保证门控 → 保守拒绝,不静默放行。
    // 但要让 caller 知道这是系统故障而非用户拒绝,否则模型会当成「用户不同意」放弃任务。
    console.error('[approval] 创建审批失败,保守拒绝:', err?.stack || err)
    return {
      proceed: false,
      reason: localized(locale, '审批系统暂时不可用,已保守拒绝', 'The approval system is temporarily unavailable; execution was conservatively rejected.'),
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
    locale,
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
  locale = 'zh',
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
            reason: localized(locale, '审批系统读取持续失败,已保守拒绝', 'The approval system read kept failing; execution was conservatively rejected.'),
            approvalId,
            systemFailure: true,
            retryable: true,
          })
        }
        return
      }
      const decision = terminalDecisionForCurrentMode(approval, expectedApprovalContext, locale)
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
      settle({ proceed: false, reason: localized(locale, '任务已中止', 'The task was aborted'), approvalId, cancelled: true })
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
  locale = 'zh',
} = {}) {
  if (!approvalId) {
    return Promise.resolve({
      proceed: false,
      reason: localized(locale, '缺少已持久化的审批 ID', 'Missing persisted approval id'),
      systemFailure: true,
      retryable: true,
    })
  }
  const approval = getApprovalById(approvalId)
  const decision = terminalDecisionForCurrentMode(
    approval,
    expectedApprovalContext,
    locale,
  )
  if (!decision && requireTerminal) {
    return Promise.resolve({
      proceed: false,
      reason: localized(locale,
        '执行快照引用的审批仍未完成，已保守拒绝恢复执行',
        'The approval referenced by the execution snapshot is still pending; resumption was conservatively rejected.'),
      code: 'approval_not_terminal',
      approvalContextMismatch: true,
      retryable: false,
      approvalId,
      policyProvenance: getActiveRuntimePolicyProvenance(),
    })
  }
  return decision
    ? Promise.resolve(decision)
    : waitForDecision({ approvalId, signal, expectedApprovalContext, locale })
}

/** 测试用:清空内存等待者,避免用例间串扰。 */
export function _resetWaiters() {
  waiters.clear()
}
