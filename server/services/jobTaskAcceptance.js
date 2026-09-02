const VERIFICATION_FAILURE = /(未通过|不通过|未能|没能|无法(?:完成|修复|运行|验证)|执行失败|构建失败|测试失败|验证失败|仍然?报错|没有(?:完成|修复|通过)|未完成|尚未(?:修复|完成)|仍(?:然)?存在阻塞|仍有错误|not\s+(?:complete|completed|fixed|passing|working)|tests?\s+failed|build\s+failed)/i
const VERIFICATION_NEEDS_USER = /(需要(?:用户|你)(?:提供|补充|确认|选择|授权)|等待(?:用户|你)|缺少(?:凭据|授权|输入|信息)|needs?\s+(?:user|input|approval)|waiting\s+for\s+(?:user|approval))/i
const VERIFICATION_BLOCKED = /(外部(?:服务|依赖).*?(?:不可用|阻塞)|权限不足|环境(?:不可用|缺失)|无法在当前环境|blocked\s+by|environment\s+(?:is\s+)?unavailable|missing\s+(?:dependency|credential|permission))/i
const ACCEPTANCE_VERDICTS = new Set(['pass', 'fixable', 'blocked', 'needs_user'])
const COMPLETED_TASK_VERIFICATION_STATUSES = new Set([
  'pass',
  'passed',
  'success',
  'succeeded',
  'complete',
  'completed',
  'ok',
])
const BLOCKED_TASK_VERIFICATION_STATUSES = new Set(['indeterminate', 'blocked'])

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function stripEchoedAcceptance(text = '') {
  return String(text || '')
    .replace(/完成标准：[\s\S]*?(?=\n\s*\n|$)/g, '')
    .replace(/现在进入验证与修正阶段。[^\n]*/g, '')
    .replace(/原始任务：[^\n]*/g, '')
    .replace(/能运行测试、构建、格式检查或读取产物时[^\n]*/g, '')
    .replace(/发现任务范围内且可修复的问题就直接修正并重新验证[^\n]*/g, '')
    .replace(/最后给出简短验收结论[^\n]*/g, '')
    .replace(/结尾必须单独输出一行\s*<task_evaluation>[^\n]*/gi, '')
    .replace(/只有所有完成标准均有证据时才能使用 pass[^\n]*/gi, '')
}

export function normalizeJobStringList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item))
    .filter(Boolean)
    .slice(0, 50)
}

function normalizeReviewer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    independent: value.independent === true,
    mode: cleanText(value.mode).slice(0, 120) || 'unknown',
    reviewerModel: cleanText(value.reviewerModel).slice(0, 512) || null,
    workerModel: cleanText(value.workerModel).slice(0, 512) || null,
    ...(cleanText(value.error) ? { error: cleanText(value.error).slice(0, 1_000) } : {}),
  }
}

function normalizeReviewGuard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const decision = cleanText(value.decision).toLowerCase()
  if (!['pass', 'veto', 'error'].includes(decision)) return null
  return {
    pluginId: cleanText(value.pluginId).slice(0, 80) || 'unknown',
    service: 'task-review-guard',
    mode: 'veto_only',
    decision,
    ...(cleanText(value.error) ? { error: cleanText(value.error).slice(0, 120) } : {}),
  }
}

export function normalizeTaskAcceptance(value, fallback = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const verdict = cleanText(value.verdict).toLowerCase()
  if (!ACCEPTANCE_VERDICTS.has(verdict)) return null
  const issues = normalizeJobStringList(value.issues)
  const evidence = normalizeJobStringList(value.evidence)
  const reviewer = normalizeReviewer(value.reviewer || fallback.reviewer)
  const guard = normalizeReviewGuard(value.guard || fallback.guard)
  return {
    verdict,
    summary: cleanText(value.summary) || cleanText(fallback.summary) || (
      verdict === 'pass' ? '任务已通过验收' : '任务尚未通过验收'
    ),
    issues,
    evidence,
    source: cleanText(value.source) || cleanText(fallback.source) || 'structured',
    ...(reviewer ? { reviewer } : {}),
    ...(guard ? { guard } : {}),
  }
}

export function parseTaskEvaluation(text = '') {
  const source = String(text || '')
  const marker = source.match(/<task_evaluation>\s*({[\s\S]*?})\s*<\/task_evaluation>/i)
  if (!marker) return null
  try {
    return normalizeTaskAcceptance(JSON.parse(marker[1]), { source: 'model' })
  } catch {
    return null
  }
}

