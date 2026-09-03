export function completeJobWithoutRunnableStep(runtime, context, currentSteps, dependencies) {
  const { job, commitOwned } = context
  const {
    resolveWorkflowState,
    buildFinalOutput,
    getJobWithChildren,
    updateJob,
    deriveJobProgress,
    persistJobOutcomeDiagnostics,
    clearCompletedJobOutcomeDiagnostics,
    listJobSteps,
    updateJobStep,
    appendJobEvent,
    notifyJobTerminal,
    notifyJobStopHook,
  } = dependencies
  const resolution = resolveWorkflowState(currentSteps)
  const workflowCompleted = resolution.state === 'completed'
  let completed = workflowCompleted
  let terminalReason = resolution.reason
  const committed = commitOwned(() => {
    const finalOutput = workflowCompleted
      ? buildFinalOutput(getJobWithChildren(job.id, { userId: job.userId }))
      : null
    completed = workflowCompleted && finalOutput?.complete !== false
    terminalReason = completed
      ? null
      : workflowCompleted
        ? finalOutput?.summary || finalOutput?.issues?.[0] || '任务交付未全部完成'
        : resolution.reason
    updateJob(job.id, completed
      ? { status: 'completed', progress: 100, error: null, finishedAt: Date.now() }
      : {
          status: 'failed',
          error: terminalReason,
          progress: deriveJobProgress(currentSteps),
          finishedAt: Date.now(),
        })
    const diagnostics = completed ? null : persistJobOutcomeDiagnostics(job.id, {
      userId: job.userId,
      reason: terminalReason,
      nextAction: 'retry_job',
    })
    const terminalPayload = completed
      ? { ...finalOutput, status: 'completed', complete: true, error: null }
      : diagnostics
    if (completed) {
      for (const step of listJobSteps(job.id)) {
        const output = clearCompletedJobOutcomeDiagnostics(step.output)
        if (output !== step.output) updateJobStep(step.id, { output })
      }
    }
    runtime.emit(appendJobEvent({
      jobId: job.id,
      type: completed ? 'completed' : 'failed',
      code: completed ? 'JOB_COMPLETED' : 'JOB_FAILED',
      ...(terminalPayload ? { payload: terminalPayload } : {}),
    }))
  })
  if (!committed) return true
  notifyJobTerminal({ ...job, error: completed ? null : terminalReason }, {
    status: completed ? 'completed' : 'failed',
    body: completed ? '任务已完成' : terminalReason,
  })
  notifyJobStopHook(job, {
    status: completed ? 'completed' : 'failed',
    error: completed ? null : terminalReason,
  })
  return true
}

export function startRunnableJobStep(runtime, context, nextStep, dependencies) {
  const { job, commitOwned } = context
  const { updateJobStep, appendJobEvent } = dependencies
  return commitOwned(() => {
    updateJobStep(nextStep.id, {
      status: 'running',
      startedAt: nextStep.startedAt || Date.now(),
    })
    runtime.emit(appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: 'step_started',
      code: 'JOB_STEP_STARTED',
      params: { title: nextStep.title },
    }))
  })
}
