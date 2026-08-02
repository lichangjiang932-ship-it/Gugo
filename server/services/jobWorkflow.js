import { detectArtifactIntent, expectsFileArtifact } from './artifactIntent.js'

const RUNNABLE_STEP_STATUSES = new Set(['queued', 'pending'])

// 验证步骤自己说"没成"的信号。刻意不含"限制"——buildVerificationPrompt 就要求
// 模型列出"仍存在的限制",那是正常输出,不该被判成失败。
// verify 步骤的结论里出现这些词 = 模型自己承认没成。
// ★ 注意:不能简单匹配「阻塞问题」「失败」这类裸词 —— verify 的提示词本身会把
//   完成标准原样回显(「结果可直接使用且没有已知阻塞问题」),裸词匹配会把
//   这句**否定式的验收标准**误判成失败,导致每个正常任务都被标「部分完成」。
//   所以这里只匹配带否定语义的说法,并在匹配前剥掉回显的完成标准段落。
const VERIFICATION_FAILURE = /(未通过|不通过|未能|没能|无法(?:完成|修复|运行|验证)|执行失败|构建失败|测试失败|验证失败|仍然?报错|没有(?:完成|修复|通过)|未完成|尚未(?:修复|完成)|仍(?:然)?存在阻塞|仍有错误|not\s+(?:complete|completed|fixed|passing|working)|tests?\s+failed|build\s+failed)/i

/** 剥掉 verify 提示词回显的「完成标准」清单,只对模型真正的结论做失败判定。 */
function stripEchoedAcceptance(text = '') {
  return String(text || '')
    .replace(/完成标准：[\s\S]*?(?=\n\s*\n|$)/g, '')
    .replace(/现在进入验证与修正阶段。[^\n]*/g, '')
    .replace(/原始任务：[^\n]*/g, '')
}

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

export function findNextRunnableStep(steps = []) {
  return steps.find((step) => RUNNABLE_STEP_STATUSES.has(step.status)) || null
}

export function resolveWorkflowState(steps = []) {
  if (!steps.length) return { state: 'invalid', reason: '任务没有可执行步骤' }
  const failed = steps.find((step) => step.status === 'failed')
  if (failed) return { state: 'failed', reason: failed.error || `步骤“${failed.title}”执行失败` }
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
  return [
    `原始任务：${job.prompt}`,
    '',
    '现在进入验证与修正阶段。检查此前产出是否真正满足任务，而不是只检查是否调用过工具。',
    acceptance.length ? `完成标准：\n- ${acceptance.join('\n- ')}` : '',
    '能运行测试、构建、格式检查或读取产物时，使用相应工具取得证据。',
    '发现任务范围内的问题就直接修正并重新验证；不要改动任务范围外的用户内容。',
    '最后给出简短验收结论，列出已执行的检查、结果以及仍存在的限制。',
  ].filter(Boolean).join('\n')
}

/**
 * finalize 阶段是否自动把文本编译成 Word。
 * 关键词判定已收敛到 artifactIntent —— 和「模型能看到哪些文件工具」是同一个判断源，
 * 不再出现「工具层说不要文档、finalize 却兜底生成一个」的错位。
 */
export function shouldCompileDocx(prompt = '') {
  return detectArtifactIntent(prompt).docx
}

/**
 * 交付结论的三源对账。
 *
 * ★ 以前这里是 `verificationText ? '任务已执行并完成验证' : '任务已执行完成'` ——
 *   只看 verify 有没有吐出文本，不看它说了什么。于是 verify 写着「全部失败、未能修复」，
 *   summary 照样是「任务已执行并完成验证」；9 个步骤 failed 也照样报完成。
 *
 *   现在交叉核对三个独立信号，任一不通过就降级成「部分完成」并列出原因：
 *     1. step.status —— 有没有 failed 步骤（客观事实）
 *     2. verify 结论文本 —— 模型自己有没有说没成
 *     3. 产物对账 —— 用户要了文件却一个 artifact 都没有
 */
export function buildFinalOutput(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  const resultSteps = steps.filter((step) => ['execute', 'batch_item'].includes(step.kind))
  const texts = resultSteps.map(stepText).filter(Boolean)
  const verification = steps.find((step) => step.kind === 'verify')
  const verificationText = stepText(verification)
  const artifactIds = [...new Set(steps.flatMap((step) => (
    Array.isArray(step.output?.artifactIds) ? step.output.artifactIds : []
  )))]

  const issues = []

  const failedSteps = steps.filter((step) => step?.status === 'failed')
  if (failedSteps.length) {
    const names = failedSteps.slice(0, 3).map((step) => step.title || step.id).filter(Boolean)
    issues.push(`${failedSteps.length} 个步骤执行失败${names.length ? `（${names.join('、')}${failedSteps.length > names.length ? ' 等' : ''}）` : ''}`)
  }

  const unfinished = steps.filter((step) => (
    // finalize 自己正在跑(它就是调用者),plan/verify 之外的收尾步骤不算未完成。
    step?.kind !== 'finalize'
    && step?.status && !['completed', 'failed', 'skipped'].includes(step.status)
  ))
  if (unfinished.length) issues.push(`${unfinished.length} 个步骤未走到完成状态`)

  if (verificationText && VERIFICATION_FAILURE.test(stripEchoedAcceptance(verificationText))) {
    issues.push('验证步骤的结论包含未通过项')
  }

  if (expectsFileArtifact(job?.prompt || '') && !artifactIds.length) {
    issues.push('用户要求了可下载的文件产物，但本次没有生成任何产物')
  }

  const complete = issues.length === 0
  const summary = complete
    ? (verificationText ? '任务已执行并完成验证' : '任务已执行完成')
    : `任务部分完成：${issues.join('；')}`

  const baseText = texts.join('\n\n') || verificationText || '任务已完成，没有额外文本结果。'
  const text = complete
    ? baseText
    : `${baseText}\n\n---\n未达成项：\n${issues.map((item) => `- ${item}`).join('\n')}`

  return {
    summary,
    text,
    evidence: verificationText ? [verificationText] : [],
    artifactIds,
    complete,
    issues,
  }
}
