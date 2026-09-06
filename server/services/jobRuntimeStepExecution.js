function createCurrentStepExecutor(runtime, freshJob) {
  const { host, dependencies: d, job, nextStep, tickBudget, controller, modelBinding, leaseScope } = runtime
  return (stepToExecute) => tickBudget.run(() => host.executeStep({
    job: d.getJobWithChildren(job.id) || freshJob,
    step: stepToExecute,
    signal: controller.signal,
    modelEnv: modelBinding.env,
    claimSteering: () => d.claimJobSteering({ jobId: job.id, userId: job.userId }),
    acknowledgeSteering: (leaseId) => {
      const count = d.acknowledgeJobSteering({ jobId: job.id, userId: job.userId, leaseId })
      if (count > 0) {
        host.emit(d.appendJobEvent({
          jobId: job.id,
          stepId: nextStep.id,
          type: 'steering_consumed',
          code: 'JOB_STEERING_CONSUMED',
          params: { count },
          payload: { count },
        }))
      }
      return count
    },
    releaseSteering: (leaseId) => d.releaseJobSteeringLease({
      jobId: job.id, userId: job.userId, leaseId,
    }),
    commitCheckpoint: (save) => {
      const outcome = host.runtimeCore.lease.runIfOwned(leaseScope, save)
      return outcome?.owned ? outcome.value : null
    },
  }))
}

async function executeAndRepairStep(runtime) {
  const { host, dependencies: d, job, nextStep, controller, leaseIsOwned, commitOwned } = runtime
  const freshJob = d.getJobWithChildren(job.id)
  if (freshJob?.cancelRequested || freshJob?.status === 'cancel_requested') {
    controller.abort(d.userCancellationError('JOB_CANCEL_REQUESTED', 'Cancelled by user'))
  }
  const executeCurrentStep = createCurrentStepExecutor(runtime, freshJob)
  let result = await executeCurrentStep(nextStep)
  if (d.lostJobExecutionLease(controller.signal) || !leaseIsOwned()) return { leaseLost: true }
  const repair = await d.runVerificationRepairLoop({
    initialResult: result,
    nextStep,
    job,
    executeCurrentStep,
    leaseIsValid: () => !d.lostJobExecutionLease(controller.signal) && leaseIsOwned(),
    commitOwned,
    checkpoint: host.runtimeCore.checkpoint,
    emit: host.emit.bind(host),
  })
  if (repair.leaseLost) return { leaseLost: true }
  result = repair.result
  if (!result?.paused && !result?.truncated && d.hasExplicitIncompleteStepOutput(result?.output)) {
    result = {
      ...result,
      ok: false,
      incomplete: true,
      truncated: true,
      incompleteReason: String(
        result.output.incompleteReason || result.reason || '步骤输出仍有未完成条件',
      ).trim(),
    }
  }
  return { result, repairAttempt: repair.repairAttempt }
}

function handlePausedStep(runtime, result) {
  const { host, dependencies: d, job, nextStep, commitOwned } = runtime
  const clarification = result.clarification || {}
  const question = clarification.question || 'The task needs more information before it can continue.'
  const wakeAt = Number(clarification.wakeAt)
  const sleeping = Number.isFinite(wakeAt)
  let waitingPayload = null
  if (!commitOwned(() => {
    d.updateJobStep(nextStep.id, {
      status: 'queued', output: result?.output ?? null, error: null,
      startedAt: null, finishedAt: null,
    })
    d.updateJob(job.id, {
      status: 'waiting', error: null,
      progress: d.deriveJobProgress(d.listJobSteps(job.id)), finishedAt: null,
    })
    if (sleeping) {
      d.scheduleJobWake({
        jobId: job.id, stepId: nextStep.id, userId: job.userId,
        wakeAt, reason: clarification.why || null,
      })
    }
    const diagnostics = d.persistJobOutcomeDiagnostics(job.id, {
      userId: job.userId,
      stepId: nextStep.id,
      reason: clarification.why || question,
      nextAction: sleeping ? 'wait_for_wake' : 'provide_input',
      status: 'waiting',
    })
    waitingPayload = sleeping
      ? { wakeAt, ...(diagnostics || {}) }
      : { clarification, ...(diagnostics || {}) }
    host.emit(d.appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: sleeping ? 'sleeping' : 'awaiting_user',
      code: sleeping ? 'JOB_SLEEPING' : 'JOB_AWAITING_USER',
      params: { question },
      payload: waitingPayload,
    }))
  })) return true
  if (sleeping) return true
  try {
    d.createNotification({
      userId: job.userId,
      kind: 'job',
      title: job.title || job.id,
      body: question,
      link: `/task?job=${encodeURIComponent(job.id)}`,
      data: { jobId: job.id, ...(waitingPayload || {}), status: 'waiting' },
    })
  } catch (error) {
    console.error('[jobs] clarification notification failed:', error?.stack || error)
    try {
      host.emit(d.appendJobEvent({
        jobId: job.id,
        stepId: nextStep.id,
        type: 'notification_failed',
        code: 'JOB_NOTIFICATION_FAILED',
        params: { question },
        payload: { ...(waitingPayload || {}), notificationKind: 'job_clarification', clarification },
      }))
    } catch { /* no remaining notification channel */ }
  }
  return true
}

