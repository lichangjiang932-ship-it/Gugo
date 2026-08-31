import { detectArtifactIntent, expectsFileArtifact } from './artifactIntent.js'
import {
  excludeVerifiedLocalFiles,
  mergeLocalFileReceipts,
} from './turnRecoveryProjection.js'
import {
  normalizeJobStringList as normalizeStringList,
  normalizeTaskAcceptance as normalizeAcceptance,
  verificationTextReportsFailure,
} from './jobTaskAcceptance.js'

export {
  buildPlanningBrief,
  buildPriorStepsContext,
  buildVerificationPrompt,
  deriveJobProgress,
  findNextRunnableStep,
  normalizeJobCreationSteps,
  normalizeStructuredPlanSteps,
  resolveWorkflowState,
  stepRequiresPlanApproval,
  withStableStepIds,
} from './jobWorkflowPlanning.js'
export { evaluateTaskAcceptance, parseTaskEvaluation } from './jobTaskAcceptance.js'

const ARTIFACT_DELIVERABLE_LABELS = Object.freeze({
  pptx: 'PPTX 演示文稿',
  docx: 'DOCX 文档',
  xlsx: 'XLSX 工作簿',
  html: 'HTML 页面',
  pdf: 'PDF 文档',
  image: '图片',
})

function expectedArtifactTypes(prompt = '') {
  const intent = detectArtifactIntent(prompt)
  return Object.keys(ARTIFACT_DELIVERABLE_LABELS).filter((type) => intent[type] === true)
}

function describeDeliverable(type) {
  return ARTIFACT_DELIVERABLE_LABELS[type] || String(type || '').toUpperCase()
}

const COMPLETED_TASK_VERIFICATION_STATUSES = new Set([
  'pass',
  'passed',
  'success',
  'succeeded',
  'complete',
  'completed',
  'ok',
])

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function stepText(step) {
  return cleanText(step?.output?.text) || cleanText(step?.output?.summary)
}

function stepDiagnosticLabel(step) {
  return cleanText(step?.title) || cleanText(step?.id) || cleanText(step?.kind) || '未命名步骤'
}

function incompleteTaskVerificationChecks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return (Array.isArray(value.checks) ? value.checks : []).filter((check) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) return true
    const status = cleanText(check.status).toLowerCase()
    return !COMPLETED_TASK_VERIFICATION_STATUSES.has(status)
  })
}

function describeTaskVerificationCheck(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return '无效的验证检查记录'
  const kind = cleanText(check.kind) || 'check'
  const cwd = cleanText(check.cwd)
  const status = cleanText(check.status).toLowerCase() || 'unknown'
  const code = cleanText(check.code).toUpperCase()
  const diagnostic = cleanText(check.diagnostic)
    || cleanText(check.message)
    || cleanText(check.summary)
  return [
    `${kind}${cwd ? `@${cwd}` : ''}`,
    `[${status}${code ? `/${code}` : ''}]`,
    diagnostic ? `：${diagnostic.slice(0, 500)}` : '',
  ].join('')
}

function evidenceIdentity(value) {
  if (typeof value === 'string') return `text:${value.trim()}`
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const semanticFields = ['type', 'toolCallId', 'command', 'artifactId', 'path', 'summary']
  const semanticIdentity = semanticFields.map((field) => cleanText(value[field])).join('\u0000')
  if (semanticIdentity.replaceAll('\u0000', '')) return `record:${semanticIdentity}`
  try {
    return Object.keys(value).length > 0 ? `record:${JSON.stringify(value)}` : ''
  } catch {
    return ''
  }
}

export function mergeJobEvidence(...sources) {
  const evidence = []
  const seen = new Set()
  for (const source of sources) {
    for (const item of Array.isArray(source) ? source : []) {
      const value = typeof item === 'string' ? item.trim() : item
      const identity = evidenceIdentity(value)
      if (!identity || seen.has(identity)) continue
      seen.add(identity)
      evidence.push(value)
    }
  }
  return evidence
}

