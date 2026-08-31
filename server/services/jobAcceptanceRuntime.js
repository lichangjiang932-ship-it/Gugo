import {
  appendJobEvent,
  getJobWithChildren,
  listJobSteps,
  updateJob,
  updateJobStep,
} from './jobStore.js'
import { cancelJobWake } from './jobWakeStore.js'
import { buildJobOutcomeDiagnostics, deriveJobProgress, resolveWorkflowState } from './jobWorkflow.js'
import { notifyJobStopHook, notifyJobTerminal } from './jobRuntimeLifecycle.js'
import { applyRuntimeTaskReviewGuard } from './taskReviewGuard.js'

const JOB_VERIFY_MAX_REPAIR_ATTEMPTS = (() => {
  const value = Number(process.env.JOB_VERIFY_MAX_REPAIR_ATTEMPTS)
  return Number.isFinite(value) && value >= 0 ? Math.min(5, Math.floor(value)) : 2
})()

export async function buildToolStepResult({
  job,
  step,
  result,
  taskEvaluator,
  taskReviewGuard = applyRuntimeTaskReviewGuard,
}) {
  const truncated = !!(
    result.incomplete
    || result.paused
    || result.budgetExceeded
    || result.noProgress
    || result.interrupted
  )
  const output = {
    phase: step.kind,
    text: result.text,
    artifactIds: result.artifactIds,
    toolIterations: result.iterations,
    evidence: step.kind === 'verify' && result.text ? [result.text] : [],
  }
  const evaluatedAcceptance = step.kind === 'verify' && !truncated
    ? await taskEvaluator({
        job,
        step,
        text: result.text,
        evidence: output.evidence,
        artifactIds: result.artifactIds,
      })
    : null
  const acceptance = evaluatedAcceptance
    ? await taskReviewGuard({
        acceptance: evaluatedAcceptance,
        job,
        step,
        text: result.text,
        evidence: output.evidence,
        artifactIds: result.artifactIds,
        workerModelName: job?.modelName,
      })
    : null
  if (acceptance) {
    output.acceptance = acceptance
    output.issues = [...new Set((Array.isArray(acceptance.issues) ? acceptance.issues : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean))]
  }
  return {
    ok: !truncated && (!acceptance || acceptance.verdict === 'pass'),
    truncated,
    incomplete: !!result.incomplete,
    paused: !!result.paused,
    clarification: result.clarification || null,
    budgetExceeded: !!result.budgetExceeded,
    noProgress: !!result.noProgress,
    interrupted: !!result.interrupted,
    acceptance,
    error: acceptance && acceptance.verdict !== 'pass' ? acceptance.summary : null,
    reason: result.reason || (result.paused ? '需要用户澄清' : null),
    output,
  }
}

export async function buildTextStepResult({
  job,
  step,
  text,
  taskEvaluator,
  taskReviewGuard = applyRuntimeTaskReviewGuard,
}) {
  const output = {
    phase: step.kind,
    text,
    evidence: step.kind === 'verify' && text ? [text] : [],
  }
  const evaluatedAcceptance = step.kind === 'verify'
    ? await taskEvaluator({ job, step, text, evidence: output.evidence, artifactIds: [] })
    : null
  const acceptance = evaluatedAcceptance
    ? await taskReviewGuard({
        acceptance: evaluatedAcceptance,
        job,
        step,
        text,
        evidence: output.evidence,
        artifactIds: [],
        workerModelName: job?.modelName,
      })
    : null
  if (acceptance) {
    output.acceptance = acceptance
    output.issues = [...new Set((Array.isArray(acceptance.issues) ? acceptance.issues : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean))]
  }
  return {
    ok: !acceptance || acceptance.verdict === 'pass',
    acceptance,
    error: acceptance && acceptance.verdict !== 'pass' ? acceptance.summary : null,
    output,
  }
}