function handleTruncatedStep(runtime, result) {
  const { host, dependencies: d, job, nextStep, commitOwned } = runtime
  const incompleteReason = String(result.incompleteReason || result.reason || '').trim()
  const why = result.paused
    ? `需要澄清:${result.clarification?.question || '模型请求用户补充信息'}`
    : result.interrupted
      ? `中断:${result.reason || '模型调用出错'}（已保留部分进展，可点重试从断点继续）`
      : result.noProgress
        ? `无进展:${result.reason || '工具调用反复失败或重复'}`
        : result.budgetExceeded
          ? `预算耗尽:${result.reason || '工具调用次数达上限'}`
          : `任务未完成:${incompleteReason || '仍有完成条件尚未满足'}`
  if (!commitOwned(() => {
    d.updateJobStep(nextStep.id, {
      status: 'failed', output: result?.output ?? null, error: why, finishedAt: Date.now(),
    })
    d.updateJob(job.id, {
      status: 'failed', error: why,
      progress: d.deriveJobProgress(d.listJobSteps(job.id)), finishedAt: Date.now(),
    })
    d.cancelJobWake({ jobId: job.id, userId: job.userId })
    const diagnostics = d.persistJobOutcomeDiagnostics(job.id, {
      userId: job.userId, stepId: nextStep.id, reason: why, nextAction: 'retry_step',
    })
    host.emit(d.appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: 'failed',
      code: 'JOB_FAILED',
      payload: {
        code: result.interrupted
          ? 'JOB_STEP_INTERRUPTED'
          : result.noProgress
            ? 'JOB_STEP_NO_PROGRESS'
            : result.budgetExceeded ? 'JOB_STEP_BUDGET_EXHAUSTED' : 'JOB_STEP_INCOMPLETE',
        retryable: result.retryable !== false,
        ...(typeof result.manualRetryable === 'boolean'
          ? { manualRetryable: result.manualRetryable }
          : {}),
        ...(diagnostics || {}),
      },
    }))
  })) return true
  host.runtimeCore.approval.release({ jobId: job.id, userId: job.userId })
  d.notifyJobTerminal({ ...job, error: why }, { status: 'failed', body: why })
  d.notifyJobStopHook(job, { status: 'failed', error: why, stepId: nextStep.id })
  return true
}

function commitCompletedStep(runtime, result, repairAttempt) {
  const { host, dependencies: d, job, nextStep, commitOwned } = runtime
  const requiresApproval = d.stepRequiresPlanApproval(
    nextStep,
    d.getApprovalMode({ userId: job.userId }),
  )
  let planProposalPayload = null
  if (!commitOwned(() => {
    d.updateJobStep(nextStep.id, {
      status: 'completed', output: result?.output ?? null, finishedAt: Date.now(),
    })
    host.runtimeCore.checkpoint.clear({
      jobId: job.id, stepId: nextStep.id, userId: job.userId,
    })
    d.cancelJobWake({ jobId: job.id, userId: job.userId })
    d.updateJob(job.id, { progress: d.deriveJobProgress(d.listJobSteps(job.id)) })
    d.emitTaskReviewEvent({
      emit: host.emit.bind(host), jobId: job.id, stepId: nextStep.id,
      acceptance: result?.acceptance, repairAttempt,
    })
    host.emit(d.appendJobEvent({
      jobId: job.id, stepId: nextStep.id, type: 'step_completed',
      code: 'JOB_STEP_COMPLETED', params: { title: nextStep.title },
    }))
    if (requiresApproval) {
      const plannedJob = host.getJob(job.id, { userId: job.userId })
      planProposalPayload = {
        ...d.buildJobPlanProposalPayload(plannedJob, { planGuard: nextStep.input?.planGuard || null }),
        ...d.buildJobOutcomeDiagnostics(plannedJob, {
          reason: 'plan_approval_required', nextAction: 'approve_plan', status: 'waiting',
        }),
      }
      d.updateJob(job.id, { status: 'waiting', error: null, finishedAt: null })
      host.emit(d.appendJobEvent({
        jobId: job.id, stepId: nextStep.id, type: 'plan_proposed',
        code: 'JOB_PLAN_PROPOSED', payload: planProposalPayload,
      }))
    }
  })) return true
  if (!requiresApproval) return false
  try {
    d.createNotification({
      userId: job.userId,
      kind: 'job',
      title: job.title || job.id,
      body: '计划已准备好，批准后才会开始执行。',
      link: `/task?job=${encodeURIComponent(job.id)}`,
      data: { jobId: job.id, ...(planProposalPayload || {}), status: 'waiting', planProposed: true },
    })
  } catch (error) {
    console.error('[jobs] plan notification failed:', error?.stack || error)
  }
  return true
}

