import {
  acquireRuntimePolicy,
  getActiveRuntimePolicyProvenance,
} from '../core/runtimePolicyRuntime.js'
import {
  BUILTIN_POLICY_ID,
  APPROVAL_MODES,
  requiresPerCallApproval,
  resolveApprovalMode,
} from '../utils/approvalPolicy.js'
import { getEffectiveApprovalSettings as getApprovalSettings } from './approvalSettingsStore.js'
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

function localized(locale, zh, en) {
  return locale === 'zh' ? zh : en
}

function policyDriftResult({ expected = null, actual = null, locale = 'zh' } = {}) {
  return {
    proceed: false,
    reason: localized(locale,
      '运行时策略已变更，旧的审批或执行快照已失效；请重新发起这次工具调用',
      'The runtime policy changed, so the old approval or execution snapshot is stale; please re-issue this tool call.'),
    code: 'policy_provenance_drift',
    policyDrift: true,
    retryable: true,
    expectedPolicyProvenance: expected,
    policyProvenance: actual,
  }
}

function policyFailureResult(decision, provenance = null, locale = 'zh') {
  const failureCode = decision?.failure?.code || 'RUNTIME_POLICY_EXECUTION_FAILED'
  return {
    proceed: false,
    reason: localized(locale,
      '当前运行时策略无法给出可信决策，已保守拒绝执行',
      'The current runtime policy cannot produce a trustworthy decision; execution was conservatively rejected.'),
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

function missingUserIdentityResult({ approvalId = null, locale = 'zh' } = {}) {
  return {
    proceed: false,
    reason: localized(locale,
      '无法确认工具调用所属用户，已保守拒绝执行',
      'The user that owns this tool call could not be determined; execution was conservatively rejected.'),
    code: 'approval_user_identity_missing',
    identityFailure: true,
    systemFailure: true,
    retryable: false,
    ...(approvalId ? { approvalId } : {}),
    policyProvenance: getActiveRuntimePolicyProvenance(),
  }
}

function hookAuthorizationFailureResult(validation, locale = 'zh') {
  return {
    proceed: false,
    reason: validation?.reason || localized(locale,
      'Hook 授权来源无法验证，已保守拒绝执行',
      'The hook authorization source could not be verified; execution was conservatively rejected.'),
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
  locale = 'zh',
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
      : hookAuthorizationFailureResult(validation, locale)
  } catch {
    return hookAuthorizationFailureResult({
      code: 'hook_authorization_verification_failed',
      reason: localized(locale,
        'Hook 授权验证失败，已保守拒绝执行',
        'Hook authorization verification failed; execution was conservatively rejected.'),
    }, locale)
  }
}

function approvalContextMismatchResult(approval, expected = null, locale = 'zh') {
  return {
    proceed: false,
    reason: localized(locale,
      '持久化审批与当前工具调用不匹配，已保守拒绝执行',
      'The persisted approval does not match the current tool call; execution was conservatively rejected.'),
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

function resolvePolicyInputs({ userId, toolName, args, settings, locale = 'zh' }) {
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
        reason: localized(locale,
          `用户风险覆盖: ${riskOverride.riskClass}`,
          `User risk override: ${riskOverride.riskClass}`),
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
function terminalDecision(approval, locale = 'zh') {
  // 记录凭空消失 = 基础设施问题(DB 被清/行被删),不是用户拒绝
  if (!approval) {
    return { proceed: false, reason: localized(locale, '审批记录已丢失', 'The approval record is missing'), systemFailure: true, retryable: true }
  }
  switch (approval.status) {
    case 'approved':
      return { proceed: true, args: approval.effectiveArgs, approvalId: approval.id }
    case 'edited':
      return { proceed: true, args: approval.effectiveArgs, approvalId: approval.id, edited: true }
    case 'denied':
      // 唯一真正的「用户说不」
      return { proceed: false, reason: localized(locale, '用户拒绝了这次调用', 'The user rejected this call'), approvalId: approval.id, deniedByUser: true }
    case 'expired':
      return { proceed: false, reason: localized(locale, '审批超时未处理(视同拒绝)', 'The approval timed out without a decision (treated as rejected)'), approvalId: approval.id, expired: true }
    case 'cancelled':
      return { proceed: false, reason: localized(locale, '任务已取消,审批作废', 'The task was cancelled, so the approval is void'), approvalId: approval.id, cancelled: true }
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
  locale = 'zh',
} = {}) {
  const activeProvenance = getActiveRuntimePolicyProvenance()
  if (!hasUserIdentity(userId)) return missingUserIdentityResult({ locale })
  if (!policyProvenanceIsCompatible(expectedPolicyProvenance, activeProvenance)) {
    return policyDriftResult({ expected: expectedPolicyProvenance, actual: activeProvenance, locale })
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
        locale,
      })
    }
    if (classified.decision?.failure) {
      return policyFailureResult(classified.decision, classified.policyProvenance, locale)
    }
    // Host safety invariant: plugin policy cannot manufacture the human approval
    // required for model-authored code. `allowAsk` requires a terminal record.
    if (requiresPerCallApproval(toolName)
      && !allowAsk
      && classified.decision?.decision !== 'deny') {
      return {
        proceed: false,
        reason: toolName === 'run_code'
          ? localized(locale, 'run_code 必须由用户逐次批准后才能执行', 'run_code must be approved by the user for each call before it can run')
          : localized(locale, `${toolName} 必须由用户逐次批准后才能执行`, `${toolName} must be approved by the user for each call before it can run`),
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
          ? localized(locale, '当前策略要求重新批准这次调用', 'The current policy requires re-approving this call')
          : localized(locale, '当前策略拒绝这次调用', 'The current policy rejects this call')
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
      reason: localized(locale, '无法确认当前权限模式,已保守拒绝', 'The current permission mode could not be confirmed; execution was conservatively rejected.'),
      systemFailure: true,
      retryable: true,
      policyProvenance: getActiveRuntimePolicyProvenance(),
    }
  }
}

export function terminalDecisionForCurrentMode(approval, expectedApprovalContext = null, locale = 'zh') {
  if (approval && !hasUserIdentity(approval.userId)) {
    return missingUserIdentityResult({ approvalId: approval.id, locale })
  }
  if (expectedApprovalContext && !hasUserIdentity(expectedApprovalContext.userId)) {
    return missingUserIdentityResult({ approvalId: approval?.id || null, locale })
  }
  if (approval && !approvalMatchesExpectedContext(approval, expectedApprovalContext)) {
    return approvalContextMismatchResult(approval, expectedApprovalContext, locale)
  }
  const decision = terminalDecision(approval, locale)
  if (!decision?.proceed) return decision

  const args = decision.args ?? approval.effectiveArgs ?? approval.args ?? {}
  const currentPermission = revalidateToolPermission({
    userId: approval.userId,
    origin: approval.origin,
    toolName: approval.toolName,
    args,
    expectedPolicyProvenance: approval.policyProvenance,
    allowAsk: true,
    locale,
  })
  return currentPermission.proceed
    ? { ...decision, policyProvenance: currentPermission.policyProvenance }
    : { ...currentPermission, approvalId: approval.id }
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
  locale = 'zh',
} = {}) {
  if (!hasUserIdentity(userId)) return { gate: missingUserIdentityResult({ locale }) }

  const effectiveMode = APPROVAL_MODES.includes(mode) ? mode : resolveApprovalMode()
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
    locale,
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
  if (verdict?.failure) return { gate: policyFailureResult(verdict, policyProvenance, locale) }
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
        reason: verdict.reason || localized(locale, '当前策略拒绝这次调用', 'The current policy rejects this call'),
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
        reason: localized(locale,
          '旧式 Hook 预授权缺少独立来源与调用作用域，已保守拒绝执行',
          'Legacy hook pre-authorization lacks an independent source and call scope; execution was conservatively rejected.'),
      }, locale),
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
      locale,
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
      reason: String(forceApprovalReason || '').trim() || localized(locale, 'pre_tool_use Hook 要求逐次批准', 'The pre_tool_use hook requires per-call approval'),
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
    return { gate: policyFailureResult(verdict, policyProvenance, locale) }
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
