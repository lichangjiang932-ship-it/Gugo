import { withLogContext } from '../../utils/logger.js'
import {
  configureSubagentLoopRunner,
  runSubagentBatch,
} from '../subagentRuntime.js'
import { registerSubagentBatchHandler } from '../subagentBatchBridge.js'
import { dispatchHooks } from '../hooksService.js'
import { createLoopContext } from './context.js'
import { createLoopEvents, LOOP_EVENT_NAMES } from './events.js'
import { installToolHookBridge } from './executeToolCalls.js'
import { runToolsLoopCore } from './runtime.js'

export async function runToolsLoop(options = {}) {
  const context = createLoopContext(options)
  const disposeHookBridge = installToolHookBridge({
    loopEvents: context.events,
    dispatchHooks,
    enabled: context.tools.enableHooks !== false,
    job: context.input.job,
    step: context.input.step,
  })
  try {
    return await runToolsLoopCore(context)
  } finally {
    disposeHookBridge()
  }
}

/** Public shared entry for job, turn, CLI, subagent, and embedded runtimes. */
export function runToolLoop(options = {}) {
  const context = createLoopContext(options)
  const job = context.input.job
  return withLogContext(
    { jobId: job?.id, userId: job?.userId, sessionId: job?.sessionId },
    () => runToolsLoop(context),
  )
}

configureSubagentLoopRunner(runToolLoop)
registerSubagentBatchHandler((options) => runSubagentBatch({
  ...options,
  runToolLoop,
}))

export function createToolLoop(options = {}) {
  const context = createLoopContext(options)
  const controller = {
    context,
    on: context.events.on,
    off: context.events.off,
    run(overrides = {}) {
      return runToolLoop(context.withOverrides(overrides))
    },
  }
  return Object.freeze(controller)
}

export { createLoopEvents, LOOP_EVENT_NAMES }
export { createLoopContext } from './context.js'
export { runPreStep } from './preStep.js'
export { runModelStep } from './step.js'
export { executeToolCall, runPostTool, runPreTool } from './executeToolCalls.js'