function handleJobStepError(runtime, error) {
  const { host, dependencies: d, job, nextStep, controller, leaseIsOwned, commitOwned } = runtime
  if (d.lostJobExecutionLease(controller.signal, error) || !leaseIsOwned()) return true
  const latestJob = d.getJobWithChildren(job.id)
  const cancelled = controller.signal.aborted
    || latestJob?.cancelRequested
    || latestJob?.status === 'cancel_requested'
  if (!cancelled) {
    d.persistJobStepFailure({
      commitOwned, emit: host.emit.bind(host), error, job, step: nextStep,
    })
    return true
  }
  if (!commitOwned(() => {
    for (const step of d.listJobSteps(job.id)) {
      if (['queued', 'running'].includes(step.status)) {
        d.updateJobStep(step.id, {
          status: 'cancelled', error: d.JOB_CANCELLED_MESSAGE, finishedAt: Date.now(),
        })
      }
    }
    d.updateJob(job.id, {
      status: 'cancelled', error: d.JOB_CANCELLED_MESSAGE,
      progress: d.deriveJobProgress(d.listJobSteps(job.id)), finishedAt: Date.now(),
    })
    host.runtimeCore.checkpoint.clear({ jobId: job.id, stepId: nextStep.id, userId: job.userId })
    d.cancelJobWake({ jobId: job.id, userId: job.userId })
    const diagnostics = d.persistJobOutcomeDiagnostics(job.id, {
      userId: job.userId, stepId: nextStep.id, reason: d.JOB_CANCELLED_MESSAGE,
      nextAction: 'retry_job', status: 'cancelled',
    })
    host.emit(d.appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: 'cancelled',
      code: 'JOB_CANCELLED',
      payload: {
        code: 'JOB_CANCEL_REQUESTED',
        cancellationReason: 'user_requested',
        ...(diagnostics || {}),
      },
    }))
  }, { allowCancellation: true })) return true
  d.notifyJobTerminal({ ...job, error: d.JOB_CANCELLED_MESSAGE }, {
    status: 'cancelled', body: d.JOB_CANCELLED_MESSAGE,
  })
  d.notifyJobStopHook(job, {
    status: 'cancelled', error: d.JOB_CANCELLED_MESSAGE, stepId: nextStep.id,
  })
  return true
}

export async function runJobRuntimeStepExecution(input) {
  const runtime = { ...input, host: this }
  const { dependencies: d, job, nextStep } = runtime
  try {
    const execution = await executeAndRepairStep(runtime)
    if (execution.leaseLost) return true
    const { result, repairAttempt } = execution
    if (result?.paused) return handlePausedStep(runtime, result)
    if (result?.truncated) return handleTruncatedStep(runtime, result)
    if (result?.ok === false) {
      d.persistRejectedStepResult({
        result,
        repairAttempt,
        job,
        nextStep,
        runtimeCore: this.runtimeCore,
        commitOwned: runtime.commitOwned,
        emit: this.emit.bind(this),
      })
      return true
    }
    commitCompletedStep(runtime, result, repairAttempt)
  } catch (error) {
    return handleJobStepError(runtime, error)
  } finally {
    if (this.activeControllers.get(job.id) === runtime.controller) {
      this.activeControllers.delete(job.id)
    }
  }
  return true
}
