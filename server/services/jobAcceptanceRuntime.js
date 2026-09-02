import {
  appendJobEvent,
  getJobWithChildren,
  listJobSteps,
  updateJob,
  updateJobStep,
} from './jobStore.js'
import { cancelJobWake } from './jobWakeStore.js'
import {
  buildFinalOutput,
  buildJobOutcomeDiagnostics,
  clearCompletedJobOutcomeDiagnostics,
  deriveJobProgress,
  mergeJobEvidence,
  resolveWorkflowState,
} from './jobWorkflow.js'
import { notifyJobStopHook, notifyJobTerminal } from './jobRuntimeLifecycle.js'
import { evaluateTaskVerificationAcceptance } from './jobTaskAcceptance.js'
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
    evidence: mergeJobEvidence(
      result.evidence,
      step.kind === 'verify' && result.text ? [result.text] : [],
    ),
    ...(truncated && String(result.incompleteReason || result.reason || '').trim()
      ? { incompleteReason: String(result.incompleteReason || result.reason).trim() }
      : {}),
    ...(Array.isArray(result.missingRequirements)
      ? { missingRequirements: result.missingRequirements }
      : {}),
    ...(result.taskVerification && typeof result.taskVerification === 'object'
      && !Array.isArray(result.taskVerification)
      ? { taskVerification: result.taskVerification }
      : {}),
    ...(Array.isArray(result.verifiedLocalFiles)
      ? { verifiedLocalFiles: result.verifiedLocalFiles }
      : {}),
    ...(Array.isArray(result.retainedLocalFiles)
      ? { retainedLocalFiles: result.retainedLocalFiles }
      : {}),
    ...(typeof result.retryable === 'boolean' ? { retryable: result.retryable } : {}),
    ...(typeof result.manualRetryable === 'boolean'
      ? { manualRetryable: result.manualRetryable }
      : {}),
  }
  const evaluatedAcceptance = step.kind === 'verify' && !truncated
    ? await taskEvaluator({
        job,
        step,
        text: result.text,
        evidence: output.evidence,
        artifactIds: result.artifactIds,
        taskVerification: output.taskVerification || null,
      })
    : null
  const hostVerificationAcceptance = step.kind === 'verify' && !truncated
    ? evaluateTaskVerificationAcceptance({
        taskVerification: output.taskVerification,
        evidence: output.evidence,
      })
    : null
  const constrainedAcceptance = hostVerificationAcceptance
    ? {
        ...hostVerificationAcceptance,
        ...(evaluatedAcceptance?.reviewer ? { reviewer: evaluatedAcceptance.reviewer } : {}),
      }
    : evaluatedAcceptance
  const acceptance = constrainedAcceptance
    ? await taskReviewGuard({
        acceptance: constrainedAcceptance,
        job,
        step,
        text: result.text,
        evidence: output.evidence,
        artifactIds: result.artifactIds,
        taskVerification: output.taskVerification || null,
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
    incompleteReason: output.incompleteReason || null,
    missingRequirements: output.missingRequirements || [],
    taskVerification: output.taskVerification || null,
    verifiedLocalFiles: output.verifiedLocalFiles || [],
    retainedLocalFiles: output.retainedLocalFiles || [],
    retryable: output.retryable,
    manualRetryable: output.manualRetryable,
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
    code: 'JOB_TASK_REVIEWED',
    params: { verdict: acceptance.verdict },
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
        code: 'JOB_VERIFICATION_REPAIR_STARTED',
        params: { attempt: repairAttempt, maxAttempts: JOB_VERIFY_MAX_REPAIR_ATTEMPTS },
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
            code: 'JOB_VERIFICATION_REPAIR_STALLED',
            params: { attempt: repairAttempt },
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
  let terminalPayload = null
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
    terminalPayload = { ...failurePayload, ...diagnostics }
    updateJobStep(nextStep.id, {
      output: { ...(output || {}), ...diagnostics },
    })
    cancelJobWake({ jobId: job.id, userId: job.userId })
    emitTaskReviewEvent({ emit, jobId: job.id, stepId: nextStep.id, acceptance: result.acceptance, repairAttempt })
    emit(appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: 'failed',
      code: 'JOB_FAILED',
      payload: terminalPayload,
    }))
  })
  if (!committed) return false
  runtimeCore.approval.release({ jobId: job.id, userId: job.userId })
  notifyJobTerminal({ ...job, error: failure }, {
    status: 'failed',
    body: failure,
    payload: terminalPayload,
  })
  notifyJobStopHook(job, { status: 'failed', error: failure, stepId: nextStep.id })
  return true
}