export function normalizeJobLocalFileReceipts({
  verifiedLocalFiles = [],
  retainedLocalFiles = [],
} = {}) {
  const verified = mergeLocalFileReceipts(verifiedLocalFiles)
  return {
    verifiedLocalFiles: verified,
    retainedLocalFiles: excludeVerifiedLocalFiles(
      mergeLocalFileReceipts(retainedLocalFiles),
      verified,
    ),
  }
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
  const evidence = mergeJobEvidence(
    ...steps
      .filter((step) => ['execute', 'batch_item', 'verify'].includes(step?.kind))
      .map((step) => step?.output?.evidence),
    verificationText ? [verificationText] : [],
  )
  // A tool result may report an artifact id before persistence succeeds, and
  // plugin tools can return arbitrary ids. Only owned rows loaded with the job
  // are durable, downloadable deliverables and may satisfy file acceptance.
  const durableArtifacts = (Array.isArray(job?.artifacts) ? job.artifacts : [])
    .filter((artifact) => artifact?.jobId === job?.id && artifact?.userId === job?.userId && artifact?.id)
  const artifactIds = [...new Set(durableArtifacts.map((artifact) => artifact.id))]
  const expectedDeliverables = expectedArtifactTypes(job?.prompt || '')
  const deliveredTypes = new Set(
    durableArtifacts.map((artifact) => String(artifact?.type || '').trim().toLowerCase()).filter(Boolean),
  )
  const completedDeliverables = expectedDeliverables.filter((type) => deliveredTypes.has(type))
  const missingDeliverables = expectedDeliverables.filter((type) => !deliveredTypes.has(type))
  const { verifiedLocalFiles, retainedLocalFiles } = normalizeJobLocalFileReceipts({
    verifiedLocalFiles: mergeLocalFileReceipts(
      ...steps.map((step) => step?.output?.verifiedLocalFiles),
    ),
    retainedLocalFiles: mergeLocalFileReceipts(
      ...steps.map((step) => step?.output?.retainedLocalFiles),
    ),
  })
  const missingRequirements = [...new Set(steps.flatMap((step) => (
    normalizeStringList(step?.output?.missingRequirements)
  )))]
  const incompleteReason = [...steps]
    .reverse()
    .map((step) => cleanText(step?.output?.incompleteReason))
    .find(Boolean) || null
  const taskVerification = [...steps]
    .reverse()
    .map((step) => step?.output?.taskVerification)
    .find((value) => value && typeof value === 'object' && !Array.isArray(value)) || null

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

  for (const step of steps) {
    const output = step?.output
    if (!output || typeof output !== 'object' || Array.isArray(output)) continue
    const label = stepDiagnosticLabel(step)
    const incompleteReason = cleanText(output.incompleteReason)
    if (output.complete === false || incompleteReason) {
      const reason = incompleteReason || cleanText(output.reason) || cleanText(output.summary)
      issues.push(reason
        ? `步骤“${label}”报告未完成：${reason.slice(0, 1_000)}`
        : `步骤“${label}”报告未完成，但未提供具体原因`)
    }

    const missingRequirements = [...new Set(normalizeStringList(output.missingRequirements))]
    if (missingRequirements.length) {
      issues.push(`步骤“${label}”仍缺少完成条件：${missingRequirements.join('、')}`)
    }

    const incompleteChecks = incompleteTaskVerificationChecks(output.taskVerification)
    if (incompleteChecks.length) {
      const shownChecks = incompleteChecks.slice(0, 3).map(describeTaskVerificationCheck)
      const omitted = incompleteChecks.length - shownChecks.length
      issues.push(
        `步骤“${label}”有 ${incompleteChecks.length} 项任务验证未通过或未完成：${shownChecks.join('；')}${omitted > 0 ? `；另有 ${omitted} 项` : ''}`,
      )
    }
  }

  if (retainedLocalFiles.length > 0) {
    issues.push(`${retainedLocalFiles.length} 个已保存文件仍待验证`)
  }

  const acceptance = normalizeAcceptance(verification?.output?.acceptance)
  if (acceptance && acceptance.verdict !== 'pass') {
    issues.push(acceptance.summary || '验证步骤未通过结构化验收')
  } else if (!acceptance && verificationText && verificationTextReportsFailure(verificationText)) {
    issues.push('验证步骤的结论包含未通过项')
  }

  if (missingDeliverables.length) {
    const missing = missingDeliverables.map(describeDeliverable).join('、')
    if (completedDeliverables.length) {
      const completed = completedDeliverables.map(describeDeliverable).join('、')
      issues.push(`文件产物仅部分交付：已完成 ${completed}；缺少 ${missing}`)
    } else {
      issues.push(`用户要求的文件产物未交付：缺少 ${missing}`)
    }
  } else if (expectsFileArtifact(job?.prompt || '') && !artifactIds.length) {
    // Fail closed if the intent schema gains a new deliverable type before
    // this projection is updated. A generic file request must never become a
    // successful task merely because its type is not yet recognized here.
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
    evidence,
    artifactIds,
    completedDeliverables,
    missingDeliverables,
    incompleteReason,
    missingRequirements,
    taskVerification,
    verifiedLocalFiles,
    retainedLocalFiles,
    complete,
    issues,
    acceptance: acceptance || null,
  }
}

