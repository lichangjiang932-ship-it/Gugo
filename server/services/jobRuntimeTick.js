import { runJobRuntimeStepExecution } from './jobRuntimeStepExecution.js'
import { processJobRuntimeWakes } from './jobRuntimeWakeProcessing.js'
import { claimJobRuntimeTick } from './jobRuntimeTickClaim.js'
import { prepareClaimedJobTick } from './jobRuntimeTickPreparation.js'
import {
  completeJobWithoutRunnableStep,
  startRunnableJobStep,
} from './jobRuntimeTickCompletion.js'

/**
 * Claim and advance at most one recoverable Job.
 *
 * This module owns orchestration only. Wake delivery, lease claiming,
 * recovery/preparation, terminal projection, and step execution are delegated
 * to focused runtimes so new transitions do not regrow one monolithic tick.
 */
export async function runJobRuntimeTick(dependencies) {
  processJobRuntimeWakes(this, dependencies)
  const context = claimJobRuntimeTick(this, dependencies)
  if (!context) return false

  try {
    const prepared = await prepareClaimedJobTick(this, context, dependencies)
    if (prepared.handled) return true

    const currentSteps = dependencies.listJobSteps(context.job.id)
    const nextStep = dependencies.findNextRunnableStep(currentSteps)
    if (!nextStep) {
      return completeJobWithoutRunnableStep(this, context, currentSteps, dependencies)
    }
    if (!startRunnableJobStep(this, context, nextStep, dependencies)) return true

    return await runJobRuntimeStepExecution.call(this, {
      dependencies,
      job: context.job,
      nextStep,
      tickBudget: context.tickBudget,
      controller: context.controller,
      modelBinding: prepared.modelBinding,
      leaseScope: context.leaseScope,
      leaseIsOwned: context.leaseIsOwned,
      commitOwned: context.commitOwned,
    })
  } finally {
    context.release()
  }
}