export function verificationTextReportsFailure(text = '') {
  return VERIFICATION_FAILURE.test(stripEchoedAcceptance(text))
}

function taskVerificationIssue(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    return '任务验证包含无效的检查记录'
  }
  const kind = cleanText(check.kind) || 'check'
  const cwd = cleanText(check.cwd) || '.'
  const status = cleanText(check.status).toLowerCase() || 'unknown'
  const code = cleanText(check.code).toUpperCase()
  const diagnostic = cleanText(check.diagnostic)
    || cleanText(check.message)
    || cleanText(check.summary)
  return [
    `${kind}@${cwd} [${status}${code ? `/${code}` : ''}]`,
    diagnostic ? `：${diagnostic.slice(0, 500)}` : '',
  ].join('')
}

export function evaluateTaskVerificationAcceptance({ taskVerification, evidence = [] } = {}) {
  if (!taskVerification || typeof taskVerification !== 'object' || Array.isArray(taskVerification)) {
    return null
  }
  const incompleteChecks = (Array.isArray(taskVerification.checks)
    ? taskVerification.checks
    : []).filter((check) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) return true
    return !COMPLETED_TASK_VERIFICATION_STATUSES.has(cleanText(check.status).toLowerCase())
  })
  if (incompleteChecks.length === 0) return null

  const blocked = incompleteChecks.some((check) => {
    const status = cleanText(check?.status).toLowerCase()
    const code = cleanText(check?.code).toUpperCase()
    return BLOCKED_TASK_VERIFICATION_STATUSES.has(status)
      || code === 'TASK_VERIFICATION_STATE_OVERFLOW'
  })
  return {
    verdict: blocked ? 'blocked' : 'fixable',
    summary: blocked
      ? '宿主任务验证尚未产生可判定的通过结果'
      : '宿主任务验证仍有未通过或需要重跑的检查',
    issues: incompleteChecks.slice(0, 9).map(taskVerificationIssue),
    evidence: normalizeJobStringList(evidence),
    source: 'task_verification',
  }
}

/**
 * Default TaskEvaluator SPI. A runtime plugin may replace this function via
 * createDefaultExecuteStep({ taskEvaluator }) without changing orchestration.
 */
export function evaluateTaskAcceptance({ text = '', evidence = [], taskVerification = null } = {}) {
  const hostVerification = evaluateTaskVerificationAcceptance({ taskVerification, evidence })
  if (hostVerification) return hostVerification

  const structured = parseTaskEvaluation(text)
  if (structured) {
    return {
      ...structured,
      evidence: structured.evidence.length ? structured.evidence : normalizeJobStringList(evidence),
    }
  }

  const conclusion = stripEchoedAcceptance(text)
  const normalizedEvidence = normalizeJobStringList(evidence)
  if (!cleanText(conclusion)) {
    return {
      verdict: 'blocked',
      summary: '验证步骤没有返回可判定的验收结论',
      issues: ['缺少验收结论'],
      evidence: normalizedEvidence,
      source: 'fallback',
    }
  }
  if (VERIFICATION_NEEDS_USER.test(conclusion)) {
    return {
      verdict: 'needs_user',
      summary: '任务需要用户补充信息或授权后才能继续',
      issues: [cleanText(conclusion).slice(0, 500)],
      evidence: normalizedEvidence,
      source: 'fallback',
    }
  }
  if (VERIFICATION_BLOCKED.test(conclusion)) {
    return {
      verdict: 'blocked',
      summary: '任务被当前环境或外部依赖阻塞',
      issues: [cleanText(conclusion).slice(0, 500)],
      evidence: normalizedEvidence,
      source: 'fallback',
    }
  }
  if (VERIFICATION_FAILURE.test(conclusion)) {
    return {
      verdict: 'fixable',
      summary: '验收发现仍可继续修正的问题',
      issues: [cleanText(conclusion).slice(0, 500)],
      evidence: normalizedEvidence,
      source: 'fallback',
    }
  }
  return {
    verdict: 'pass',
    summary: '任务已通过验收',
    issues: [],
    evidence: normalizedEvidence.length ? normalizedEvidence : [cleanText(conclusion).slice(0, 1000)],
    source: 'fallback',
  }
}
