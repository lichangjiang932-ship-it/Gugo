import { createLoopEvents } from './events.js'

const LOOP_CONTEXT = Symbol('gugo.loopContext')
const loopContextSources = new WeakMap()
const externalAbortSignals = new WeakSet()

const EXTERNAL_TOOL_EXECUTION_DENIAL = Object.freeze({
  ok: false,
  denied: true,
  policyDenied: true,
  code: 'tool_execution_broker_required',
  error: 'This tool loop adapter cannot execute tools because no host-enforced execution broker is available.',
  retryable: false,
  recoverable: false,
})

async function denyExternalToolExecution() {
  return EXTERNAL_TOOL_EXECUTION_DENIAL
}

async function denyExternalModelRequest() {
  const error = new Error(
    'This tool loop adapter cannot call a model because no host-enforced model broker is available.',
  )
  error.code = 'model_execution_broker_required'
  error.retryable = false
  throw error
}

function deepFreezeSnapshot(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || seen.has(value)) {
    return value
  }
  seen.add(value)
  for (const nested of Object.values(value)) deepFreezeSnapshot(nested, seen)
  return Object.freeze(value)
}

function rejectSharedMemory(value, label, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  const sharedMemoryAvailable = typeof SharedArrayBuffer === 'function'
  if (sharedMemoryAvailable && value instanceof SharedArrayBuffer) {
    const error = new TypeError(`External tool loop adapter ${label} cannot contain shared memory`)
    error.code = 'LOOP_ADAPTER_SHARED_MEMORY_FORBIDDEN'
    throw error
  }
  if (ArrayBuffer.isView(value)
    && sharedMemoryAvailable
    && value.buffer instanceof SharedArrayBuffer) {
    const error = new TypeError(`External tool loop adapter ${label} cannot contain shared memory`)
    error.code = 'LOOP_ADAPTER_SHARED_MEMORY_FORBIDDEN'
    throw error
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return
  for (const nested of Object.values(value)) rejectSharedMemory(nested, label, seen)
}

function snapshotExternalData(value, label) {
  if (value === undefined || value === null) return value
  try {
    rejectSharedMemory(value, label)
    return deepFreezeSnapshot(structuredClone(value))
  } catch (cause) {
    if (cause?.code === 'LOOP_ADAPTER_SHARED_MEMORY_FORBIDDEN') throw cause
    const error = new TypeError(`External tool loop adapter ${label} must be cloneable data`, { cause })
    error.code = 'LOOP_ADAPTER_CONTEXT_UNCLONEABLE'
    throw error
  }
}

function deriveExternalAbortSignal(signal) {
  if (!signal || typeof signal.addEventListener !== 'function') return signal
  if (externalAbortSignals.has(signal)) return signal
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal.reason)
  if (signal.aborted) forwardAbort()
  else signal.addEventListener('abort', forwardAbort, { once: true })
  externalAbortSignals.add(controller.signal)
  return controller.signal
}

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
function buildLoopContext(inputOptions = {}, {
  externalAdapter = false,
  harness = undefined,
} = {}) {
  if (isLoopContext(inputOptions)) return inputOptions
  assertOptions(inputOptions)
  const events = resolveEvents(inputOptions)
  const options = externalAdapter
    ? {
        ...inputOptions,
        job: snapshotExternalData(inputOptions.job, 'job'),
        step: snapshotExternalData(inputOptions.step, 'step'),
        messages: snapshotExternalData(inputOptions.messages, 'messages'),
        signal: deriveExternalAbortSignal(inputOptions.signal),
        toolSpecs: snapshotExternalData(inputOptions.toolSpecs, 'toolSpecs'),
        fallbackToolSpecs: snapshotExternalData(inputOptions.fallbackToolSpecs, 'fallbackToolSpecs'),
        toolsConfig: snapshotExternalData(inputOptions.toolsConfig, 'toolsConfig'),
        toolResolutionDecision: snapshotExternalData(
          inputOptions.toolResolutionDecision,
          'toolResolutionDecision',
        ),
        runModel: denyExternalModelRequest,
        reconcileModelRequest: undefined,
        compactionArchivePort: undefined,
        onModelPhase: undefined,
        onModelDelta: undefined,
        onReasoningDelta: undefined,
        executeTool: denyExternalToolExecution,
        sideEffectLedger: undefined,
        onProgress: undefined,
        onToolCall: undefined,
        onToolStarted: undefined,
        onToolCompleted: undefined,
        onApprovalPending: undefined,
        onApprovalResolved: undefined,
        requestToolApproval: undefined,
        approvalPrincipal: undefined,
        approvalContext: undefined,
        loadCheckpoint: undefined,
        saveCheckpoint: undefined,
        claimSteering: undefined,
        acknowledgeSteering: undefined,
        releaseSteering: undefined,
        beforeFinalCompletion: undefined,
        runtimeBudget: undefined,
        loopEvents: events,
      }
    : { ...inputOptions, loopEvents: events }
  const source = options
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
      reconcileRequest: options.reconcileModelRequest,
      compactionArchivePort: options.compactionArchivePort,
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
      sideEffectLedger: options.sideEffectLedger,
    }),
    approvals: Object.freeze({
      onPending: options.onApprovalPending,
      onResolved: options.onApprovalResolved,
      origin: options.approvalOrigin,
      sessionId: options.approvalSessionId,
      mode: options.approvalMode,
      context: options.approvalContext,
      request: options.requestToolApproval,
      principal: options.approvalPrincipal,
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
    ...(externalAdapter && harness !== undefined ? { harness } : {}),
    events,
    withOverrides(overrides = {}) {
      assertOptions(overrides)
      return buildLoopContext({
        ...source,
        ...overrides,
        ...(externalAdapter
          ? {
              job: source.job,
              step: source.step,
              signal: source.signal,
              loopEvents: events,
            }
          : { loopEvents: overrides.loopEvents || overrides.events || events }),
      }, { externalAdapter, harness })
    },
  }
  const frozen = Object.freeze(context)
  loopContextSources.set(frozen, source)
  return frozen
}

export function createLoopContext(options = {}) {
  return buildLoopContext(options)
}

/**
 * Remove every host authority that would let a third-party Loop adapter skip
 * the canonical approval/checkpoint/side-effect pipeline. The public execute
 * method stays shape-compatible with contract v1 but fails closed until the
 * host can supply a complete execution broker.
 */
export function createExternalToolLoopContext(context, { harness } = {}) {
  if (!isLoopContext(context)) {
    throw new TypeError('Loop context is required')
  }
  const source = loopContextSources.get(context)
  if (!source) {
    throw new TypeError('Loop context source is unavailable')
  }
  return buildLoopContext({
    ...source,
    events: undefined,
    loopEvents: createLoopEvents(),
  }, { externalAdapter: true, harness })
}
