/**
 * 审批决策的唯一业务入口。
 *
 * REST 与 WebSocket 都调用这里，确保审批状态、权限模式迁移、迁移历史和
 * remembered grant 在同一个 SQLite 事务内提交，避免出现“已批准但未生效”。
 */
import { getDb } from '../db.js'
import { PERMISSION_MODES } from '../utils/approvalPolicy.js'
import { logWarn } from '../utils/logger.js'
import { releaseApproval } from './approvalGate.js'
import {
  cancelPendingApproval,
  decideApproval,
  getPendingApproval,
} from './approvalStore.js'
import {
  applyApprovedPermissionModeChange,
  getApprovalMode,
  getApprovalSettings,
  isPermissionModeWidening,
  PERMISSION_MODE_CHANGE_TOOL,
  rememberTool,
} from './approvalSettingsStore.js'
import { getJobRuntime } from './jobRuntime.js'

const VALID_DECISIONS = new Set(['approve', 'deny', 'edit'])

export class ApprovalDecisionError extends Error {
  constructor(message, {
    code = 'APPROVAL_DECISION_FAILED',
    statusCode = 400,
    currentMode,
    requestedMode,
    approval = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ApprovalDecisionError'
    this.code = code
    this.statusCode = statusCode
    this.currentMode = currentMode
    this.requestedMode = requestedMode
    this.approval = approval
  }
}

function decisionError(message, options) {
  return new ApprovalDecisionError(message, options)
}

function validatePermissionModeApproval(approval) {
  const args = approval?.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return decisionError('权限模式升级审批参数无效', {
      code: 'PERMISSION_APPROVAL_INVALID',
      statusCode: 409,
    })
  }
  const fromMode = args.fromMode
  const requestedMode = args.toMode
  const justification = String(args.justification || '').trim().slice(0, 1000)
  if (
    !PERMISSION_MODES.includes(fromMode)
    || !PERMISSION_MODES.includes(requestedMode)
    || !isPermissionModeWidening(fromMode, requestedMode)
    || (requestedMode === 'bypass' && !justification)
  ) {
    return decisionError('权限模式升级审批参数无效', {
      code: 'PERMISSION_APPROVAL_INVALID',
      statusCode: 409,
      requestedMode,
    })
  }
  return { fromMode, requestedMode, justification }
}

function invalidatePermissionApproval({ userId, id, error }) {
  cancelPendingApproval({ userId, id })
  error.approval = getPendingApproval({ userId, id })
  return { error, approvalId: id, shouldRelease: true }
}