export function persistedJobOutcomeFields(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return {}
  const hasVerifiedLocalFiles = Object.hasOwn(output, 'verifiedLocalFiles')
  const hasRetainedLocalFiles = Object.hasOwn(output, 'retainedLocalFiles')
  const localFiles = normalizeJobLocalFileReceipts({
    verifiedLocalFiles: output.verifiedLocalFiles,
    retainedLocalFiles: output.retainedLocalFiles,
  })
  return {
    ...(typeof output.complete === 'boolean' ? { complete: output.complete } : {}),
    ...(String(output.reason || '').trim() ? { reason: String(output.reason).trim() } : {}),
    ...(String(output.incompleteReason || '').trim()
      ? { incompleteReason: String(output.incompleteReason).trim() }
      : {}),
    ...(Array.isArray(output.missingRequirements)
      ? { missingRequirements: output.missingRequirements }
      : {}),
    ...(output.taskVerification && typeof output.taskVerification === 'object'
      && !Array.isArray(output.taskVerification)
      ? { taskVerification: output.taskVerification }
      : {}),
    ...(hasVerifiedLocalFiles ? { verifiedLocalFiles: localFiles.verifiedLocalFiles } : {}),
    ...(hasRetainedLocalFiles ? { retainedLocalFiles: localFiles.retainedLocalFiles } : {}),
    ...(typeof output.retryable === 'boolean' ? { retryable: output.retryable } : {}),
    ...(typeof output.manualRetryable === 'boolean'
      ? { manualRetryable: output.manualRetryable }
      : {}),
    ...(Array.isArray(output.artifactIds) ? { artifactIds: output.artifactIds } : {}),
    ...(Array.isArray(output.completedDeliverables)
      ? { completedDeliverables: output.completedDeliverables }
      : {}),
    ...(Array.isArray(output.missingDeliverables)
      ? { missingDeliverables: output.missingDeliverables }
      : {}),
    ...(Array.isArray(output.issues) ? { issues: output.issues } : {}),
    ...(String(output.nextAction || '').trim()
      ? { nextAction: String(output.nextAction).trim() }
      : {}),
  }
}

const PERSISTED_JOB_OUTCOME_LIST_FIELDS = new Set([
  'missingRequirements',
  'verifiedLocalFiles',
  'retainedLocalFiles',
  'artifactIds',
  'completedDeliverables',
  'missingDeliverables',
  'issues',
])

function mergeTaskVerificationDetails(current, incoming) {
  const previous = current && typeof current === 'object' && !Array.isArray(current)
    ? current
    : {}
  const next = incoming && typeof incoming === 'object' && !Array.isArray(incoming)
    ? incoming
    : null
  if (!next || Object.keys(next).length === 0) {
    return Object.keys(previous).length > 0 ? previous : null
  }
  const merged = { ...previous }
  for (const [field, value] of Object.entries(next)) {
    if (Array.isArray(value)) {
      if (value.length > 0 || !Array.isArray(previous[field])) {
        merged[field] = mergeJobEvidence(previous[field], value)
      }
      continue
    }
    if (value && typeof value === 'object') {
      if (Object.keys(value).length > 0) merged[field] = value
      continue
    }
    if (value !== undefined && value !== null && value !== '') merged[field] = value
  }
  return Object.keys(merged).length > 0 ? merged : null
}

