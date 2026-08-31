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
import { getApprovalSettings } from './approvalSettingsStore.js'
import { BUILTIN_POLICY_ID, requiresPerCallApproval, resolveApprovalMode, resolveApprovalTimeoutMs } from '../utils/approvalPolicy.js'
import { getDynamicTool, getToolMetadata } from './toolRegistry.js'
import { getHook } from './hooksService.js'
import { validateHookAuthorizationProvenance } from './hookAuthorizationProvenance.js'
import {
  acquireRuntimePolicy,
  getActiveRuntimePolicyProvenance,
} from '../core/runtimePolicyRuntime.js'

/** approvalId → Set<resolve>。同进程决策时立刻唤醒等待者。 */
const waiters = new Map()
/** 轮询间隔:兜底用,不是主路径。Windows CI 下 5000ms 足够宽松(AGENTS.md 五)。 */
const POLL_INTERVAL_MS = 5_000
const POLICY_PROVENANCE_FIELDS = Object.freeze([
  'id',
  'owner',
  'version',
  'revision',
  'releaseDigest',
  'generation',
  'source',
])

function isBuiltinPolicyProvenance(value) {
  return value?.id === BUILTIN_POLICY_ID && value?.owner === 'builtin'
}

function samePolicyProvenance(expected, actual) {
  if (!expected || !actual) return false
  return POLICY_PROVENANCE_FIELDS.every((field) => (
    (expected[field] ?? null) === (actual[field] ?? null)
  ))
}

function policyProvenanceIsCompatible(expected, actual) {
  if (expected === undefined) return true
  // Legacy approvals/checkpoints predate provenance. They may be replayed only
  // through the builtin policy and are still reclassified below. A plugin
  // policy must never inherit those ambiguous authorizations.
  if (expected === null) return isBuiltinPolicyProvenance(actual)
  return samePolicyProvenance(expected, actual)
}

function policyDriftResult({ expected = null, actual = null } = {}) {
  return {
    proceed: false,
    reason: '运行时策略已变更，旧的审批或执行快照已失效；请重新发起这次工具调用',
    code: 'policy_provenance_drift',
    policyDrift: true,
    retryable: true,
    expectedPolicyProvenance: expected,
    policyProvenance: actual,
  }
}

function policyFailureResult(decision, provenance = null) {
  const failureCode = decision?.failure?.code || 'RUNTIME_POLICY_EXECUTION_FAILED'
  return {
    proceed: false,
    reason: '当前运行时策略无法给出可信决策，已保守拒绝执行',
    code: 'policy_runtime_unavailable',
    policyFailure: true,
    systemFailure: true,
    retryable: false,
    policyFailureCode: failureCode,
    policyProvenance: provenance,
  }
}

function hasUserIdentity(userId) {
  return typeof userId === 'string' && userId.trim().length > 0
}

function missingUserIdentityResult({ approvalId = null } = {}) {
  return {
    proceed: false,
    reason: '无法确认工具调用所属用户，已保守拒绝执行',
    code: 'approval_user_identity_missing',
    identityFailure: true,
    systemFailure: true,
    retryable: false,
    ...(approvalId ? { approvalId } : {}),
    policyProvenance: getActiveRuntimePolicyProvenance(),
  }
}

function hookAuthorizationFailureResult(validation) {
  return {
    proceed: false,
    reason: validation?.reason || 'Hook 授权来源无法验证，已保守拒绝执行',
    code: validation?.code || 'hook_authorization_provenance_invalid',
    hookAuthorizationFailure: true,
    systemFailure: true,
    retryable: false,
    policyProvenance: getActiveRuntimePolicyProvenance(),
  }
}

export function revalidateHookAuthorization({
  provenance,
  userId,
  origin = 'job',
  jobId = null,
  stepId = null,
  sessionId = null,
  requestId = null,
  toolCallId,
  toolName,
  args = {},
  requireLive = true,
} = {}) {
  try {
    const validation = validateHookAuthorizationProvenance({
      provenance,
      expected: {
        userId,
        origin,
        jobId,
        stepId,
        sessionId,
        requestId,
        toolCallId,
        toolName,
        args,
      },
      resolveHook: getHook,
      requireLive,
    })
    return validation.valid
      ? { proceed: true, hookAuthorizationProvenance: validation.provenance }
      : hookAuthorizationFailureResult(validation)
  } catch {
    return hookAuthorizationFailureResult({
      code: 'hook_authorization_verification_failed',
      reason: 'Hook 授权验证失败，已保守拒绝执行',
    })
  }
}

