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
import { createNotification } from './notificationsStore.js'
import { getApprovalSettings } from './approvalSettingsStore.js'
import { classifyToolRisk, resolveApprovalMode, resolveApprovalTimeoutMs } from '../utils/approvalPolicy.js'
import { getToolMetadata } from './toolRegistry.js'

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
 * 把审批记录的终态翻译成 gate 结果。
 *
 * ★ 区分「人做了决定」和「系统坏了」:两者以前返回一模一样的形状,
 * 模型只能看到一句拒绝,于是当成用户不同意 → 放弃任务、让用户手动来。
 * 实际上后者应该重试。带 systemFailure/retryable 标记后,
 * caller 能给模型完全不同的措辞。
 */
function terminalDecision(approval) {
  // 记录凭空消失 = 基础设施问题(DB 被清/行被删),不是用户拒绝
  if (!approval) {
    return { proceed: false, reason: '审批记录已丢失', systemFailure: true, retryable: true }
  }
  switch (approval.status) {
    case 'approved':
      return { proceed: true, args: approval.effectiveArgs, approvalId: approval.id }
    case 'edited':
      return { proceed: true, args: approval.effectiveArgs, approvalId: approval.id, edited: true }
    case 'denied':
      // 唯一真正的「用户说不」
      return { proceed: false, reason: '用户拒绝了这次调用', approvalId: approval.id, deniedByUser: true }
    case 'expired':
      return { proceed: false, reason: '审批超时未处理(视同拒绝)', approvalId: approval.id, expired: true }
    case 'cancelled':
      return { proceed: false, reason: '任务已取消,审批作废', approvalId: approval.id, cancelled: true }
    default:
      return null // still pending
  }
}

/**
 * An approval authorizes one call, but it must not freeze the permission mode
 * that was active when the inbox row was created. In particular, switching to
 * plan while a decision is pending must take effect before that decision can
 * be consumed, including after a process restart.
 */
export function revalidateToolPermission({
  userId,
  origin = 'job',
  toolName,
  args = {},
} = {}) {
  if (!userId) return { proceed: true, args }

  try {
    const settings = getApprovalSettings({ userId })
    const riskOverride = settings.riskOverrides?.find((item) => item?.toolName === toolName) || null
    const dynamicMetadata = getToolMetadata(toolName, { args, userId })
    const metadata = riskOverride
      ? {
          ...(dynamicMetadata || {}),
          riskClass: riskOverride.riskClass,
          requiresApproval: riskOverride.riskClass !== 'read',
          reason: `用户风险覆盖: ${riskOverride.riskClass}`,
        }
      : dynamicMetadata
    const verdict = classifyToolRisk(toolName, args, {
      origin,
      // This call has already been approved or reached the executing
      // checkpoint. Revalidation only asks whether the user's current
      // permission mode still forbids it; it must not reopen or depend on the
      // deployment-level approval queue (which may legitimately be `off`).
      mode: 'unattended',
      permissionMode: settings.mode,
      rememberedGrants: settings.rememberedGrants,
      metadata,
    })
    if (!verdict.denied) return { proceed: true, args, permissionMode: settings.mode }
    return {
      proceed: false,
      reason: verdict.reason,
      policyDenied: settings.mode === 'plan',
      permissionMode: settings.mode,
      suggestedPermissionMode: settings.mode === 'plan' ? 'acceptEdits' : 'normal',
    }
  } catch (err) {
    console.error('[approval] 重验当前权限失败,已保守拒绝:', err?.stack || err)
    return {
      proceed: false,
      reason: '无法确认当前权限模式,已保守拒绝',
      systemFailure: true,
      retryable: true,
    }
  }
}

function terminalDecisionForCurrentMode(approval) {
  const decision = terminalDecision(approval)
  if (!decision?.proceed) return decision

  const args = decision.args ?? approval.effectiveArgs ?? approval.args ?? {}
  const currentPermission = revalidateToolPermission({
    userId: approval.userId,
    origin: approval.origin,
    toolName: approval.toolName,
    args,
  })
  return currentPermission.proceed
    ? decision
    : { ...currentPermission, approvalId: approval.id }
}

/**
 * 把 gate 的拒绝结果翻译成给模型看的工具结果。
 *
 * 关键是让模型能区分三种情况并采取不同行动:
 *   - 用户拒绝  → 别再试了,换个思路或问用户
 *   - 系统故障  → 可以重试,不是用户不同意
 *   - 超时/取消 → 说明情况,别当成被否决
 */