/**
 * Merge durable outcome snapshots without allowing a later sparse/empty
 * projection to erase diagnostics already written by an earlier boundary.
 */
export function mergePersistedJobOutcomeFields(...outputs) {
  const merged = {}
  const observedLists = new Set()
  for (const output of outputs) {
    const fields = persistedJobOutcomeFields(output)
    for (const [field, value] of Object.entries(fields)) {
      if (PERSISTED_JOB_OUTCOME_LIST_FIELDS.has(field) && Array.isArray(value)) {
        observedLists.add(field)
        if (value.length > 0) merged[field] = mergeJobEvidence(merged[field], value)
        continue
      }
      if (field === 'taskVerification') {
        const taskVerification = mergeTaskVerificationDetails(merged.taskVerification, value)
        if (taskVerification) merged.taskVerification = taskVerification
        continue
      }
      if (value && typeof value === 'object') {
        if (Object.keys(value).length > 0) merged[field] = value
        continue
      }
      if (value !== undefined && value !== null && value !== '') merged[field] = value
    }
  }
  for (const field of observedLists) {
    if (!Array.isArray(merged[field])) merged[field] = []
  }
  const localFiles = normalizeJobLocalFileReceipts(merged)
  if (observedLists.has('verifiedLocalFiles')) merged.verifiedLocalFiles = localFiles.verifiedLocalFiles
  if (observedLists.has('retainedLocalFiles')) merged.retainedLocalFiles = localFiles.retainedLocalFiles
  return merged
}

export function clearResumedJobOutcomeDiagnostics(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  const resumed = { ...output }
  for (const key of [
    'status',
    'complete',
    'error',
    'reason',
    'incompleteReason',
    'nextAction',
    'missingRequirements',
    'taskVerification',
    'retryable',
    'manualRetryable',
    'missingDeliverables',
    'issues',
    'acceptance',
    'repairAttempts',
  ]) delete resumed[key]
  const localFiles = normalizeJobLocalFileReceipts({
    verifiedLocalFiles: resumed.verifiedLocalFiles,
    retainedLocalFiles: resumed.retainedLocalFiles,
  })
  if (Object.hasOwn(resumed, 'verifiedLocalFiles')) {
    resumed.verifiedLocalFiles = localFiles.verifiedLocalFiles
  }
  if (Object.hasOwn(resumed, 'retainedLocalFiles')) {
    resumed.retainedLocalFiles = localFiles.retainedLocalFiles
  }
  return resumed
}

export function clearCompletedJobOutcomeDiagnostics(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  const completed = { ...output }
  for (const key of [
    'status',
    'error',
    'reason',
    'incompleteReason',
    'nextAction',
    'missingRequirements',
    'retryable',
    'manualRetryable',
    'missingDeliverables',
    'issues',
  ]) delete completed[key]
  if (completed.complete === false) delete completed.complete
  const localFiles = normalizeJobLocalFileReceipts({
    verifiedLocalFiles: completed.verifiedLocalFiles,
    retainedLocalFiles: completed.retainedLocalFiles,
  })
  if (Object.hasOwn(completed, 'verifiedLocalFiles')) {
    completed.verifiedLocalFiles = localFiles.verifiedLocalFiles
  }
  if (Object.hasOwn(completed, 'retainedLocalFiles')) {
    completed.retainedLocalFiles = localFiles.retainedLocalFiles
  }
  return completed
}

