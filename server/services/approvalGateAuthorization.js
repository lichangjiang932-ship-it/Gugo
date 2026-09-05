import {
  acquireRuntimePolicy,
  getActiveRuntimePolicyProvenance,
} from '../core/runtimePolicyRuntime.js'
import {
  BUILTIN_POLICY_ID,
  requiresPerCallApproval,
  resolveApprovalMode,
} from '../utils/approvalPolicy.js'
import { getApprovalSettings } from './approvalSettingsStore.js'
import { enforceMandatoryPerCallApproval } from './approvalGateAuthorizationSupport.js'
import { getHook } from './hooksService.js'
import { validateHookAuthorizationProvenance } from './hookAuthorizationProvenance.js'
import { getDynamicTool, getToolMetadata } from './toolRegistry.js'

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

export function terminalDecisionForCurrentMode(approval, expectedApprovalContext = null) {
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

export function authorizeApprovalRequest({
  userId,
  origin = 'job',
  jobId = null,
  stepId = null,
  sessionId = null,
  toolName,
  args = {},
  mode = null,
  forceApproval = false,
  forceApprovalReason = null,
  preAuthorized = false,
  hookAuthorizationProvenance = null,
  requestId = null,
  toolCallId = null,
  taskGrants = [],
} = {}) {
  if (!hasUserIdentity(userId)) return { gate: missingUserIdentityResult() }

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
  if (verdict?.failure) return { gate: policyFailureResult(verdict, policyProvenance) }
  // Runtime policies may tighten this host boundary, never weaken it.
  verdict = enforceMandatoryPerCallApproval({
    toolName,
    effectiveMode,
    permissionMode: settings.mode,
    verdict,
  })
  // plan 档位:直接拒,不排队等人 —— 用户要的就是「只看不动」
  if (verdict?.decision === 'deny') {
    return {
      gate: {
        proceed: false,
        reason: verdict.reason || '当前策略拒绝这次调用',
        policyDenied: true,
        permissionMode: settings.mode,
        suggestedPermissionMode: settings.mode === 'plan' ? 'acceptEdits' : 'normal',
        policyProvenance,
      },
    }
  }
  // Legacy boolean pre-authorization had no Hook identity or call scope and is
  // intentionally rejected. Only a live, exact-call Hook provenance may waive
  // an approval prompt, and it still cannot cross the plan boundary above.
  if (preAuthorized === true && !hookAuthorizationProvenance) {
    return {
      gate: hookAuthorizationFailureResult({
        code: 'hook_authorization_provenance_missing',
        reason: '旧式 Hook 预授权缺少独立来源与调用作用域，已保守拒绝执行',
      }),
    }
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
    if (!hookAuthorization.proceed) return { gate: hookAuthorization }
    // Hooks may waive ordinary prompts, but mandatory tools still enter the
    // durable inbox.
    if (!requiresPerCallApproval(toolName)) {
      return {
        gate: {
          proceed: true,
          args,
          hookAuthorized: true,
          hookAuthorizationProvenance: hookAuthorization.hookAuthorizationProvenance,
          policyProvenance,
        },
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
      gate: {
        proceed: true,
        args,
        authorization: plainPolicyData(verdict.authorization) || (riskOverride
          ? { kind: 'risk_override', toolName, riskClass: riskOverride.riskClass }
          : null),
        policyProvenance,
      },
    }
  }

  if (verdict?.decision !== 'ask') {
    return { gate: policyFailureResult(verdict, policyProvenance) }
  }

  return {
    pending: {
      risk: verdict.risk,
      metadataSource: metadata?.source,
      policyProvenance,
      reason: verdict.reason,
    },
  }
}