export function completeManualJobTransition({ jobId, userId, updated }) {
  if (!updated?.steps?.every((step) => step.status === 'completed')) {
    updateJob(jobId, { progress: deriveJobProgress(updated.steps) })
    return { terminal: false, event: null }
  }
  const resolution = resolveWorkflowState(updated.steps)
  let completed = resolution.state === 'completed'
  let outcomeReason = String(resolution.reason || '').trim()
  let diagnostics = null
  let finalOutput = null
  if (completed) {
    const snapshot = getJobWithChildren(jobId, { userId })
    finalOutput = buildFinalOutput(snapshot)
    if (finalOutput.complete === false) {
      completed = false
      outcomeReason = String(finalOutput.summary || '任务交付验收未通过').trim()
      diagnostics = {
        ...finalOutput,
        complete: false,
        reason: outcomeReason,
        nextAction: 'retry_job',
      }
      finalOutput = null
    }
    if (completed) {
      for (const persistedStep of snapshot?.steps || []) {
        updateJobStep(persistedStep.id, {
          output: clearCompletedJobOutcomeDiagnostics(persistedStep.output),
        })
      }
    }
    const finalStep = [...(snapshot?.steps || [])].reverse().find((step) => step.kind === 'finalize')
    if (finalStep) {
      const normalizedPriorOutput = completed
        ? clearCompletedJobOutcomeDiagnostics(finalStep.output)
        : finalStep.output
      const priorOutput = normalizedPriorOutput && typeof normalizedPriorOutput === 'object' && !Array.isArray(normalizedPriorOutput)
        ? normalizedPriorOutput
        : {}
      const terminalOutput = finalOutput || diagnostics
      const finalEvidence = mergeJobEvidence(priorOutput.evidence, terminalOutput?.evidence)
      const mergedOutput = {
        ...terminalOutput,
        evidence: finalEvidence,
      }
      if (completed) finalOutput = mergedOutput
      else diagnostics = mergedOutput
      updateJobStep(finalStep.id, {
        output: {
          ...priorOutput,
          ...mergedOutput,
        },
      })
    }
  }
  if (!completed && !diagnostics) {
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
  outcomeReason = String(diagnostics?.reason || outcomeReason || '任务未完成').trim()
  updateJob(jobId, completed
    ? { status: 'completed', progress: 100, error: null, finishedAt: Date.now() }
    : {
        status: 'failed',
        progress: deriveJobProgress(updated.steps),
        error: outcomeReason,
        finishedAt: Date.now(),
      })
  const terminalPayload = {
    ...(finalOutput || diagnostics || {}),
    status: completed ? 'completed' : 'failed',
    complete: completed,
    error: completed ? null : outcomeReason,
  }
  const event = appendJobEvent({
    jobId,
    type: completed ? 'completed' : 'failed',
    code: completed ? 'JOB_COMPLETED' : 'JOB_FAILED',
    payload: terminalPayload,
  })
  return {
    terminal: true,
    completed,
    status: completed ? 'completed' : 'failed',
    error: completed ? null : outcomeReason,
    message: completed ? '任务已完成' : outcomeReason,
    payload: terminalPayload,
    event,
  }
}
