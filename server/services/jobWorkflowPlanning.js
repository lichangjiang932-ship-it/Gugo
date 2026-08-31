const RUNNABLE_STEP_STATUSES = new Set(['queued', 'pending'])

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function stepText(step) {
  return cleanText(step?.output?.text) || cleanText(step?.output?.summary)
}

export function deriveJobProgress(steps = []) {
  if (!steps.length) return 0
  const completed = steps.filter((step) => step.status === 'completed').length
  return Math.round((completed / steps.length) * 100)
}

export function withStableStepIds(jobId, steps = []) {
  const seen = new Set()
  return steps.map((step, index) => {
    const base = cleanText(step?.id) || `step-${index + 1}`
    let id = `${jobId}:${base}`
    let suffix = 2
    while (seen.has(id)) {
      id = `${jobId}:${base}-${suffix}`
      suffix += 1
    }
    seen.add(id)
    return {
      ...step,
      id,
      status: RUNNABLE_STEP_STATUSES.has(step?.status) ? 'queued' : (step?.status || 'queued'),
      sortOrder: index,
    }
  })
}

export function normalizeStructuredPlanSteps(steps = []) {
  if (!Array.isArray(steps) || !steps.length) {
    throw new Error('计划至少需要一个步骤')
  }
  const normalized = steps.map((step, index) => {
    const sourceInput = step?.input && typeof step.input === 'object' && !Array.isArray(step.input)
      ? step.input
      : {}
    const acceptance = step?.acceptance ?? sourceInput.acceptance ?? ''
    const verification = step?.verification ?? sourceInput.verification ?? []
    return {
      id: cleanText(step?.id) || `step-${index + 1}`,
      title: cleanText(step?.title) || `步骤 ${index + 1}`,
      kind: cleanText(step?.kind) || 'execute',
      status: 'queued',
      parentStepId: step?.parentStepId || null,
      input: {
        ...sourceInput,
        description: cleanText(step?.description) || cleanText(sourceInput.description),
        action: cleanText(step?.action) || cleanText(sourceInput.action),
        risk: cleanText(step?.risk) || cleanText(sourceInput.risk) || 'low',
        targets: Array.isArray(step?.targets)
          ? step.targets
          : (Array.isArray(sourceInput.targets) ? sourceInput.targets : []),
        acceptance: Array.isArray(acceptance) ? acceptance : cleanText(acceptance),
        verification: Array.isArray(verification) ? verification : [],
      },
    }
  })
  const acceptance = normalized.find((step) => (
    Array.isArray(step.input?.acceptance) && step.input.acceptance.length > 0
  ))?.input.acceptance || []
  const workSteps = normalized.filter((step) => !['verify', 'finalize'].includes(step.kind))
  const verifyStep = normalized.find((step) => step.kind === 'verify') || {
    id: 'verify',
    title: '验证结果并修正问题',
    kind: 'verify',
    status: 'queued',
    parentStepId: null,
    input: { acceptance },
  }
  const finalizeStep = normalized.find((step) => step.kind === 'finalize') || {
    id: 'finalize',
    title: '整理并交付结果',
    kind: 'finalize',
    status: 'queued',
    parentStepId: null,
    input: { acceptance },
  }
  return [...workSteps, verifyStep, finalizeStep]
}

export function normalizeJobCreationSteps(steps = [], { requirePlanApproval = false } = {}) {
  const sourceSteps = requirePlanApproval === true
    && !steps?.some((step) => step?.kind === 'plan')
    ? [{ id: 'plan', title: '理解目标并制定执行计划', kind: 'plan' }, ...(steps || [])]
    : steps
  return normalizeStructuredPlanSteps(sourceSteps).map((step) => (
    requirePlanApproval === true && step.kind === 'plan'
      ? { ...step, input: { ...(step.input || {}), requirePlanApproval: true } }
      : step
  ))
}

export function stepRequiresPlanApproval(step, approvalMode = null) {
  return step?.kind === 'plan'
    && (step.input?.requirePlanApproval === true || approvalMode === 'plan')
}

export function findNextRunnableStep(steps = []) {
  return steps.find((step) => RUNNABLE_STEP_STATUSES.has(step.status)) || null
}

