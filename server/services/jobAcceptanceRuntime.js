import {
  appendJobEvent,
  listJobSteps,
  updateJob,
  updateJobStep,
} from './jobStore.js'
import { cancelJobWake } from './jobWakeStore.js'
import { deriveJobProgress, resolveWorkflowState } from './jobWorkflow.js'
import { notifyJobStopHook, notifyJobTerminal } from './jobRuntimeLifecycle.js'

const JOB_VERIFY_MAX_REPAIR_ATTEMPTS = (() => {
  const value = Number(process.env.JOB_VERIFY_MAX_REPAIR_ATTEMPTS)
  return Number.isFinite(value) && value >= 0 ? Math.min(5, Math.floor(value)) : 2
})()

export async function buildToolStepResult({
  job,
  step,
  result,
  taskEvaluator,
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
  const acceptance = step.kind === 'verify' && !truncated
    ? await taskEvaluator({
        job,
        step,
        text: result.text,
        evidence: output.evidence,
        artifactIds: result.artifactIds,
      })
    : null
  if (acceptance) output.acceptance = acceptance
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

export async function buildTextStepResult({ job, step, text, taskEvaluator }) {
  const output = {
    phase: step.kind,
    text,
    evidence: step.kind === 'verify' && text ? [text] : [],
  }
  const acceptance = step.kind === 'verify'
    ? await taskEvaluator({ job, step, text, evidence: output.evidence, artifactIds: [] })
    : null
  if (acceptance) output.acceptance = acceptance
  return {
    ok: !acceptance || acceptance.verdict === 'pass',
    acceptance,
    error: acceptance && acceptance.verdict !== 'pass' ? acceptance.summary : null,
    output,
  }
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
    cancelJobWake({ jobId: job.id, userId: job.userId })
    emit(appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: 'failed',
      message: failure,
      payload: result.acceptance ? { acceptance: result.acceptance, repairAttempts: repairAttempt } : null,
    }))
  })
  if (!committed) return false
  runtimeCore.approval.release({ jobId: job.id, userId: job.userId })
  notifyJobTerminal({ ...job, error: failure }, { status: 'failed', body: failure })
  notifyJobStopHook(job, { status: 'failed', error: failure, stepId: nextStep.id })
  return true
}

export function completeManualJobTransition({ jobId, stepId, updated, emit }) {
  if (!updated?.steps?.every((step) => step.status === 'completed')) {
    updateJob(jobId, { progress: deriveJobProgress(updated.steps) })
    return
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
  emit(appendJobEvent({
    jobId,
    type: completed ? 'completed' : 'failed',
    message: completed ? '任务已完成' : resolution.reason,
  }))
  notifyJobTerminal(updated, {
    status: completed ? 'completed' : 'failed',
    body: completed ? '任务已完成' : resolution.reason,
  })
  notifyJobStopHook(updated, {
    status: completed ? 'completed' : 'failed',
    error: completed ? null : resolution.reason,
    stepId,
  })
}