function makeDecisionTransaction({ userId, id, decision, editedArgs, remember, decidedBy }) {
  const approval = getPendingApproval({ userId, id })
  if (!approval) {
    return {
      error: decisionError('审批不存在', {
        code: 'APPROVAL_NOT_FOUND',
        statusCode: 404,
      }),
      approvalId: id,
      shouldRelease: false,
    }
  }

  const permissionModeChange = approval.toolName === PERMISSION_MODE_CHANGE_TOOL
  if (permissionModeChange && decision === 'edit') {
    return {
      error: decisionError('权限模式升级审批不允许改写参数', {
        code: 'PERMISSION_APPROVAL_EDIT_FORBIDDEN',
        statusCode: 400,
        approval,
      }),
      approvalId: id,
      shouldRelease: false,
    }
  }
  if (permissionModeChange && remember) {
    return {
      error: decisionError('权限模式升级审批不允许记住授权', {
        code: 'PERMISSION_APPROVAL_REMEMBER_FORBIDDEN',
        statusCode: 400,
        approval,
      }),
      approvalId: id,
      shouldRelease: false,
    }
  }

  if (approval.status !== 'pending') {
    return {
      result: {
        ok: false,
        alreadyDecided: true,
        approval,
        modeTransition: null,
        approvalSettings: permissionModeChange ? getApprovalSettings({ userId }) : null,
        rememberedTools: null,
        rememberedGrants: null,
      },
      approvalId: id,
      shouldRelease: true,
    }
  }

  let permissionTransition = null
  if (permissionModeChange && decision === 'approve') {
    const permissionArgs = validatePermissionModeApproval(approval)
    if (permissionArgs instanceof ApprovalDecisionError) {
      return invalidatePermissionApproval({ userId, id, error: permissionArgs })
    }
    const currentMode = getApprovalMode({ userId })
    if (currentMode !== permissionArgs.fromMode) {
      return invalidatePermissionApproval({
        userId,
        id,
        error: decisionError('审批创建后权限模式已变化，请重新发起升级', {
          code: 'PERMISSION_APPROVAL_STALE',
          statusCode: 409,
          currentMode,
          requestedMode: permissionArgs.requestedMode,
        }),
      })
    }
  }

  const decided = decideApproval({
    userId,
    id,
    decision,
    editedArgs: decision === 'edit' ? editedArgs : null,
    decidedBy: decidedBy || userId,
  })
  if (!decided.ok) {
    return {
      result: {
        ok: false,
        alreadyDecided: decided.alreadyDecided,
        approval: decided.approval,
        modeTransition: null,
        approvalSettings: permissionModeChange ? getApprovalSettings({ userId }) : null,
        rememberedTools: null,
        rememberedGrants: null,
      },
      approvalId: id,
      shouldRelease: !!decided.approval && decided.approval.status !== 'pending',
    }
  }

  if (permissionModeChange && decision === 'approve') {
    const args = decided.approval.args
    permissionTransition = applyApprovedPermissionModeChange({
      userId,
      fromMode: args.fromMode,
      mode: args.toMode,
      justification: args.justification,
    })
  }

  let rememberedSettings = null
  if (!permissionModeChange && decision === 'approve' && remember) {
    rememberTool({ userId, toolName: decided.approval.toolName, args: decided.approval.args })
    rememberedSettings = getApprovalSettings({ userId })
  }

  return {
    result: {
      ok: true,
      alreadyDecided: false,
      approval: getPendingApproval({ userId, id }),
      modeTransition: permissionTransition,
      approvalSettings: permissionModeChange ? getApprovalSettings({ userId }) : null,
      rememberedTools: rememberedSettings?.rememberedTools || null,
      rememberedGrants: rememberedSettings?.rememberedGrants || null,
    },
    approvalId: id,
    shouldRelease: true,
  }
}

/**
 * 持久化一个审批决策，并在提交后唤醒相应运行时。
 *
 * @returns {{ok:boolean, alreadyDecided:boolean, approval:object,
 *   modeTransition:object|null, approvalSettings:object|null,
 *   rememberedTools:string[]|null, rememberedGrants:object[]|null}}
 */
export function decideApprovalRequest({
  userId,
  id,
  decision,
  editedArgs = null,
  remember = false,
  decidedBy = null,
} = {}) {
  if (!userId || !id) {
    throw decisionError('userId 与 id 必填', { code: 'APPROVAL_TARGET_REQUIRED' })
  }
  if (!VALID_DECISIONS.has(decision)) {
    throw decisionError(`非法 decision: ${decision || '(空)'}`, {
      code: 'INVALID_APPROVAL_DECISION',
    })
  }
  if (decision === 'edit' && (!editedArgs || typeof editedArgs !== 'object' || Array.isArray(editedArgs))) {
    throw decisionError('decision=edit 时必须提供 args 对象', {
      code: 'APPROVAL_EDIT_ARGS_REQUIRED',
    })
  }

  const db = getDb()
  let outcome
  try {
    outcome = db.transaction(() => makeDecisionTransaction({
      userId,
      id,
      decision,
      editedArgs,
      remember: remember === true,
      decidedBy,
    })).immediate()
  } catch (error) {
    if (error instanceof ApprovalDecisionError) throw error
    throw decisionError('审批决策未完成', {
      code: 'APPROVAL_DECISION_FAILED',
      statusCode: 500,
      cause: error,
    })
  }

  if (outcome.shouldRelease && outcome.approvalId) releaseApproval(outcome.approvalId)
  if (outcome.error) throw outcome.error

  const { result } = outcome
  if (result.ok && result.approval.origin === 'job' && result.approval.jobId) {
    try {
      getJobRuntime().resumeAfterApproval(result.approval.jobId, {
        userId,
        stepId: result.approval.stepId,
      })
    } catch (error) {
      logWarn('approval.decision', 'failed to resume job after committed approval', {
        approvalId: id,
        jobId: result.approval.jobId,
        errorCode: error?.code,
      })
    }
  }
  return result
}