export function emitTaskReviewEvent({ emit, jobId, stepId, acceptance, repairAttempt = 0 }) {
  if (!acceptance) return null
  return emit(appendJobEvent({
    jobId,
    stepId,
    type: 'task_reviewed',
    message: `Reviewer verdict: ${acceptance.verdict}`,
    payload: { acceptance, repairAttempts: repairAttempt, reviewer: acceptance.reviewer || null },
  }))
}

function acceptanceSignature(acceptance) {
  return JSON.stringify({
    verdict: acceptance?.verdict || '',
    summary: acceptance?.summary || '',
    issues: [...(acceptance?.issues || [])].map(String).sort(),
  })
}

export async function runVerificationRepairLoop({
  initialResult,
  nextStep,
  job,
  executeCurrentStep,
  leaseIsValid,
  commitOwned,
  checkpoint,
  emit,
}) {
  let result = initialResult
  let repairAttempt = 0
  const failureSignatures = new Set()
  if (result?.acceptance?.verdict === 'fixable') {
    failureSignatures.add(acceptanceSignature(result.acceptance))
  }

  while (
    nextStep.kind === 'verify'
    && !result?.truncated
    && result?.acceptance?.verdict === 'fixable'
    && repairAttempt < JOB_VERIFY_MAX_REPAIR_ATTEMPTS
  ) {
    repairAttempt += 1
    const committed = commitOwned(() => {
      emit(appendJobEvent({
        jobId: job.id,
        stepId: nextStep.id,
        type: 'verification_repair_started',
        message: `验收未通过，开始第 ${repairAttempt} 次修正并重新验证`,
        payload: {
          attempt: repairAttempt,
          maxAttempts: JOB_VERIFY_MAX_REPAIR_ATTEMPTS,
          acceptance: result.acceptance,
        },
      }))
      checkpoint.clear({ jobId: job.id, stepId: nextStep.id, userId: job.userId })
    })
    if (!committed) return { result, repairAttempt, leaseLost: true }

    result = await executeCurrentStep({
      ...nextStep,
      input: {
        ...(nextStep.input || {}),
        repairAttempt,
        repairContext: result.acceptance,
      },
    })
    if (!leaseIsValid()) return { result, repairAttempt, leaseLost: true }

    if (result?.acceptance?.verdict === 'fixable') {
      const signature = acceptanceSignature(result.acceptance)
      if (failureSignatures.has(signature)) {
        const stalledCommitted = commitOwned(() => {
          emit(appendJobEvent({
            jobId: job.id,
            stepId: nextStep.id,
            type: 'verification_repair_stalled',
            message: '修正后验收失败签名未变化，停止重复重试',
            payload: { attempt: repairAttempt, acceptance: result.acceptance },
          }))
        })
        if (!stalledCommitted) return { result, repairAttempt, leaseLost: true }
        break
      }
      failureSignatures.add(signature)
    }
  }

  if (result?.output && result?.acceptance) result.output.repairAttempts = repairAttempt
  if (
    nextStep.kind === 'verify'
    && !result?.truncated
    && result?.acceptance?.verdict === 'needs_user'
  ) {
    checkpoint.makeResumable(
      { jobId: job.id, stepId: nextStep.id, userId: job.userId },
      { resetBudget: true },
    )
    result = {
      ...result,
      paused: true,
      truncated: true,
      clarification: {
        question: result.acceptance.summary,
        why: result.acceptance.issues?.join('；') || null,
      },
    }
  }
  return { result, repairAttempt, leaseLost: false }
}