export function buildJobOutcomeDiagnostics(job, {
  reason = null,
  nextAction = null,
  status = 'failed',
} = {}) {
  const delivery = buildFinalOutput(job)
  const persistedDiagnostics = mergePersistedJobOutcomeFields(
    ...(Array.isArray(job?.steps) ? job.steps : []).map((step) => step?.output),
  )
  const carriedDiagnostics = {}
  const carryFields = [
    'incompleteReason',
    'missingRequirements',
    'taskVerification',
    'verifiedLocalFiles',
    'retainedLocalFiles',
    'retryable',
    'manualRetryable',
  ]
  for (const field of carryFields) {
    const value = persistedDiagnostics[field]
    const meaningful = Array.isArray(value)
      ? value.length > 0
      : value && typeof value === 'object'
        ? Object.keys(value).length > 0
        : value !== undefined && value !== null && value !== ''
    if (meaningful) carriedDiagnostics[field] = value
  }
  const localFiles = normalizeJobLocalFileReceipts({
    verifiedLocalFiles: carriedDiagnostics.verifiedLocalFiles,
    retainedLocalFiles: carriedDiagnostics.retainedLocalFiles,
  })
  carriedDiagnostics.verifiedLocalFiles = localFiles.verifiedLocalFiles
  carriedDiagnostics.retainedLocalFiles = localFiles.retainedLocalFiles
  const normalizedReason = String(reason || '').trim().slice(0, 2_000)
  const normalizedNextAction = String(nextAction || '').trim().slice(0, 80)
  const normalizedStatus = ['failed', 'cancelled', 'waiting', 'awaiting_approval'].includes(status)
    ? status
    : 'failed'
  const genericReasons = new Set(['任务未完成', '任务未全部完成', 'task incomplete'])
  const deliveryReason = String(delivery.issues?.[0] || delivery.summary || '').trim().slice(0, 2_000)
  const fallbackReason = {
    awaiting_approval: 'The job is waiting for a required tool approval.',
    cancelled: 'The job was cancelled before all requested work completed.',
    failed: 'The job stopped before all requested work completed.',
    waiting: 'The job is waiting for required user input.',
  }[normalizedStatus]
  const effectiveReason = (normalizedReason && !genericReasons.has(normalizedReason.toLowerCase())
    ? normalizedReason
    : '')
    || (deliveryReason && !genericReasons.has(deliveryReason.toLowerCase()) ? deliveryReason : '')
    || String(carriedDiagnostics.incompleteReason || '').trim().slice(0, 2_000)
    || fallbackReason
  const rawIncompleteReason = String(
    carriedDiagnostics.incompleteReason || normalizedReason || '',
  ).trim().toLowerCase()
  const incompleteReason = /^[a-z][a-z0-9_]{1,95}$/u.test(rawIncompleteReason)
    ? rawIncompleteReason
    : {
        awaiting_approval: 'job_approval_required',
        cancelled: 'job_cancelled',
        failed: 'job_execution_incomplete',
        waiting: 'job_waiting_for_input',
      }[normalizedStatus]
  const inferredMissingRequirements = {
    awaiting_approval: ['approval_decision'],
    cancelled: ['remaining_task_steps'],
    failed: ['remaining_task_steps'],
    waiting: ['user_input'],
  }[normalizedStatus]
  const issues = [...new Set([
    ...(Array.isArray(delivery.issues) ? delivery.issues : []),
    effectiveReason,
  ].map((value) => String(value || '').trim()).filter(Boolean))]
  return {
    ...carriedDiagnostics,
    status: normalizedStatus,
    complete: false,
    error: ['failed', 'cancelled'].includes(normalizedStatus) ? effectiveReason : null,
    reason: effectiveReason,
    incompleteReason,
    missingRequirements: Array.isArray(carriedDiagnostics.missingRequirements)
      && carriedDiagnostics.missingRequirements.length > 0
      ? carriedDiagnostics.missingRequirements
      : inferredMissingRequirements,
    taskVerification: carriedDiagnostics.taskVerification || null,
    verifiedLocalFiles: Array.isArray(carriedDiagnostics.verifiedLocalFiles)
      ? carriedDiagnostics.verifiedLocalFiles
      : [],
    retainedLocalFiles: Array.isArray(carriedDiagnostics.retainedLocalFiles)
      ? carriedDiagnostics.retainedLocalFiles
      : [],
    nextAction: normalizedNextAction || (normalizedStatus === 'waiting' ? 'provide_input' : 'retry_job'),
    artifactIds: Array.isArray(delivery.artifactIds) ? delivery.artifactIds : [],
    completedDeliverables: Array.isArray(delivery.completedDeliverables)
      ? delivery.completedDeliverables
      : [],
    missingDeliverables: Array.isArray(delivery.missingDeliverables)
      ? delivery.missingDeliverables
      : [],
    issues,
    ...(delivery.acceptance ? { acceptance: delivery.acceptance } : {}),
  }
}
