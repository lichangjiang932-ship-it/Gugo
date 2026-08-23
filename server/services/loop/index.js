import { withLogContext } from '../../utils/logger.js'
import {
  configureSubagentLoopRunner,
  runSubagentBatch,
} from '../subagentRuntime.js'
import { registerSubagentBatchHandler } from '../subagentBatchBridge.js'
import { dispatchHooks } from '../hooksService.js'
import { bindRuntimePluginsToLoop } from '../../plugins/pluginRegistry.js'
import { createExternalToolLoopContext, createLoopContext } from './context.js'
import { createLoopEvents, LOOP_EVENT_NAMES } from './events.js'
import { installToolHookBridge } from './executeToolCalls.js'
import {
  TOOL_LOOP_ADAPTER_BROKER_VERSION,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
  acquireToolLoopAdapterForRun,
  isBuiltinToolLoopAdapter,
  normalizeToolLoopModelResponse,
  sanitizeExternalToolLoopResult,
} from '../../core/toolLoopAdapter.js'
import { createLoopHarnessSession } from '../../core/loopHarnessSession.js'
import { configureTurnLoopRunner } from '../turnLoopBindingRuntime.js'

let canonicalHarnessModulesPromise = null

function createHarnessMetadata(binding) {
  return {
    adapterId: binding.adapterId,
    owner: binding.owner,
    version: binding.version,
    revision: binding.revision,
    releaseDigest: binding.releaseDigest,
    contractVersion: binding.contractVersion,
    brokerVersion: binding.brokerVersion,
    source: binding.source,
    generation: binding.generation,
  }
}

function supportsHarnessBroker(loopLease) {
  const binding = loopLease.binding
  return binding.contractVersion === TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3
    && binding.brokerVersion === TOOL_LOOP_ADAPTER_BROKER_VERSION
}

function createHarnessForLease(loopLease, brokers = {}) {
  if (!supportsHarnessBroker(loopLease)) return undefined
  const binding = loopLease.binding
  return createLoopHarnessSession({
    lease: loopLease,
    metadata: createHarnessMetadata(binding),
    brokers,
  })
}

async function loadCanonicalHarnessModules() {
  canonicalHarnessModulesPromise ||= Promise.all([
    import('./runtime.js'),
    import('./canonicalHarnessModelBroker.js'),
  ])
  return canonicalHarnessModulesPromise
}

async function prepareHarnessRuntime(context, loopLease) {
  if (!supportsHarnessBroker(loopLease)) {
    return Object.freeze({ harness: undefined, lifecycle: null, terminal: null })
  }
  // Keep the historical fail-closed surface when the caller has not installed
  // a model execution bridge. A Session still exists, but it has no broker.
  if (typeof context.model.run !== 'function') {
    return Object.freeze({
      harness: createHarnessForLease(loopLease),
      lifecycle: null,
      terminal: null,
    })
  }

  const [runtimeModule, brokerModule] = await loadCanonicalHarnessModules()
  const prepared = await runtimeModule.prepareToolsLoopRuntime(context)
  const terminal = runtimeModule.consumePreparedToolsLoopTerminalOutcome(prepared)
  if (terminal.terminal) {
    return Object.freeze({ harness: undefined, lifecycle: null, terminal: terminal.value })
  }
  const lifecycle = brokerModule.createCanonicalHarnessModelBroker(prepared)
  return Object.freeze({
    harness: createHarnessForLease(loopLease, { modelRequest: lifecycle.modelRequest }),
    lifecycle,
    terminal: null,
  })
}

function guardModelBoundary(context) {
  if (typeof context.model.run !== 'function') return context
  const runModel = context.model.run
  return context.withOverrides({
    runModel: async (request) => normalizeToolLoopModelResponse(await runModel(request)),
  })
}

export async function runToolsLoop(options = {}) {
  const context = guardModelBoundary(createLoopContext(options))
  const loopLease = acquireToolLoopAdapterForRun()
  let disposeRuntimePlugins = () => {}
  let disposeHookBridge = () => {}
  try {
    const builtinAdapter = isBuiltinToolLoopAdapter(loopLease.adapter)
    if (builtinAdapter) {
      disposeRuntimePlugins = bindRuntimePluginsToLoop(context.events)
      disposeHookBridge = installToolHookBridge({
        loopEvents: context.events,
        dispatchHooks,
        enabled: context.tools.enableHooks !== false,
        job: context.input.job,
        step: context.input.step,
        approvalOrigin: context.approvals.origin === undefined ? 'job' : context.approvals.origin,
        approvalSessionId: context.approvals.sessionId || null,
      })
    }
    const harnessRuntime = builtinAdapter
      ? Object.freeze({ harness: undefined, lifecycle: null, terminal: null })
      : await prepareHarnessRuntime(context, loopLease)
    if (harnessRuntime.terminal) return harnessRuntime.terminal
    const adapterContext = builtinAdapter
      ? context
      : createExternalToolLoopContext(context, { harness: harnessRuntime.harness })
    try {
      const result = await loopLease.adapter.run(adapterContext)
      if (builtinAdapter) return result
      const sanitized = sanitizeExternalToolLoopResult(result)
      return harnessRuntime.lifecycle
        ? await harnessRuntime.lifecycle.finalize(sanitized)
        : sanitized
    } catch (error) {
      if (harnessRuntime.lifecycle) {
        try {
          await harnessRuntime.lifecycle.abort()
        } catch {
          // Preserve the primary adapter/model/finalization failure. The tracked
          // model path has already persisted its authoritative replay fence.
        }
      }
      throw error
    }
  } finally {
    try {
      disposeHookBridge()
    } finally {
      try {
        disposeRuntimePlugins()
      } finally {
        loopLease.release()
      }
    }
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
configureTurnLoopRunner(runToolLoop)
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
export { runPostTool, runPreTool } from './executeToolCalls.js'