export function resolveWorkflowState(steps = []) {
  if (!steps.length) return { state: 'invalid', reason: '任务没有可执行步骤' }
  const failed = steps.find((step) => step.status === 'failed')
  if (failed) return { state: 'failed', reason: failed.error || `步骤“${failed.title}”执行失败` }
  const cancelled = steps.filter((step) => step.status === 'cancelled')
  if (cancelled.length) {
    const names = cancelled.slice(0, 3).map((step) => step.title || step.id).filter(Boolean)
    return {
      state: 'failed',
      reason: `${cancelled.length} 个步骤已取消${names.length ? `（${names.join('、')}${cancelled.length > names.length ? ' 等' : ''}）` : ''}`,
    }
  }
  const rejectedAcceptance = steps.find((step) => (
    step.kind === 'verify'
    && step.output?.acceptance?.verdict
    && step.output.acceptance.verdict !== 'pass'
  ))
  if (rejectedAcceptance) {
    return {
      state: 'failed',
      reason: rejectedAcceptance.output.acceptance.summary || '任务未通过结构化验收',
    }
  }
  const incompleteFinalization = steps.find((step) => (
    step.kind === 'finalize' && step.output?.complete === false
  ))
  if (incompleteFinalization) {
    return {
      state: 'failed',
      reason: incompleteFinalization.output?.summary || '任务最终交付未通过验收',
    }
  }
  if (steps.every((step) => step.status === 'completed')) return { state: 'completed', reason: null }
  const unresolved = steps.filter((step) => step.status !== 'completed')
  return {
    state: 'blocked',
    reason: `仍有 ${unresolved.length} 个步骤未完成，但当前没有可执行步骤`,
  }
}

export function buildPriorStepsContext(
  steps = [],
  currentStepId,
  { perStepChars = 600, maxSteps = 8 } = {},
) {
  const currentIndex = steps.findIndex((step) => step.id === currentStepId)
  const done = steps
    .filter((step, index) => step.status === 'completed' && (currentIndex < 0 || index < currentIndex))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  if (!done.length) return ''

  const shown = done.slice(-maxSteps)
  const omitted = done.length - shown.length
  const lines = [
    '# 本任务已完成的步骤',
    '基于这些结果继续，不要重复劳动；如果发现冲突，以用户原始目标和可验证事实为准。',
    '',
  ]
  if (omitted > 0) lines.push(`（更早的 ${omitted} 个步骤已省略）`, '')
  for (const step of shown) {
    let text = stepText(step).replace(/\s+/g, ' ')
    if (text.length > perStepChars) text = `${text.slice(0, perStepChars)}…（已截断）`
    const artifacts = Array.isArray(step.output?.artifactIds) && step.output.artifactIds.length
      ? ` [已生成 ${step.output.artifactIds.length} 个产物]`
      : ''
    lines.push(`## ${step.title || step.id}${artifacts}`)
    lines.push(text || '（无文本输出）', '')
  }
  return lines.join('\n').trim()
}

export function buildPlanningBrief(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  const acceptance = steps.find((step) => step.kind === 'plan')?.input?.acceptance
  const executionSteps = steps.filter((step) => !['plan', 'finalize'].includes(step.kind))
  const lines = [
    `目标：${job.prompt}`,
    '',
    '执行顺序：',
    ...executionSteps.map((step, index) => `${index + 1}. ${step.title}`),
  ]
  if (Array.isArray(acceptance) && acceptance.length) {
    lines.push('', '完成标准：', ...acceptance.map((item) => `- ${item}`))
  }
  return lines.join('\n')
}

export function buildVerificationPrompt(job, step) {
  const acceptance = Array.isArray(step?.input?.acceptance) ? step.input.acceptance : []
  const repair = step?.input?.repairContext
  return [
    `原始任务：${job.prompt}`,
    '',
    '现在进入验证与修正阶段。检查此前产出是否真正满足任务，而不是只检查是否调用过工具。',
    acceptance.length ? `完成标准：\n- ${acceptance.join('\n- ')}` : '',
    repair ? `上一次验收未通过（修正轮次 ${step.input.repairAttempt || 1}）：\n${JSON.stringify(repair)}` : '',
    '能运行测试、构建、格式检查或读取产物时，使用相应工具取得证据。',
    '发现任务范围内且可修复的问题就直接修正并重新验证；不要改动任务范围外的用户内容。',
    '最后给出简短验收结论，列出已执行的检查、结果以及仍存在的限制。',
    '结尾必须单独输出一行 <task_evaluation>{"verdict":"pass|fixable|blocked|needs_user","summary":"简短结论","issues":["问题"],"evidence":["检查证据"]}</task_evaluation>。',
    '只有所有完成标准均有证据时才能使用 pass；可在当前任务范围内继续修复用 fixable；外部依赖阻塞用 blocked；必须由用户补充信息或授权用 needs_user。',
  ].filter(Boolean).join('\n')
}