function approvalContextMismatchResult(approval, expected = null) {
  return {
    proceed: false,
    reason: '持久化审批与当前工具调用不匹配，已保守拒绝执行',
    code: 'approval_context_mismatch',
    approvalContextMismatch: true,
    retryable: false,
    approvalId: approval?.id || null,
    policyProvenance: getActiveRuntimePolicyProvenance(),
    expectedApprovalContext: expected,
  }
}

function approvalMatchesExpectedContext(approval, expected) {
  if (!expected) return true
  if (!approval) return false
  for (const field of ['userId', 'origin', 'jobId', 'stepId', 'sessionId', 'toolName']) {
    if (expected[field] !== undefined
      && (approval[field] ?? null) !== (expected[field] ?? null)) return false
  }
  if (expected.policyProvenance !== undefined) {
    if (expected.policyProvenance === null) return approval.policyProvenance === null
    return samePolicyProvenance(expected.policyProvenance, approval.policyProvenance)
  }
  return true
}

function classifyWithActivePolicy({ toolName, args, options }) {
  const lease = acquireRuntimePolicy()
  try {
    const decision = lease.classify({ toolName, args, options })
    return {
      decision,
      policyProvenance: lease.provenance,
    }
  } finally {
    lease.release()
  }
}

function plainPolicyData(value) {
  if (value == null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function resolvePolicyInputs({ userId, toolName, args, settings }) {
  const dynamicMetadata = getToolMetadata(toolName, { args, userId })
  const dynamicRegistration = getDynamicTool(toolName, { userId })
  const isRuntimePlugin = dynamicRegistration?.origin === 'plugin'
    || dynamicMetadata?.origin === 'plugin'
  // Persisted name-only rules must never transfer to a newly installed or
  // shadowing runtime implementation.
  const riskOverride = isRuntimePlugin
    ? null
    : settings.riskOverrides?.find((item) => item?.toolName === toolName) || null
  const metadata = riskOverride
    ? {
        ...(dynamicMetadata || {}),
        riskClass: riskOverride.riskClass,
        requiresApproval: riskOverride.riskClass !== 'read',
        reason: `用户风险覆盖: ${riskOverride.riskClass}`,
      }
    : dynamicMetadata
  return { isRuntimePlugin, riskOverride, metadata }
}

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
  taskGrants = [],
  expectedPolicyProvenance = undefined,
  allowAsk = false,
} = {}) {
  const activeProvenance = getActiveRuntimePolicyProvenance()
  if (!hasUserIdentity(userId)) return missingUserIdentityResult()
  if (!policyProvenanceIsCompatible(expectedPolicyProvenance, activeProvenance)) {
    return policyDriftResult({ expected: expectedPolicyProvenance, actual: activeProvenance })
  }

  try {
    const settings = getApprovalSettings({ userId })
    const { isRuntimePlugin, metadata } = resolvePolicyInputs({
      userId,
      toolName,
      args,
      settings,
    })
    const classified = classifyWithActivePolicy({
      toolName,
      args,
      options: {
        origin,
        // The queue mode is intentionally enabled for revalidation. `allowAsk`
        // decides whether a prior, provenance-matched approval can satisfy an
        // ask result; an auto-allowed checkpoint must still be allow now.
        mode: 'unattended',
        permissionMode: settings.mode,
        taskGrants,
        rememberedGrants: isRuntimePlugin ? [] : settings.rememberedGrants,
        metadata,
      },
    })
    if (!policyProvenanceIsCompatible(expectedPolicyProvenance, classified.policyProvenance)) {
      return policyDriftResult({
        expected: expectedPolicyProvenance,
        actual: classified.policyProvenance,
      })
    }
    if (classified.decision?.failure) {
      return policyFailureResult(classified.decision, classified.policyProvenance)
    }
    // Host safety invariant: plugin policy cannot manufacture the human approval
    // required for model-authored code. `allowAsk` requires a terminal record.
    if (requiresPerCallApproval(toolName)
      && !allowAsk
      && classified.decision?.decision !== 'deny') {
      return {
        proceed: false,
        reason: toolName === 'run_code'
          ? 'run_code 必须由用户逐次批准后才能执行'
          : `${toolName} 必须由用户逐次批准后才能执行`,
        approvalRequired: true,
        permissionMode: settings.mode,
        suggestedPermissionMode: settings.mode === 'plan' ? 'acceptEdits' : 'normal',
        policyProvenance: classified.policyProvenance,
      }
    }
    if (classified.decision?.decision === 'allow'
      || (allowAsk && classified.decision?.decision === 'ask')) {
      return {
        proceed: true,
        args,
        permissionMode: settings.mode,
        authorization: plainPolicyData(classified.decision.authorization) || null,
        policyProvenance: classified.policyProvenance,
      }
    }
    return {
      proceed: false,
      reason: classified.decision?.reason || (
        classified.decision?.decision === 'ask'
          ? '当前策略要求重新批准这次调用'
          : '当前策略拒绝这次调用'
      ),
      policyDenied: classified.decision?.decision === 'deny',
      approvalRequired: classified.decision?.decision === 'ask',
      permissionMode: settings.mode,
      suggestedPermissionMode: settings.mode === 'plan' ? 'acceptEdits' : 'normal',
      policyProvenance: classified.policyProvenance,
    }
  } catch (err) {
    console.error('[approval] 重验当前权限失败,已保守拒绝:', err?.stack || err)
    return {
      proceed: false,
      reason: '无法确认当前权限模式,已保守拒绝',
      systemFailure: true,
      retryable: true,
      policyProvenance: getActiveRuntimePolicyProvenance(),
    }
  }
}

