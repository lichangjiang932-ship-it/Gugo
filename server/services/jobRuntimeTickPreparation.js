import { lostJobExecutionLease } from './jobRuntimeLifecycle.js'

const HANDLED = Object.freeze({ handled: true, modelBinding: null })

function recoverAbandonedSteps(runtime, context, dependencies) {
  const { job, commitOwned } = context
  const {
    listJobSteps,
    updateJobStep,
    clearResumedJobOutcomeDiagnostics,
    latestPersistedOutcomeFields,
    appendJobEvent,
  } = dependencies
  const abandonedSteps = ['planning', 'running'].includes(job.status)
    ? listJobSteps(job.id).filter((step) => step.status === 'running')
    : []
  if (abandonedSteps.length === 0) return false
  const recoveredDiagnostics = latestPersistedOutcomeFields(abandonedSteps)
  const committed = commitOwned(() => {
    for (const step of abandonedSteps) {
      updateJobStep(step.id, {
        status: 'queued',
        output: clearResumedJobOutcomeDiagnostics(step.output),
        error: null,
        startedAt: null,
        finishedAt: null,
      })
    }
    runtime.emit(appendJobEvent({
      jobId: job.id,
      type: 'recovered',
      code: 'JOB_EXECUTION_LEASE_RECOVERED',
      payload: {
        ...recoveredDiagnostics,
        reason: 'execution_lease_recovered',
        nextAction: 'resume_execution',
      },
    }))
  })
  return !committed
}

function cancelRequestedJob(runtime, context, dependencies) {
  const { job, commitOwned } = context
  if (!job.cancelRequested && job.status !== 'cancel_requested') return false
  const {
    listJobSteps,
    updateJob,
    updateJobStep,
    JOB_CANCELLED_MESSAGE,
    deriveJobProgress,
    persistJobOutcomeDiagnostics,
    appendJobEvent,
    notifyJobTerminal,
    notifyJobStopHook,
  } = dependencies
  const committed = commitOwned(() => {
    for (const step of listJobSteps(job.id)) {
      if (['queued', 'running'].includes(step.status)) {
        updateJobStep(step.id, {
          status: 'cancelled',
          error: JOB_CANCELLED_MESSAGE,
          finishedAt: Date.now(),
        })
      }
    }
    updateJob(job.id, {
      status: 'cancelled',
      error: JOB_CANCELLED_MESSAGE,
      progress: deriveJobProgress(listJobSteps(job.id)),
      finishedAt: Date.now(),
    })
    const diagnostics = persistJobOutcomeDiagnostics(job.id, {
      userId: job.userId,
      reason: JOB_CANCELLED_MESSAGE,
      nextAction: 'retry_job',
      status: 'cancelled',
    })
    runtime.emit(appendJobEvent({
      jobId: job.id,
      type: 'cancelled',
      code: 'JOB_CANCELLED',
      payload: {
        code: 'JOB_CANCEL_REQUESTED',
        cancellationReason: 'user_requested',
        ...(diagnostics || {}),
      },
    }))
  }, { allowCancellation: true })
  if (committed) {
    notifyJobTerminal({ ...job, error: JOB_CANCELLED_MESSAGE }, {
      status: 'cancelled',
      body: JOB_CANCELLED_MESSAGE,
    })
    notifyJobStopHook(job, { status: 'cancelled', error: JOB_CANCELLED_MESSAGE })
  }
  return true
}

async function pauseForPlanApproval(runtime, context, dependencies) {
  const { job, commitOwned } = context
  const {
    listJobSteps,
    findNextRunnableStep,
    getJobWithChildren,
    resolveJobPlanApproval,
    updateJob,
    buildJobOutcomeDiagnostics,
    buildJobPlanProposalPayload,
    JOB_PLAN_APPROVAL_CONTRACT,
    JOB_PLAN_APPROVAL_VERSION,
    appendJobEvent,
    createNotification,
  } = dependencies
  const approvalCandidate = findNextRunnableStep(listJobSteps(job.id))
  if (!approvalCandidate || approvalCandidate.kind === 'plan') return false
  let paused = false
  let payload = null
  const committed = commitOwned(() => {
    const currentJob = getJobWithChildren(job.id)
    const authorization = resolveJobPlanApproval(currentJob)
    if (!authorization.required || authorization.authorized) return
    paused = true
    updateJob(job.id, { status: 'waiting', error: null, finishedAt: null })
    const diagnostics = buildJobOutcomeDiagnostics(currentJob, {
      reason: authorization.reason || 'plan_approval_required',
      nextAction: 'approve_plan',
      status: 'waiting',
    })
    if (authorization.needsNewProposal) {
      payload = {
        ...buildJobPlanProposalPayload(currentJob, {
          planGuard: authorization.proposal?.payload?.planGuard || null,
          reason: authorization.reason,
          supersedesProposalEventId: authorization.proposal?.id || null,
        }),
        ...diagnostics,
      }
      runtime.emit(appendJobEvent({
        jobId: job.id,
        type: 'plan_proposed',
        code: 'JOB_PLAN_REVIEW_REFRESHED',
        payload,
      }))
    } else {
      payload = {
        ...diagnostics,
        contract: JOB_PLAN_APPROVAL_CONTRACT,
        version: JOB_PLAN_APPROVAL_VERSION,
        proposalEventId: authorization.proposal?.id || null,
        planDigest: authorization.currentPlanDigest,
      }
      runtime.emit(appendJobEvent({
        jobId: job.id,
        type: 'plan_approval_required',
        code: 'JOB_PLAN_APPROVAL_REQUIRED',
        payload,
      }))
    }
  })
  if (!committed || !paused) return !committed
  try {
    createNotification({
      userId: job.userId,
      kind: 'job',
      title: job.title || job.id,
      body: '计划需要重新确认，批准后才会继续执行。',
      link: `/task?job=${encodeURIComponent(job.id)}`,
      data: { jobId: job.id, ...(payload || {}), status: 'waiting', planProposed: true },
    })
  } catch (error) {
    console.error('[jobs] refreshed plan notification failed:', error?.stack || error)
  }
  return true
}

