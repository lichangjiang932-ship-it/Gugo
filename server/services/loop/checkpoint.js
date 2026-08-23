export const CHECKPOINT_FLUSH_ERROR_CODE = 'CHECKPOINT_FLUSH_FAILED'

const CHECKPOINT_FLUSH_ERROR_MESSAGE = 'Checkpoint flush failed before side effect'

export class CheckpointFlushError extends Error {
  constructor(message = CHECKPOINT_FLUSH_ERROR_MESSAGE, { cause, meta } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CheckpointFlushError'
    this.code = CHECKPOINT_FLUSH_ERROR_CODE
    this.retryable = true
    if (meta !== undefined) this.meta = meta
  }
}

function assertSaveCheckpoint(saveCheckpoint) {
  if (saveCheckpoint != null && typeof saveCheckpoint !== 'function') {
    throw new TypeError('saveCheckpoint must be a function, null, or undefined')
  }
}

function assertStateFactory(stateFactory) {
  if (stateFactory != null && typeof stateFactory !== 'function') {
    throw new TypeError('stateFactory must be a function, null, or undefined')
  }
}

function assertMeta(meta) {
  if (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) {
    throw new TypeError('checkpoint meta must be an object, null, or undefined')
  }
}

function assertWriteSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('initialWriteSequence must be a non-negative safe integer')
  }
}

function mergeMeta(baseMeta, flushMeta) {
  assertMeta(baseMeta)
  assertMeta(flushMeta)
  if (baseMeta == null) return flushMeta ?? undefined
  if (flushMeta == null) return baseMeta
  return { ...baseMeta, ...flushMeta }
}

function checkpointError(cause, meta) {
  if (cause instanceof CheckpointFlushError) return cause
  return new CheckpointFlushError(CHECKPOINT_FLUSH_ERROR_MESSAGE, { cause, meta })
}

async function resolveState({ state, hasState, stateFactory, meta }) {
  if (hasState) return state
  return stateFactory == null ? undefined : stateFactory(meta)
}

/**
 * Flush a single checkpoint before a model or tool side effect. When no
 * checkpoint store is configured this is intentionally a no-op, preserving
 * lightweight embedded and test callers.
 */
export async function flushCheckpoint(options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('checkpoint flush options must be an object')
  }

  const {
    saveCheckpoint = null,
    state,
    stateFactory = null,
    meta,
  } = options
  assertSaveCheckpoint(saveCheckpoint)
  assertStateFactory(stateFactory)
  assertMeta(meta)

  if (saveCheckpoint == null) return undefined

  try {
    const checkpointState = await resolveState({
      state,
      hasState: Object.hasOwn(options, 'state'),
      stateFactory,
      meta,
    })
    const saved = await saveCheckpoint(checkpointState, meta)
    if (saved === false || saved === null) {
      throw new CheckpointFlushError(CHECKPOINT_FLUSH_ERROR_MESSAGE, { meta })
    }
    return saved
  } catch (cause) {
    throw checkpointError(cause, meta)
  }
}

/**
 * Build a reusable fail-closed barrier. Every call takes a fresh state
 * snapshot and waits for it to persist before the caller may perform its
 * side effect.
 */
export function createCheckpointBarrier({
  saveCheckpoint = null,
  stateFactory = null,
  meta: baseMeta,
  initialWriteSequence = 0,
} = {}) {
  assertSaveCheckpoint(saveCheckpoint)
  assertStateFactory(stateFactory)
  assertMeta(baseMeta)
  assertWriteSequence(initialWriteSequence)

  const enabled = saveCheckpoint != null
  let latestWriteSequence = initialWriteSequence

  const flush = async (overrides = {}) => {
    if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new TypeError('checkpoint flush overrides must be an object')
    }

    const overrideFactory = Object.hasOwn(overrides, 'stateFactory')
      ? overrides.stateFactory
      : stateFactory
    const mergedMeta = mergeMeta(baseMeta, overrides.meta)
    const meta = enabled ? { ...(mergedMeta || {}) } : mergedMeta
    if (enabled) {
      Object.defineProperty(meta, 'checkpointWriteSequence', {
        value: ++latestWriteSequence,
        enumerable: false,
        configurable: false,
        writable: false,
      })
    }
    const options = {
      saveCheckpoint,
      stateFactory: overrideFactory,
      meta,
    }
    if (Object.hasOwn(overrides, 'state')) options.state = overrides.state

    return flushCheckpoint(options)
  }

  return Object.freeze({
    enabled,
    flush,
    beforeSideEffect: flush,
    get latestWriteSequence() {
      return latestWriteSequence
    },
  })
}
