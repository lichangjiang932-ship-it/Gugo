import { requiresPerCallApproval } from '../utils/approvalPolicy.js'

export function enforceMandatoryPerCallApproval({
  toolName,
  effectiveMode,
  permissionMode,
  verdict,
}) {
  if (!requiresPerCallApproval(toolName) || verdict?.decision === 'deny') return verdict
  if (effectiveMode === 'off') {
    return {
      ...verdict,
      decision: 'deny',
      risk: 'high',
      reason: toolName === 'run_code'
        ? '审批队列已关闭，run_code 必须逐次批准，因此已保守拒绝。请开启审批后重试。'
        : `审批队列已关闭，${toolName} 必须逐次批准，因此已保守拒绝。请开启审批后重试。`,
    }
  }
  if (permissionMode === 'plan') {
    return {
      ...verdict,
      decision: 'deny',
      risk: 'high',
      reason: toolName === 'run_code'
        ? '当前是计划模式，run_code 不允许执行。请切换到正常模式后再逐次批准。'
        : `当前是计划模式，${toolName} 不允许执行。请切换到正常模式后再逐次批准。`,
    }
  }
  return {
    ...verdict,
    decision: 'ask',
    risk: 'high',
    reason: verdict?.reason || (toolName === 'run_code'
      ? '执行模型生成的受限代码，每次调用都需要明确批准'
      : `执行 ${toolName}，每次调用都需要明确批准`),
  }
}