function resolveTickModelBinding(runtime, context, dependencies) {
  const { job, commitOwned } = context
  const {
    isModelReadinessError,
    updateJob,
    persistJobOutcomeDiagnostics,
    appendJobEvent,
    notifyJobTerminal,
    notifyJobStopHook,
  } = dependencies
  try {
    return {
      handled: false,
      modelBinding: runtime.resolveModelBinding({
        userId: job.userId,
        providerId: job.modelProviderId,
        modelName: job.modelName,
        configRevision: job.modelConfigRevision,
        requirePersistedBinding: true,
      }),
    }
  } catch (error) {
    if (!isModelReadinessError(error)) throw error
    const message = error?.message || '任务绑定的模型 Provider 已不可用'
    const committed = commitOwned(() => {
      updateJob(job.id, { status: 'failed', error: message, finishedAt: Date.now() })
      const diagnostics = persistJobOutcomeDiagnostics(job.id, {
        userId: job.userId,
        reason: message,
        nextAction: error.action || 'retry_job',
      })
      runtime.emit(appendJobEvent({
        jobId: job.id,
        type: 'failed',
        code: 'JOB_FAILED',
        payload: {
          code: error.code,
          action: error.action || null,
          providerId: error.providerId || job.modelProviderId || null,
          modelName: error.modelName || job.modelName || null,
          configRevision: error.configRevision ?? job.modelConfigRevision ?? null,
          nextAction: error.action || 'retry_job',
          ...(diagnostics || {}),
        },
      }))
    })
    if (committed) {
      notifyJobTerminal({ ...job, error: message }, { status: 'failed', body: message })
      notifyJobStopHook(job, { status: 'failed', error: message })
    }
    return HANDLED
  }
}

async function startQueuedJob(runtime, context, dependencies) {
  const { job, controller, leaseIsOwned, commitOwned } = context
  if (job.status !== 'queued') return false
  const { dispatchHooks, updateJob, appendJobEvent, persistJobOutcomeDiagnostics, notifyJobTerminal, notifyJobStopHook } = dependencies
  let promptHook = null
  if (!job.startedAt) {
    try {
      promptHook = await dispatchHooks({
        userId: job.userId,
        event: 'user_prompt_submit',
        tool: 'job',
        args: { prompt: job.prompt, jobId: job.id },
        sessionId: job.id,
        requestId: job.id,
        hookInvocationId: `job:${job.id}:user_prompt_submit`,
      })
    } catch (error) {
      promptHook = { allow: false, reason: error?.message || 'job prompt hook failed' }
    }
    if (lostJobExecutionLease(controller.signal) || !leaseIsOwned()) return true
    if (!promptHook.allow) {
      const reason = promptHook.reason || 'job prompt rejected by hook'
      const committed = commitOwned(() => {
        updateJob(job.id, { status: 'failed', error: reason, finishedAt: Date.now() })
        const diagnostics = persistJobOutcomeDiagnostics(job.id, {
          userId: job.userId,
          reason,
          nextAction: 'retry_job',
        })
        runtime.emit(appendJobEvent({ jobId: job.id, type: 'failed', code: 'JOB_FAILED', payload: diagnostics }))
      })
      if (committed) {
        notifyJobTerminal({ ...job, error: reason }, { status: 'failed', body: reason })
        notifyJobStopHook(job, { status: 'failed', error: reason })
      }
      return true
    }
  }
  if (!commitOwned(() => {
    if (typeof promptHook?.replacementArgs?.prompt === 'string') {
      updateJob(job.id, { prompt: promptHook.replacementArgs.prompt })
    }
    updateJob(job.id, { status: 'running', startedAt: job.startedAt || Date.now() })
    runtime.emit(appendJobEvent({ jobId: job.id, type: 'started', code: 'JOB_STARTED' }))
  })) return true
  return false
}

export async function prepareClaimedJobTick(runtime, context, dependencies) {
  if (recoverAbandonedSteps(runtime, context, dependencies)) return HANDLED
  if (cancelRequestedJob(runtime, context, dependencies)) return HANDLED
  if (await pauseForPlanApproval(runtime, context, dependencies)) return HANDLED
  const resolved = resolveTickModelBinding(runtime, context, dependencies)
  if (resolved.handled) return resolved
  if (await startQueuedJob(runtime, context, dependencies)) return HANDLED
  return resolved
}
