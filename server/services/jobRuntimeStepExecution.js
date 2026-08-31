export async function runJobRuntimeStepExecution({
  dependencies,
  job,
  nextStep,
  tickBudget,
  controller,
  modelBinding,
  leaseScope,
  leaseIsOwned,
  commitOwned,
}) {
  const {
    getJobWithChildren,
    userCancellationError,
    claimJobSteering,
    acknowledgeJobSteering,
    appendJobEvent,
    releaseJobSteeringLease,
    lostJobExecutionLease,
    runVerificationRepairLoop,
    hasExplicitIncompleteStepOutput,
    updateJobStep,
    updateJob,
    deriveJobProgress,
    listJobSteps,
    scheduleJobWake,
    persistJobOutcomeDiagnostics,
    createNotification,
    cancelJobWake,
    notifyJobTerminal,
    notifyJobStopHook,
    persistRejectedStepResult,
    stepRequiresPlanApproval,
    getApprovalMode,
    emitTaskReviewEvent,
    buildJobPlanProposalPayload,
    buildJobOutcomeDiagnostics,
    persistJobStepFailure,
    JOB_CANCELLED_MESSAGE,
  } = dependencies

try {
  // 直接传 freshJob(已经包含 userId),不再做权限过滤--
  // tick 是服务端内部调度,不是面向用户的查询。
  const freshJob = getJobWithChildren(job.id)
  if (freshJob?.cancelRequested || freshJob?.status === 'cancel_requested') {
    controller.abort(userCancellationError('JOB_CANCEL_REQUESTED', 'Cancelled by user'))
  }
  const executeCurrentStep = (stepToExecute) => tickBudget.run(() => this.executeStep({
    job: getJobWithChildren(job.id) || freshJob,
    step: stepToExecute,
    signal: controller.signal,
    modelEnv: modelBinding.env,
    claimSteering: () => claimJobSteering({ jobId: job.id, userId: job.userId }),
    acknowledgeSteering: (leaseId) => {
      const count = acknowledgeJobSteering({ jobId: job.id, userId: job.userId, leaseId })
      if (count > 0) {
        this.emit(appendJobEvent({
          jobId: job.id,
          stepId: nextStep.id,
          type: 'steering_consumed',
          message: 'User steering injected into the engine loop',
          payload: { count },
        }))
      }
      return count
    },
    releaseSteering: (leaseId) => releaseJobSteeringLease({
      jobId: job.id,
      userId: job.userId,
      leaseId,
    }),
    commitCheckpoint: (save) => {
      const outcome = this.runtimeCore.lease.runIfOwned(leaseScope, save)
      return outcome?.owned ? outcome.value : null
    },
  }))
  let result = await executeCurrentStep(nextStep)
  if (lostJobExecutionLease(controller.signal) || !leaseIsOwned()) return true

  const repair = await runVerificationRepairLoop({
    initialResult: result,
    nextStep,
    job,
    executeCurrentStep,
    leaseIsValid: () => !lostJobExecutionLease(controller.signal) && leaseIsOwned(),
    commitOwned,
    checkpoint: this.runtimeCore.checkpoint,
    emit: this.emit.bind(this),
  })
  if (repair.leaseLost) return true
  result = repair.result
  const { repairAttempt } = repair
  if (!result?.paused && !result?.truncated && hasExplicitIncompleteStepOutput(result?.output)) {
    result = {
      ...result,
      ok: false,
      incomplete: true,
      truncated: true,
      incompleteReason: String(
        result.output.incompleteReason
          || result.reason
          || '步骤输出仍有未完成条件',
      ).trim(),
    }
  }
  // ★ 截断(需澄清 / 预算耗尽):不是失败也不是成功,如实标记并通知用户,
  // 不能再像以前那样被吞成 ok:true 假装完成。
  if (result?.paused) {
    const clarification = result.clarification || {}
    const question = clarification.question || 'The task needs more information before it can continue.'
    const wakeAt = Number(clarification.wakeAt)
    const sleeping = Number.isFinite(wakeAt)
    let waitingPayload = null
    if (!commitOwned(() => {
      updateJobStep(nextStep.id, {
        status: 'queued',
        output: result?.output ?? null,
        error: null,
        startedAt: null,
        finishedAt: null,
      })
      updateJob(job.id, {
        status: 'waiting',
        error: null,
        progress: deriveJobProgress(listJobSteps(job.id)),
        finishedAt: null,
      })
      if (sleeping) {
        scheduleJobWake({
          jobId: job.id,
          stepId: nextStep.id,
          userId: job.userId,
          wakeAt,
          reason: clarification.why || null,
        })
      }
      const diagnostics = persistJobOutcomeDiagnostics(job.id, {
        userId: job.userId,
        stepId: nextStep.id,
        reason: clarification.why || question,
        nextAction: sleeping ? 'wait_for_wake' : 'provide_input',
        status: 'waiting',
      })
      waitingPayload = sleeping
        ? { wakeAt, ...(diagnostics || {}) }
        : { clarification, ...(diagnostics || {}) }
      this.emit(appendJobEvent({
        jobId: job.id,
        stepId: nextStep.id,
        type: sleeping ? 'sleeping' : 'awaiting_user',
        message: question,
        payload: waitingPayload,
      }))
    })) return true
    if (sleeping) return true
    try {
      createNotification({
        userId: job.userId,
        kind: 'job',
        title: job.title || job.id,
        body: question,
        link: `/task?job=${encodeURIComponent(job.id)}`,
        data: { jobId: job.id, ...(waitingPayload || {}), status: 'waiting' },
      })
    } catch (error) {
      // ★ 通知插入失败以前只 console.error 就完事了。
      //
      // 但 waiting 是个「看起来像死了」的状态:job 不再被 tick 调度,
      // 界面上没有任何动静。用户唯一能知道「它在等我回话」的渠道就是这条通知 ——
      // 通知没发出去,用户就只会觉得任务做到一半没后续了。
      // 至少把失败本身落成一个事件,让任务详情页能显示出来。
      console.error('[jobs] clarification notification failed:', error?.stack || error)
      try {
        this.emit(appendJobEvent({
          jobId: job.id,
          stepId: nextStep.id,
          type: 'notification_failed',
          message: `${question}（提醒发送失败，请留意本页面）`,
          payload: {
            ...(waitingPayload || {}),
            notificationKind: 'job_clarification',
            clarification,
          },
        }))
      } catch {
        /* 事件也写不进去就真没别的办法了,不要再往上抛 */
      }
    }
    return true
  }
  if (result?.truncated) {
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
      updateJobStep(nextStep.id, {
        status: 'failed',
        output: result?.output ?? null,
        error: why,
        finishedAt: Date.now(),
      })
      updateJob(job.id, {
        status: 'failed',
        error: why,
        progress: deriveJobProgress(listJobSteps(job.id)),
        finishedAt: Date.now(),
      })
      cancelJobWake({ jobId: job.id, userId: job.userId })
      const diagnostics = persistJobOutcomeDiagnostics(job.id, {
        userId: job.userId,
        stepId: nextStep.id,
        reason: why,
        nextAction: 'retry_step',
      })
      this.emit(appendJobEvent({
        jobId: job.id,
        stepId: nextStep.id,
        type: 'failed',
        message: why,
        payload: {
          code: result.interrupted
            ? 'JOB_STEP_INTERRUPTED'
            : result.noProgress
              ? 'JOB_STEP_NO_PROGRESS'
              : result.budgetExceeded
                ? 'JOB_STEP_BUDGET_EXHAUSTED'
                : 'JOB_STEP_INCOMPLETE',
          retryable: result.retryable !== false,
          ...(typeof result.manualRetryable === 'boolean'
            ? { manualRetryable: result.manualRetryable }
            : {}),
          ...(diagnostics || {}),
        },
      }))
    })) return true
    // ★ 不再删 checkpoint。
    //
    // 原来无论什么原因截断都把 checkpoint 删掉,于是「有一份完整可用的断点」
    // 和「retryStep 从零重跑」同时成立 —— 预算已经烧掉一半的 job 重试时
    // 又要把所有 read 重做一遍,然后再次超预算。
    // 现在保留断点,retryStep 才能真的「从停下的地方继续」。
    // (用户主动取消的路径仍然删除,见下面的 cancelled 分支。)
    this.runtimeCore.approval.release({ jobId: job.id, userId: job.userId })
    notifyJobTerminal({ ...job, error: why }, { status: 'failed', body: why })
    notifyJobStopHook(job, { status: 'failed', error: why, stepId: nextStep.id })
    return true
  }
  if (result?.ok === false) {
    persistRejectedStepResult({
      result,
      repairAttempt,
      job,
      nextStep,
      runtimeCore: this.runtimeCore,
      commitOwned,
      emit: this.emit.bind(this),
    })
    return true
  }
  const requiresPlanApproval = stepRequiresPlanApproval(nextStep, getApprovalMode({ userId: job.userId }))
  let planProposalPayload = null
  if (!commitOwned(() => {
    updateJobStep(nextStep.id, {
      status: 'completed',
      output: result?.output ?? null,
      finishedAt: Date.now(),
    })
    this.runtimeCore.checkpoint.clear({ jobId: job.id, stepId: nextStep.id, userId: job.userId })
    cancelJobWake({ jobId: job.id, userId: job.userId })
    const updatedSteps = listJobSteps(job.id)
    updateJob(job.id, { progress: deriveJobProgress(updatedSteps) })
    emitTaskReviewEvent({ emit: this.emit.bind(this), jobId: job.id, stepId: nextStep.id, acceptance: result?.acceptance, repairAttempt })
    this.emit(appendJobEvent({
      jobId: job.id,
      stepId: nextStep.id,
      type: 'step_completed',
      message: `完成:${nextStep.title}`,
    }))
    if (requiresPlanApproval) {
      const plannedJob = this.getJob(job.id, { userId: job.userId })
      const proposalPayload = {
        ...buildJobPlanProposalPayload(plannedJob, {
          planGuard: nextStep.input?.planGuard || null,
        }),
        ...buildJobOutcomeDiagnostics(plannedJob, {
          reason: 'plan_approval_required',
          nextAction: 'approve_plan',
          status: 'waiting',
        }),
      }
      planProposalPayload = proposalPayload
      updateJob(job.id, { status: 'waiting', error: null, finishedAt: null })
      this.emit(appendJobEvent({
        jobId: job.id,
        stepId: nextStep.id,
        type: 'plan_proposed',
        message: 'Plan proposed; waiting for explicit approval before execution',
        payload: proposalPayload,
      }))
    }
  })) return true
  if (requiresPlanApproval) {
    try {
      createNotification({
        userId: job.userId,
        kind: 'job',
        title: job.title || job.id,
        body: '计划已准备好，批准后才会开始执行。',
        link: `/task?job=${encodeURIComponent(job.id)}`,
        data: {
          jobId: job.id,
          ...(planProposalPayload || {}),
          status: 'waiting',
          planProposed: true,
        },
      })
    } catch (error) {
      console.error('[jobs] plan notification failed:', error?.stack || error)
    }
    return true
  }
} catch (error) {
  if (lostJobExecutionLease(controller.signal, error) || !leaseIsOwned()) return true
  const latestJob = getJobWithChildren(job.id)
  const cancelled = controller.signal.aborted || latestJob?.cancelRequested || latestJob?.status === 'cancel_requested'
  if (cancelled) {
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
      this.runtimeCore.checkpoint.clear({ jobId: job.id, stepId: nextStep.id, userId: job.userId })
      cancelJobWake({ jobId: job.id, userId: job.userId })
      const diagnostics = persistJobOutcomeDiagnostics(job.id, {
        userId: job.userId,
        stepId: nextStep.id,
        reason: JOB_CANCELLED_MESSAGE,
        nextAction: 'retry_job',
        status: 'cancelled',
      })
      this.emit(appendJobEvent({
        jobId: job.id,
        stepId: nextStep.id,
        type: 'cancelled',
        message: JOB_CANCELLED_MESSAGE,
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
    notifyJobStopHook(job, {
      status: 'cancelled',
      error: JOB_CANCELLED_MESSAGE,
      stepId: nextStep.id,
    })
    return true
  }
  persistJobStepFailure({
    commitOwned,
    emit: this.emit.bind(this),
    error,
    job,
    step: nextStep,
  })
} finally {
  if (this.activeControllers.get(job.id) === controller) {
    this.activeControllers.delete(job.id)
  }
}

return true
}