export function formatDeniedToolResult(gate) {
  const base = { ok: false, denied: true, error: gate?.reason || '调用未获批准' }
  if (gate?.systemFailure) {
    return {
      ...base,
      denied: false, // 不是「被拒绝」,是没走成
      systemFailure: true,
      retryable: true,
      error: `${gate.reason || '审批系统暂时不可用'}。这是系统故障,不是用户拒绝 —— 可以稍后重试,不要因此放弃任务或要求用户手动操作。`,
    }
  }
  if (gate?.expired) {
    return { ...base, expired: true, error: `${gate.reason}。用户可能不在,可以先做不需要批准的部分。` }
  }
  if (gate?.cancelled) {
    return { ...base, cancelled: true, error: gate.reason }
  }
  if (gate?.policyDenied) {
    const currentMode = gate.permissionMode === 'plan' ? '计划模式' : String(gate.permissionMode || '当前模式')
    const suggestedMode = gate.suggestedPermissionMode === 'acceptEdits' ? '自动接受编辑模式' : '正常模式'
    return {
      ...base,
      code: gate.permissionMode === 'plan'
        ? 'policy_denied_plan_mode'
        : 'policy_denied_permission_mode',
      policyDenied: true,
      permissionMode: gate.permissionMode || null,
      suggestedPermissionMode: gate.suggestedPermissionMode || 'normal',
      error: `该工具存在，但操作在${currentMode}下被策略禁止。请切换到${suggestedMode}后继续；不要将此解释为缺少写入或执行工具。`,
    }
  }
  return { ...base, deniedByUser: true, error: `${gate?.reason || '用户拒绝了这次调用'}。请换一个方案,不要重复请求同一个操作。` }
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
} = {}) {
  // 系统/内部调用(无 userId)不 gate —— 和 fsShellTools.assertToolPermitted 一致的口径
  if (!userId) return { proceed: true, args }

  const effectiveMode = mode || resolveApprovalMode()
  // 用户档位 + 「总是允许」清单。读失败不阻断,退回最严格的默认(normal/空)。
  let settings = { mode: undefined, rememberedGrants: [], riskOverrides: [] }
  try {
    settings = getApprovalSettings({ userId })
  } catch (err) {
    console.error('[approval] 读取用户档位失败,按默认最严处理:', err?.stack || err)
  }
  const riskOverride = settings.riskOverrides?.find((item) => item?.toolName === toolName) || null
  const dynamicMetadata = getToolMetadata(toolName, { args, userId })
  const metadata = riskOverride
    ? {
        ...(dynamicMetadata || {}),
        riskClass: riskOverride.riskClass,
        requiresApproval: riskOverride.riskClass === 'read' ? false : true,
        reason: `用户风险覆盖: ${riskOverride.riskClass}`,
      }
    : dynamicMetadata
  let verdict = classifyToolRisk(toolName, args, {
    origin,
    mode: effectiveMode,
    permissionMode: settings.mode,
    rememberedGrants: settings.rememberedGrants,
    metadata,
  })
  // plan 档位:直接拒,不排队等人 —— 用户要的就是「只看不动」
  if (verdict.denied) {
    return {
      proceed: false,
      reason: verdict.reason,
      policyDenied: settings.mode === 'plan',
      permissionMode: settings.mode,
      suggestedPermissionMode: settings.mode === 'plan' ? 'acceptEdits' : 'normal',
    }
  }
  // A trusted pre-tool hook may waive an approval prompt, but it cannot cross
  // the user's plan/read-only boundary above.
  if (preAuthorized === true) {
    return { proceed: true, args, hookAuthorized: true }
  }
  // “全部放行”是用户对审批层的最终选择。Hook 仍可拒绝调用，
  // 但 permissionDecision=ask 不能把 bypass 重新降级为等待审批。
  if (forceApproval === true && settings.mode !== 'bypass') {
    verdict = {
      ...verdict,
      needsApproval: true,
      risk: verdict.risk || 'low',
      reason: String(forceApprovalReason || '').trim() || 'pre_tool_use Hook 要求逐次批准',
    }
  }
  if (!verdict.needsApproval) {
    return {
      proceed: true,
      args,
      authorization: verdict.authorization || (riskOverride
        ? { kind: 'risk_override', toolName, riskClass: riskOverride.riskClass }
        : null),
    }
  }

  let approval
  try {
    approval = createPendingApproval({
      userId,
      origin,
      jobId,
      stepId,
      sessionId,
      toolName,
      args,
      risk: verdict.risk,
      metadataSource: metadata?.source,
      reason: verdict.reason,
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
    }
  }

  try {
    createNotification({
      userId,
      kind: 'approval',
      title: `需要批准:${toolName}`,
      body: verdict.reason || '有一个操作等待你的批准',
      // 前端是 HashRouter + navigate(link),这里给路由路径而非带 /#/ 的完整 URL
      link: `/approvals?id=${encodeURIComponent(approval.id)}`,
      data: {
        approvalId: approval.id,
        toolName,
        risk: verdict.risk,
        metadataSource: approval.metadataSource,
        jobId,
        origin,
      },
    })
  } catch (err) {
    // 通知失败不阻断门控本身,用户仍可在收件箱看到
    console.error('[approval] 通知发送失败:', err?.stack || err)
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
      const decision = terminalDecisionForCurrentMode(approval)
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
export function resumePersistedApproval({ approvalId, signal = null } = {}) {
  if (!approvalId) {
    return Promise.resolve({
      proceed: false,
      reason: 'Missing persisted approval id',
      systemFailure: true,
      retryable: true,
    })
  }
  const decision = terminalDecisionForCurrentMode(getApprovalById(approvalId))
  return decision ? Promise.resolve(decision) : waitForDecision({ approvalId, signal })
}

/** 测试用:清空内存等待者,避免用例间串扰。 */
export function _resetWaiters() {
  waiters.clear()
}