function terminalDecisionForCurrentMode(approval, expectedApprovalContext = null) {
  if (approval && !hasUserIdentity(approval.userId)) {
    return missingUserIdentityResult({ approvalId: approval.id })
  }
  if (expectedApprovalContext && !hasUserIdentity(expectedApprovalContext.userId)) {
    return missingUserIdentityResult({ approvalId: approval?.id || null })
  }
  if (approval && !approvalMatchesExpectedContext(approval, expectedApprovalContext)) {
    return approvalContextMismatchResult(approval, expectedApprovalContext)
  }
  const decision = terminalDecision(approval)
  if (!decision?.proceed) return decision

  const args = decision.args ?? approval.effectiveArgs ?? approval.args ?? {}
  const currentPermission = revalidateToolPermission({
    userId: approval.userId,
    origin: approval.origin,
    toolName: approval.toolName,
    args,
    expectedPolicyProvenance: approval.policyProvenance,
    allowAsk: true,
  })
  return currentPermission.proceed
    ? { ...decision, policyProvenance: currentPermission.policyProvenance }
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
    const retryable = gate.retryable !== false
    return {
      ...base,
      denied: false, // 不是「被拒绝」,是没走成
      systemFailure: true,
      retryable,
      error: retryable
        ? `${gate.reason || '审批系统暂时不可用'}。这是系统故障,不是用户拒绝 —— 可以稍后重试,不要因此放弃任务或要求用户手动操作。`
        : `${gate.reason || '授权已失效'}。这是安全校验失败,不是用户拒绝；必须重新发起工具调用获取新的授权。`,
    }
  }
  if (gate?.expired) {
    return { ...base, expired: true, error: `${gate.reason}。用户可能不在,可以先做不需要批准的部分。` }
  }
  if (gate?.cancelled) {
    return { ...base, cancelled: true, error: gate.reason }
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
      error: `${gate.reason || '本次工具调用尚未获得批准'}。请重新发起该工具调用以创建新的逐次审批请求；获得用户批准后再继续。`,
    }
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
  if (!hasUserIdentity(userId)) return missingUserIdentityResult()

  const effectiveMode = mode || resolveApprovalMode()
  // 用户档位 + 「总是允许」清单。读失败不阻断,退回最严格的默认(normal/空)。
  let settings = { mode: undefined, rememberedGrants: [], riskOverrides: [] }
  try {
    settings = getApprovalSettings({ userId })
  } catch (err) {
    console.error('[approval] 读取用户档位失败,按默认最严处理:', err?.stack || err)
  }
  const { isRuntimePlugin, riskOverride, metadata } = resolvePolicyInputs({
    userId,
    toolName,
    args,
    settings,
  })
  const classified = classifyWithActivePolicy({
    toolName,
    args,
    options: {
      origin,
      mode: effectiveMode,
      permissionMode: settings.mode,
      taskGrants,
      rememberedGrants: isRuntimePlugin ? [] : settings.rememberedGrants,
      metadata,
    },
  })
  let verdict = classified.decision
  const policyProvenance = classified.policyProvenance
  if (verdict?.failure) return policyFailureResult(verdict, policyProvenance)
  // Requiring a fresh human decision for model-authored code is owned by the
  // host. Runtime policy plugins may make the classification stricter, but a
  // permissive replacement must never weaken this boundary.
  if (requiresPerCallApproval(toolName) && verdict?.decision !== 'deny') {
    verdict = effectiveMode === 'off'
      ? {
          ...verdict,
          decision: 'deny',
          risk: 'high',
          reason: toolName === 'run_code'
            ? '审批队列已关闭，run_code 必须逐次批准，因此已保守拒绝。请开启审批后重试。'
            : `审批队列已关闭，${toolName} 必须逐次批准，因此已保守拒绝。请开启审批后重试。`,
        }
      : settings.mode === 'plan'
        ? {
            ...verdict,
            decision: 'deny',
            risk: 'high',
            reason: toolName === 'run_code'
              ? '当前是计划模式，run_code 不允许执行。请切换到正常模式后再逐次批准。'
              : `当前是计划模式，${toolName} 不允许执行。请切换到正常模式后再逐次批准。`,
          }
        : {
            ...verdict,
            decision: 'ask',
            risk: 'high',
            reason: verdict?.reason || (toolName === 'run_code'
              ? '执行模型生成的受限代码，每次调用都需要明确批准'
              : `执行 ${toolName}，每次调用都需要明确批准`),
          }
  }
  // plan 档位:直接拒,不排队等人 —— 用户要的就是「只看不动」
  if (verdict?.decision === 'deny') {
    return {
      proceed: false,
      reason: verdict.reason || '当前策略拒绝这次调用',
      policyDenied: true,
      permissionMode: settings.mode,
      suggestedPermissionMode: settings.mode === 'plan' ? 'acceptEdits' : 'normal',
      policyProvenance,
    }
  }
  // Legacy boolean pre-authorization had no Hook identity or call scope and is
  // intentionally rejected. Only a live, exact-call Hook provenance may waive
  // an approval prompt, and it still cannot cross the plan boundary above.
  if (preAuthorized === true && !hookAuthorizationProvenance) {
    return hookAuthorizationFailureResult({
      code: 'hook_authorization_provenance_missing',
      reason: '旧式 Hook 预授权缺少独立来源与调用作用域，已保守拒绝执行',
    })
  }
  if (hookAuthorizationProvenance) {
    const hookAuthorization = revalidateHookAuthorization({
      provenance: hookAuthorizationProvenance,
      userId,
      origin,
      jobId,
      stepId,
      sessionId,
      requestId,
      toolCallId,
      toolName,
      args,
      requireLive: true,
    })
    if (!hookAuthorization.proceed) return hookAuthorization
    // Hooks may waive ordinary prompts, but mandatory tools still enter the
    // durable inbox.
    if (!requiresPerCallApproval(toolName)) {
      return {
        proceed: true,
        args,
        hookAuthorized: true,
        hookAuthorizationProvenance: hookAuthorization.hookAuthorizationProvenance,
        policyProvenance,
      }
    }
  }
  // “全部放行”是用户对审批层的最终选择。Hook 仍可拒绝调用，
  // 但 permissionDecision=ask 不能把 bypass 重新降级为等待审批。
  if (forceApproval === true && settings.mode !== 'bypass') {
    verdict = {
      ...verdict,
      decision: 'ask',
      risk: verdict.risk || 'low',
      reason: String(forceApprovalReason || '').trim() || 'pre_tool_use Hook 要求逐次批准',
    }
  }
  if (verdict?.decision === 'allow') {
    return {
      proceed: true,
      args,
      authorization: plainPolicyData(verdict.authorization) || (riskOverride
        ? { kind: 'risk_override', toolName, riskClass: riskOverride.riskClass }
        : null),
      policyProvenance,
    }
  }

  if (verdict?.decision !== 'ask') return policyFailureResult(verdict, policyProvenance)

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
      risk: verdict.risk,
      metadataSource: metadata?.source,
      policyProvenance,
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
