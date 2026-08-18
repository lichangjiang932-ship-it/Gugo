import { createLoopEvents } from './events.js'

const LOOP_CONTEXT = Symbol('gugo.loopContext')

function assertOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Loop options must be an object')
  }
}

function isEventBus(value) {
  return value
    && typeof value.on === 'function'
    && typeof value.off === 'function'
    && typeof value.waterfall === 'function'
    && typeof value.serial === 'function'
}

function resolveEvents(options) {
  const supplied = options.loopEvents || options.events
  if (supplied != null && !isEventBus(supplied)) {
    throw new TypeError('loopEvents must be a loop event bus')
  }
  return supplied || createLoopEvents()
}

export function isLoopContext(value) {
  return Boolean(value?.[LOOP_CONTEXT])
}

/**
 * Group the loop's injected dependencies by responsibility. The runtime core
 * receives this one contract instead of a forty-property function signature.
 */
export function createLoopContext(options = {}) {
  if (isLoopContext(options)) return options
  assertOptions(options)
  const events = resolveEvents(options)
  const source = { ...options, loopEvents: events }
  const context = {
    [LOOP_CONTEXT]: true,
    input: Object.freeze({
      job: options.job,
      step: options.step,
      messages: options.messages,
      signal: options.signal,
    }),
    model: Object.freeze({
      run: options.runModel,
      contextWindow: options.contextWindow,
      heartbeatIntervalMs: options.modelHeartbeatIntervalMs,
      onPhase: options.onModelPhase,
      onDelta: options.onModelDelta,
      onReasoningDelta: options.onReasoningDelta,
    }),
    tools: Object.freeze({
      execute: options.executeTool,
      specs: options.toolSpecs,
      fallbackSpecs: options.fallbackToolSpecs,
      config: options.toolsConfig,
      resolutionDecision: options.toolResolutionDecision,
      retryMaxAttempts: options.toolRetryMaxAttempts,
      retryBaseDelayMs: options.toolRetryBaseDelayMs,
      enableHooks: options.enableToolHooks,
      onProgress: options.onProgress,
      onCall: options.onToolCall,
      onStarted: options.onToolStarted,
      onCompleted: options.onToolCompleted,
    }),
    approvals: Object.freeze({
      onPending: options.onApprovalPending,
      onResolved: options.onApprovalResolved,
      origin: options.approvalOrigin,
      sessionId: options.approvalSessionId,
      mode: options.approvalMode,
      context: options.approvalContext,
      request: options.requestToolApproval,
    }),
    steering: Object.freeze({
      claim: options.claimSteering,
      acknowledge: options.acknowledgeSteering,
      release: options.releaseSteering,
      beforeFinalCompletion: options.beforeFinalCompletion,
    }),
    checkpoint: Object.freeze({
      load: options.loadCheckpoint,
      save: options.saveCheckpoint,
    }),
    limits: Object.freeze({
      maxIterations: options.maxIters,
      runtimeBudget: options.runtimeBudget,
      executionGuardMode: options.executionGuardMode,
      intentMode: options.intentMode,
    }),
    artifact: Object.freeze({ skillId: options.skillId }),
    events,
    withOverrides(overrides = {}) {
      assertOptions(overrides)
      return createLoopContext({
        ...source,
        ...overrides,
        loopEvents: overrides.loopEvents || overrides.events || events,
      })
    },
  }
  return Object.freeze(context)
}