export function persistRejectedStepResult({
  result,
  repairAttempt,
  job,
  nextStep,
  runtimeCore,
  commitOwned,
  emit,
}) {
  const failure = result.error || result.acceptance?.summary || '步骤执行失败'
  const output = result?.output && typeof result.output === 'object' && !Array.isArray(result.output)
    ? result.output
    : null
  const completedDeliverables = [...new Set((Array.isArray(output?.completedDeliverables)
    ? output.completedDeliverables
    : []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))].slice(0, 16)
  const missingDeliverables = [...new Set((Array.isArray(output?.missingDeliverables)
    ? output.missingDeliverables
    : []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))].slice(0, 16)
  const artifactIds = [...new Set((Array.isArray(output?.artifactIds)
    ? output.artifactIds
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 64)
  const issues = (Array.isArray(output?.issues)
    ? output.issues
    : Array.isArray(result?.acceptance?.issues)
      ? result.acceptance.issues
      : [])
    .map((value) => String(value || '').trim().slice(0, 1_000))
    .filter(Boolean)
    .slice(0, 16)
  const failurePayload = {
    ...(result.acceptance ? { acceptance: result.acceptance } : {}),
    repairAttempts: Math.max(0, Number(repairAttempt) || 0),
    ...(completedDeliverables.length > 0 ? { completedDeliverables } : {}),
    ...(missingDeliverables.length > 0 ? { missingDeliverables } : {}),
    ...(artifactIds.length > 0 ? { artifactIds } : {}),
    ...(issues.length > 0 ? { issues } : {}),
  }
  const committed = commitOwned(() => {
    updateJobStep(nextStep.id, {
      status: 'failed',
      output: result?.output ?? null,
      error: failure,
      finishedAt: Date.now(),
    })
    updateJob(job.id, {
      status: 'failed',
      error: failure,
      progress: deriveJobProgress(listJobSteps(job.id)),
      finishedAt: Date.now(),
    })
    const snapshot = getJobWithChildren(job.id, { userId: job.userId })
    const diagnostics = buildJobOutcomeDiagnostics(snapshot, {
      reason: failure,
      nextAction: 'retry_step',
    })
    updateJobStep(nextStep.id, {
      output: { ...(output || {}), ...diagnostics },
    })
    cancelJobWake({ jobId: job.id, userId: job.userId })
    emitTaskReviewEvent({ emit, jobId: job.id, stepId: nextStep.id, acceptance: result.acceptance, repairAttempt })
    emit(appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: 'failed',
      message: failure,
      payload: { ...failurePayload, ...diagnostics },
    }))
  })
  if (!committed) return false
  runtimeCore.approval.release({ jobId: job.id, userId: job.userId })
  notifyJobTerminal({ ...job, error: failure }, { status: 'failed', body: failure })
  notifyJobStopHook(job, { status: 'failed', error: failure, stepId: nextStep.id })
  return true
}

export function completeManualJobTransition({ jobId, userId, updated }) {
  if (!updated?.steps?.every((step) => step.status === 'completed')) {
    updateJob(jobId, { progress: deriveJobProgress(updated.steps) })
    return { terminal: false, event: null }
  }
  const resolution = resolveWorkflowState(updated.steps)
  const completed = resolution.state === 'completed'
  updateJob(jobId, completed
    ? { status: 'completed', progress: 100, error: null, finishedAt: Date.now() }
    : {
        status: 'failed',
        progress: deriveJobProgress(updated.steps),
        error: resolution.reason,
        finishedAt: Date.now(),
      })
  let diagnostics = null
  if (!completed) {
    const snapshot = getJobWithChildren(jobId, { userId })
    diagnostics = buildJobOutcomeDiagnostics(snapshot, {
      reason: resolution.reason,
      nextAction: 'retry_job',
    })
    const targetStep = [...(snapshot?.steps || [])].reverse().find((step) => (
      step.kind === 'finalize' || step.output?.acceptance?.verdict !== 'pass'
    ))
    if (targetStep) {
      const priorOutput = targetStep.output && typeof targetStep.output === 'object' && !Array.isArray(targetStep.output)
        ? targetStep.output
        : {}
      updateJobStep(targetStep.id, { output: { ...priorOutput, ...diagnostics } })
    }
  }
  const event = appendJobEvent({
    jobId,
    type: completed ? 'completed' : 'failed',
    message: completed ? '任务已完成' : resolution.reason,
    ...(diagnostics ? { payload: diagnostics } : {}),
  })
  return {
    terminal: true,
    completed,
    status: completed ? 'completed' : 'failed',
    error: completed ? null : resolution.reason,
    message: completed ? '任务已完成' : resolution.reason,
    event,
  }
}
