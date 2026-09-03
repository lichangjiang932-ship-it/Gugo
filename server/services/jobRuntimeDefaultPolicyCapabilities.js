import { applyRuntimeTaskPlanGuard } from './taskPlanGuard.js'
import { createJobExecutionLeaseCoordinator } from './jobExecutionLeaseRuntime.js'
import { createDefaultJobPlanner } from './jobRuntimeDefaultPlanner.js'
import { createDefaultExecuteStep } from './jobStepExecutionRuntime.js'
import { resolveAgentModelRuntimeBinding } from './modelReadinessService.js'
import { createJobRuntimeCore } from './runtimeCore.js'

export { createDefaultExecuteStep }

export function createDefaultJobRuntimePolicyCapabilities({
  planner = createDefaultJobPlanner(),
  executeStep = null,
  executionLeases = createJobExecutionLeaseCoordinator(),
  runtimeCore = null,
  taskPlanGuard = applyRuntimeTaskPlanGuard,
  modelBindingResolver = resolveAgentModelRuntimeBinding,
} = {}) {
  const resolvedRuntimeCore = runtimeCore || createJobRuntimeCore({ executionLeases })

  return Object.freeze({
    planner,
    executeStep: executeStep || createDefaultExecuteStep({ runtimeCore: resolvedRuntimeCore }),
    runtimeCore: resolvedRuntimeCore,
    taskPlanGuard,
    modelBindingResolver,
  })
}
