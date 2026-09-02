import { runJobRuntimeStepExecution } from './jobRuntimeStepExecution.js'

const DETERMINISTIC_AUTO_RETRY_BLOCKERS = new Set([
  'JOB_AUTO_RETRY_SIDE_EFFECT_UNKNOWN',
  'JOB_PLAN_APPROVAL_REQUIRED',
  'JOB_STEP_RETRY_STATUS_INVALID',
  'MODEL_AUTH_FAILED',
  'MODEL_CONFIG_MISSING',
  'MODEL_PROVIDER_NOT_FOUND',
])

export async function runJobRuntimeTick(dependencies) {
  const {
    claimDueJobWakes,
    blockClaimedAutoRetryWakeTransition,
    appendJobEvent,
    listRecoverableJobs,
    SUSPENDED_JOB_STATUSES,
    createJobTickBudgetScope,
    getJobRow,
    getJobWithChildren,
    listJobSteps,
    updateJob,
    updateJobStep,
    clearResumedJobOutcomeDiagnostics,
    latestPersistedOutcomeFields,
    JOB_CANCELLED_MESSAGE,
    deriveJobProgress,
    persistJobOutcomeDiagnostics,
    notifyJobTerminal,
    notifyJobStopHook,
    findNextRunnableStep,
    resolveJobPlanApproval,
    buildJobOutcomeDiagnostics,
    buildJobPlanProposalPayload,
    JOB_PLAN_APPROVAL_CONTRACT,
    JOB_PLAN_APPROVAL_VERSION,
    createNotification,
    isModelReadinessError,
    dispatchHooks,
    buildFinalOutput,
    clearCompletedJobOutcomeDiagnostics,
    lostJobExecutionLease,
    resolveWorkflowState,
    TERMINAL_JOB_STATUSES,
  } = dependencies

  for (const wake of claimDueJobWakes()) {
    this.jobUserCache.set(wake.jobId, wake.userId)
    if (wake.kind === 'auto_retry') {
      try {
        this.retryStep(wake.jobId, wake.stepId, {
          userId: wake.userId,
          resetBudget: false,
          preserveModelSnapshot: true,
          automatic: true,
          autoRetryWake: wake,
        })
      } catch (error) {
        if (error?.code === 'JOB_RETRY_CONFLICT') continue
        const current = getJobRow(wake.jobId, { userId: wake.userId })
        if (!current || current.cancelRequested
          || ['cancel_requested', 'cancelled', 'queued', 'planning', 'running', 'completed'].includes(current.status)) {
          continue
        }
        if (!DETERMINISTIC_AUTO_RETRY_BLOCKERS.has(error?.code)
          && !isModelReadinessError(error)) continue
        const blocked = blockClaimedAutoRetryWakeTransition({
          jobId: wake.jobId,
          stepId: wake.stepId,
          userId: wake.userId,
          wakeAt: wake.wakeAt,
          claimedAt: wake.firedAt,
          retryAttempt: wake.retryAttempt,
          claimToken: wake.claimToken,
          errorCode: error?.code || 'JOB_AUTO_RETRY_BLOCKED',
        })
        if (blocked.event) this.emit(blocked.event)
      }
      continue
    }
    this.emit(appendJobEvent({
      jobId: wake.jobId,
      stepId: wake.stepId,
      type: 'wake_fired',
      code: 'JOB_WAKE_FIRED',
      payload: {
        wakeAt: wake.wakeAt,
        ...(wake.diagnostics || {}),
        reason: wake.reason || wake.diagnostics?.reason || null,
        nextAction: 'resume_execution',
      },
    }))
  }
  const jobs = listRecoverableJobs()
  const runnableJobs = jobs.filter((candidate) => (
    !SUSPENDED_JOB_STATUSES.has(candidate.status) && !this.activeJobIds.has(candidate.id)
  ))
  const candidates = [
    ...runnableJobs.filter((candidate) => candidate.status === 'cancel_requested'),
    ...runnableJobs.filter((candidate) => candidate.status === 'queued'),
    ...runnableJobs.filter((candidate) => !['cancel_requested', 'queued'].includes(candidate.status)),
  ]
  const job = candidates.find((candidate) => this.runtimeCore.lease.claim({ jobId: candidate.id }))
  if (!job) return false
  const tickBudget = createJobTickBudgetScope(job)
  const controller = new AbortController()
  this.activeJobIds.add(job.id)
  this.activeControllers.set(job.id, controller)
  const leaseScope = { jobId: job.id }
  const releaseExecutionLease = this.runtimeCore.lease.hold(leaseScope, controller)
  const commitOwned = (callback, { allowCancellation = false } = {}) => {
    const outcome = this.runtimeCore.lease.runIfOwned(leaseScope, () => {
      const current = getJobRow(job.id)
      if (!current) return false
      // requestCancel intentionally does not wait for the execution lease so
      // it can interrupt a long-running model/tool call. Once that durable
      // request exists, an older tick must not overwrite it with completed,
      // failed, waiting, or running state.
      if (!allowCancellation
        && (current.cancelRequested || current.status === 'cancel_requested')) {
        return false
      }
      callback(current)
      return true
    })
    return outcome?.owned === true && outcome.value === true
  }
  const leaseIsOwned = () => this.runtimeCore.lease.owns(leaseScope)
  try {
  const abandonedSteps = ['planning', 'running'].includes(job.status)
    ? listJobSteps(job.id).filter((step) => step.status === 'running')
    : []
  if (abandonedSteps.length > 0) {
    const recoveredDiagnostics = latestPersistedOutcomeFields(abandonedSteps)
    if (!commitOwned(() => {
      for (const step of abandonedSteps) {
        updateJobStep(step.id, {
          status: 'queued',
          output: clearResumedJobOutcomeDiagnostics(step.output),
          error: null,
          startedAt: null,
          finishedAt: null,
        })
      }
      this.emit(appendJobEvent({
        jobId: job.id,
        type: 'recovered',
        code: 'JOB_EXECUTION_LEASE_RECOVERED',
        payload: {
          ...recoveredDiagnostics,
          reason: 'execution_lease_recovered',
          nextAction: 'resume_execution',
        },
      }))
    })) return true
  }
  if (job.cancelRequested || job.status === 'cancel_requested') {
    if (!commitOwned(() => {
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
      this.emit(appendJobEvent({
        jobId: job.id,
        type: 'cancelled',
        code: 'JOB_CANCELLED',
        payload: {
          code: 'JOB_CANCEL_REQUESTED',
          cancellationReason: 'user_requested',
          ...(diagnostics || {}),
        },
      }))
    }, { allowCancellation: true })) return true
    notifyJobTerminal({ ...job, error: JOB_CANCELLED_MESSAGE }, {
      status: 'cancelled',
      body: JOB_CANCELLED_MESSAGE,
    })
    notifyJobStopHook(job, { status: 'cancelled', error: JOB_CANCELLED_MESSAGE })
    return true
  }

  const approvalCandidate = findNextRunnableStep(listJobSteps(job.id))
  if (approvalCandidate && approvalCandidate.kind !== 'plan') {
    let pausedForPlanApproval = false
    let planPausePayload = null
    if (!commitOwned(() => {
      const currentJob = getJobWithChildren(job.id)
      const authorization = resolveJobPlanApproval(currentJob)
      if (!authorization.required || authorization.authorized) return

      pausedForPlanApproval = true
      updateJob(job.id, { status: 'waiting', error: null, finishedAt: null })
      const pauseDiagnostics = buildJobOutcomeDiagnostics(currentJob, {
        reason: authorization.reason || 'plan_approval_required',
        nextAction: 'approve_plan',
        status: 'waiting',
      })
      if (authorization.needsNewProposal) {
        const proposalPayload = {
          ...buildJobPlanProposalPayload(currentJob, {
            planGuard: authorization.proposal?.payload?.planGuard || null,
            reason: authorization.reason,
            supersedesProposalEventId: authorization.proposal?.id || null,
          }),
          ...pauseDiagnostics,
        }
        planPausePayload = proposalPayload
        this.emit(appendJobEvent({
          jobId: job.id,
          type: 'plan_proposed',
          code: 'JOB_PLAN_REVIEW_REFRESHED',
          payload: proposalPayload,
        }))
      } else {
        planPausePayload = {
          ...pauseDiagnostics,
          contract: JOB_PLAN_APPROVAL_CONTRACT,
          version: JOB_PLAN_APPROVAL_VERSION,
          proposalEventId: authorization.proposal?.id || null,
          planDigest: authorization.currentPlanDigest,
        }
        this.emit(appendJobEvent({
          jobId: job.id,
          type: 'plan_approval_required',
          code: 'JOB_PLAN_APPROVAL_REQUIRED',
          payload: planPausePayload,
        }))
      }
    })) return true
    if (pausedForPlanApproval) {
      try {
        createNotification({
          userId: job.userId,
          kind: 'job',
          title: job.title || job.id,
          body: '计划需要重新确认，批准后才会继续执行。',
          link: `/task?job=${encodeURIComponent(job.id)}`,
          data: {
            jobId: job.id,
            ...(planPausePayload || {}),
            status: 'waiting',
            planProposed: true,
          },
        })
      } catch (error) {
        console.error('[jobs] refreshed plan notification failed:', error?.stack || error)
      }
      return true
    }
  }

  let modelBinding
  try {
    modelBinding = this.resolveModelBinding({
      userId: job.userId,
      providerId: job.modelProviderId,
      modelName: job.modelName,
      configRevision: job.modelConfigRevision,
      requirePersistedBinding: true,
    })
  } catch (error) {
    if (!isModelReadinessError(error)) throw error
    const message = error?.message || '任务绑定的模型 Provider 已不可用'
    if (!commitOwned(() => {
      updateJob(job.id, { status: 'failed', error: message, finishedAt: Date.now() })
      const diagnostics = persistJobOutcomeDiagnostics(job.id, {
        userId: job.userId,
        reason: message,
        nextAction: error.action || 'retry_job',
      })
      this.emit(appendJobEvent({
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
    })) return true
    notifyJobTerminal({ ...job, error: message }, { status: 'failed', body: message })
    notifyJobStopHook(job, { status: 'failed', error: message })
    return true
  }

  if (job.status === 'queued') {
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
        if (!commitOwned(() => {
          updateJob(job.id, { status: 'failed', error: reason, finishedAt: Date.now() })
          const diagnostics = persistJobOutcomeDiagnostics(job.id, {
            userId: job.userId,
            reason,
            nextAction: 'retry_job',
          })
          this.emit(appendJobEvent({
            jobId: job.id,
            type: 'failed',
            code: 'JOB_FAILED',
            payload: diagnostics,
          }))
        })) return true
        notifyJobTerminal({ ...job, error: reason }, { status: 'failed', body: reason })
        notifyJobStopHook(job, { status: 'failed', error: reason })
        return true
      }
    }
    if (!commitOwned(() => {
      if (typeof promptHook?.replacementArgs?.prompt === 'string') {
        updateJob(job.id, { prompt: promptHook.replacementArgs.prompt })
      }
      updateJob(job.id, { status: 'running', startedAt: job.startedAt || Date.now() })
      this.emit(appendJobEvent({
        jobId: job.id,
        type: 'started',
        code: 'JOB_STARTED',
      }))
    })) return true
  }

  const currentSteps = listJobSteps(job.id)
  const nextStep = findNextRunnableStep(currentSteps)
  if (!nextStep) {
    const resolution = resolveWorkflowState(currentSteps)
    const workflowCompleted = resolution.state === 'completed'
    let completed = workflowCompleted
    let terminalReason = resolution.reason
    if (!commitOwned(() => {
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
      this.emit(appendJobEvent({
        jobId: job.id,
        type: completed ? 'completed' : 'failed',
        code: completed ? 'JOB_COMPLETED' : 'JOB_FAILED',
        ...(terminalPayload ? { payload: terminalPayload } : {}),
      }))
    })) return true
    notifyJobTerminal({
      ...job,
      error: completed ? null : terminalReason,
    }, {
      status: completed ? 'completed' : 'failed',
      body: completed ? '任务已完成' : terminalReason,
    })
    notifyJobStopHook(job, {
      status: completed ? 'completed' : 'failed',
      error: completed ? null : terminalReason,
    })
    return true
  }

  if (!commitOwned(() => {
    updateJobStep(nextStep.id, {
      status: 'running',
      startedAt: nextStep.startedAt || Date.now(),
    })
    this.emit(appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: 'step_started',
      code: 'JOB_STEP_STARTED',
      params: { title: nextStep.title },
    }))
  })) return true

  return await runJobRuntimeStepExecution.call(this, {
    dependencies,
    job,
    nextStep,
    tickBudget,
    controller,
    modelBinding,
    leaseScope,
    leaseIsOwned,
    commitOwned,
  })
  } finally {
    releaseExecutionLease()
    if (this.activeControllers.get(job.id) === controller) {
      this.activeControllers.delete(job.id)
    }
    this.activeJobIds.delete(job.id)
    const finalJob = getJobRow(job.id)
    if (finalJob && TERMINAL_JOB_STATUSES.has(finalJob.status)) tickBudget.release()
  }
}
