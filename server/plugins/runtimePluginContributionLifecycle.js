import { types as nodeTypes } from 'node:util'

const NativePromise = Promise
const NativeAggregateError = AggregateError
const nativePromiseThen = Promise.prototype.then
const nativeDefineProperty = Object.defineProperty
const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const nativeHasOwn = Object.hasOwn
const nativeFreeze = Object.freeze
const lifecycleErrors = new WeakSet()
const safePromiseSpeciesConstructor = Object.create(null)
nativeDefineProperty(safePromiseSpeciesConstructor, Symbol.species, {
  value: NativePromise,
  configurable: false,
  enumerable: false,
  writable: false,
})
nativeFreeze(safePromiseSpeciesConstructor)
const VISIBILITIES = new Set(['revoked', 'retained', 'indeterminate'])

function lifecycleError(code, message) {
  const error = new Error(message)
  error.code = code
  error.retryable = code !== 'PLUGIN_REVOKE_PROTOCOL_INVALID'
  lifecycleErrors.add(error)
  return error
}

function isolatedCleanupError(value, partId) {
  if (value && (typeof value === 'object' || typeof value === 'function') && lifecycleErrors.has(value)) {
    return value
  }
  let detail = ''
  if (typeof value === 'string') detail = value
  else if (value && (typeof value === 'object' || typeof value === 'function') && !nodeTypes.isProxy(value)) {
    try {
      const descriptor = nativeGetOwnPropertyDescriptor(value, 'message')
      if (descriptor && nativeHasOwn(descriptor, 'value') && typeof descriptor.value === 'string') {
        detail = descriptor.value
      }
    } catch {
      detail = ''
    }
  }
  const suffix = detail ? `: ${detail.slice(0, 500)}` : ''
  return lifecycleError(
    'PLUGIN_REVOKE_CLEANUP_FAILED',
    `plugin contribution cleanup failed: ${partId}${suffix}`,
  )
}

function callNativeThen(promise, onFulfilled, onRejected) {
  let previousConstructor
  try {
    previousConstructor = nativeGetOwnPropertyDescriptor(promise, 'constructor')
    if (previousConstructor && previousConstructor.configurable === false) {
      throw lifecycleError(
        'PLUGIN_REVOKE_PROTOCOL_INVALID',
        'revoke cleanup Promise has an unsafe constructor property',
      )
    }
    nativeDefineProperty(promise, 'constructor', {
      value: safePromiseSpeciesConstructor,
      configurable: true,
      enumerable: false,
      writable: false,
    })
    return nativePromiseThen.call(promise, onFulfilled, onRejected)
  } finally {
    if (previousConstructor) nativeDefineProperty(promise, 'constructor', previousConstructor)
    else {
      try { delete promise.constructor } catch { /* protocol validation reports the failure */ }
    }
  }
}

function chainNativePromise(promise, onFulfilled, onRejected) {
  return new NativePromise((resolve, reject) => {
    try {
      callNativeThen(
        promise,
        (value) => {
          try { resolve(onFulfilled ? onFulfilled(value) : value) } catch (error) { reject(error) }
        },
        (error) => {
          try {
            if (onRejected) resolve(onRejected(error))
            else reject(error)
          } catch (caught) {
            reject(caught)
          }
        },
      )
    } catch (error) {
      reject(error)
    }
  })
}

async function adoptNativePromise(promise) {
  return await promise
}

function settleNativePromises(promises) {
  return new NativePromise((resolve) => {
    if (promises.length === 0) {
      resolve([])
      return
    }
    const results = new Array(promises.length)
    let pending = promises.length
    const finish = (index, result) => {
      results[index] = result
      pending -= 1
      if (pending === 0) resolve(results)
    }
    promises.forEach((promise, index) => {
      try {
        callNativeThen(
          promise,
          (value) => finish(index, { status: 'fulfilled', value }),
          (reason) => finish(index, { status: 'rejected', reason }),
        )
      } catch (reason) {
        finish(index, { status: 'rejected', reason })
      }
    })
  })
}

function suppressNativeRejection(promise) {
  try { callNativeThen(promise, undefined, () => {}) } catch { /* caller still receives protocol failure */ }
}

function ownDataValue(target, key) {
  if ((typeof target !== 'object' && typeof target !== 'function') || target === null) {
    return { found: false, value: undefined }
  }
  if (nodeTypes.isProxy(target)) {
    throw lifecycleError('PLUGIN_REVOKE_PROTOCOL_INVALID', 'plugin revoke protocol cannot be a Proxy')
  }
  const descriptor = nativeGetOwnPropertyDescriptor(target, key)
  if (!descriptor) return { found: false, value: undefined }
  if (!nativeHasOwn(descriptor, 'value')) {
    throw lifecycleError(
      'PLUGIN_REVOKE_PROTOCOL_INVALID',
      `plugin revoke protocol field must be a data property: ${key}`,
    )
  }
  return { found: true, value: descriptor.value }
}

function snapshotReceipt(value) {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) {
    throw lifecycleError('PLUGIN_REVOKE_PROTOCOL_INVALID', 'beginRevoke must return a plain receipt')
  }
  const visibility = ownDataValue(value, 'visibility')
  if (!visibility.found || !VISIBILITIES.has(visibility.value)) {
    throw lifecycleError('PLUGIN_REVOKE_PROTOCOL_INVALID', 'revoke receipt visibility is invalid')
  }
  const cleanupField = ownDataValue(value, 'cleanup')
  const cleanup = cleanupField.found ? cleanupField.value : null
  if (cleanup !== null && cleanup !== undefined && !nodeTypes.isPromise(cleanup)) {
    throw lifecycleError(
      'PLUGIN_REVOKE_PROTOCOL_INVALID',
      'revoke receipt cleanup must be a native Promise or null',
    )
  }
  const observedCleanup = cleanup ? adoptNativePromise(cleanup) : null
  if (observedCleanup) suppressNativeRejection(observedCleanup)
  return nativeFreeze({
    visibility: visibility.value,
    cleanup: observedCleanup,
  })
}

function captureHandle(handle) {
  if (typeof handle !== 'function' || nodeTypes.isProxy(handle)) {
    throw lifecycleError('PLUGIN_REVOKE_HANDLE_INVALID', 'plugin contribution handle must be a function')
  }
  const explicit = ownDataValue(handle, 'beginRevoke')
  if (explicit.found && typeof explicit.value !== 'function') {
    throw lifecycleError('PLUGIN_REVOKE_PROTOCOL_INVALID', 'beginRevoke must be a function data property')
  }
  return nativeFreeze({
    dispose: handle,
    beginRevoke: explicit.found ? explicit.value : null,
  })
}

function normalizePart(part, index) {
  if (!part || typeof part !== 'object' || nodeTypes.isProxy(part)) {
    throw new TypeError('plugin contribution part must be a plain object')
  }
  const idField = ownDataValue(part, 'id')
  const handleField = ownDataValue(part, 'handle')
  const reactivateField = ownDataValue(part, 'reactivate')
  const id = typeof idField.value === 'string' ? idField.value.trim() : ''
  if (!id) throw new TypeError(`plugin contribution part id is required at index ${index}`)
  if (!handleField.found) throw new TypeError(`plugin contribution handle is required: ${id}`)
  if (reactivateField.found && typeof reactivateField.value !== 'function') {
    throw new TypeError(`plugin contribution reactivate must be a function: ${id}`)
  }
  return {
    id,
    handle: captureHandle(handleField.value),
    reactivate: reactivateField.found ? reactivateField.value : null,
    state: 'active',
    cleanupState: 'none',
    cleanupError: null,
    protocolError: null,
    attempts: 0,
  }
}

function aggregateVisibility(parts) {
  const states = new Set(parts.map((part) => part.state))
  if (states.size === 1) return states.values().next().value
  if (states.has('indeterminate')) return 'indeterminate'
  if (states.has('active') || states.has('reactivating')) return 'partial'
  if (states.has('revoked') && states.has('retained')) return 'partial'
  if (states.has('retired') && states.size === 1) return 'retired'
  return 'partial'
}

function publicPartSnapshot(part) {
  return nativeFreeze({
    id: part.id,
    state: part.state,
    cleanupState: part.cleanupState,
    attempts: part.attempts,
    errorCode: part.cleanupError?.code || part.protocolError?.code || null,
  })
}

function publicSnapshot(parts, retired) {
  return nativeFreeze({
    state: retired ? 'retired' : aggregateVisibility(parts),
    parts: Object.freeze(parts.map(publicPartSnapshot)),
  })
}

function prehandledRejection(error) {
  const promise = new NativePromise((_resolve, reject) => reject(error))
  suppressNativeRejection(promise)
  return promise
}

function beginLegacyRevoke(part) {
  let result
  try {
    result = part.handle.dispose()
  } catch (cause) {
    const error = lifecycleError(
      'PLUGIN_REVOKE_VISIBILITY_INDETERMINATE',
      `legacy contribution revoke threw before visibility was confirmed: ${part.id}`,
      cause,
    )
    part.protocolError = error
    return { visibility: 'indeterminate', cleanup: prehandledRejection(error) }
  }
  if (nodeTypes.isPromise(result)) {
    const error = lifecycleError(
      'PLUGIN_REVOKE_VISIBILITY_INDETERMINATE',
      `legacy async contribution revoke cannot prove visibility: ${part.id}`,
    )
    part.protocolError = error
    const observed = adoptNativePromise(result)
    suppressNativeRejection(observed)
    const cleanup = chainNativePromise(observed,
      () => { throw error },
      (cause) => {
        throw lifecycleError(
          'PLUGIN_REVOKE_CLEANUP_FAILED',
          `legacy async contribution revoke failed: ${part.id}`,
          cause,
        )
      },
    )
    suppressNativeRejection(cleanup)
    return { visibility: 'indeterminate', cleanup }
  }
  if (result && (typeof result === 'object' || typeof result === 'function')) {
    let thenField
    try {
      thenField = ownDataValue(result, 'then')
    } catch (cause) {
      const error = lifecycleError(
        'PLUGIN_REVOKE_PROTOCOL_INVALID',
        `legacy contribution returned an unsafe thenable: ${part.id}`,
        cause,
      )
      part.protocolError = error
      return { visibility: 'indeterminate', cleanup: prehandledRejection(error) }
    }
    if (thenField.found && typeof thenField.value === 'function') {
      const error = lifecycleError(
        'PLUGIN_REVOKE_PROTOCOL_INVALID',
        `legacy contribution returned a thenable instead of a v2 receipt: ${part.id}`,
      )
      part.protocolError = error
      return { visibility: 'indeterminate', cleanup: prehandledRejection(error) }
    }
  }
  const error = lifecycleError(
    'PLUGIN_REVOKE_PROTOCOL_REQUIRED',
    `legacy contribution revoke cannot prove visibility: ${part.id}`,
  )
  part.protocolError = error
  return { visibility: 'indeterminate', cleanup: prehandledRejection(error) }
}

function beginPartRevoke(part) {
  part.attempts += 1
  part.cleanupError = null
  part.protocolError = null
  if (!part.handle.beginRevoke) return beginLegacyRevoke(part)
  try {
    return snapshotReceipt(part.handle.beginRevoke())
  } catch (cause) {
    const error = cause && (typeof cause === 'object' || typeof cause === 'function')
      && lifecycleErrors.has(cause)
      ? cause
      : lifecycleError(
          'PLUGIN_REVOKE_VISIBILITY_INDETERMINATE',
          `contribution beginRevoke failed before visibility was confirmed: ${part.id}`,
          cause,
        )
    part.protocolError = error
    return { visibility: 'indeterminate', cleanup: prehandledRejection(error) }
  }
}

export function createRuntimePluginContributionLifecycle(inputParts) {
  if (!Array.isArray(inputParts) || inputParts.length === 0) {
    throw new TypeError('plugin contribution lifecycle requires at least one part')
  }
  const parts = inputParts.map(normalizePart)
  if (new Set(parts.map((part) => part.id)).size !== parts.length) {
    throw new TypeError('plugin contribution part ids must be unique')
  }
  let retired = false
  let activeCleanup = null

  const snapshot = () => publicSnapshot(parts, retired)

  const beginRevoke = () => {
    if (retired) {
      throw lifecycleError('PLUGIN_CONTRIBUTION_RETIRED', 'plugin contribution lifecycle is retired')
    }
    if (activeCleanup) return activeCleanup.receipt
    const attempted = []
    const cleanupTasks = []
    for (const part of [...parts].reverse()) {
      if (part.state === 'revoked' && part.cleanupState !== 'failed') continue
      if (!['active', 'retained', 'indeterminate', 'revoked'].includes(part.state)) continue
      const receipt = beginPartRevoke(part)
      part.state = receipt.visibility
      if (receipt.cleanup) {
        part.cleanupState = 'pending'
        const cleanup = chainNativePromise(receipt.cleanup,
          () => {
            part.cleanupState = 'succeeded'
            part.cleanupError = null
          },
          (error) => {
            part.cleanupState = 'failed'
            part.cleanupError = isolatedCleanupError(error, part.id)
            throw part.cleanupError
          },
        )
        suppressNativeRejection(cleanup)
        cleanupTasks.push(cleanup)
      } else {
        part.cleanupState = 'none'
      }
      attempted.push(part)
    }
    const visibility = aggregateVisibility(parts)
    const cleanupWork = chainNativePromise(settleNativePromises(cleanupTasks), (results) => {
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason)
      if (errors.length === 1) throw errors[0]
      if (errors.length > 1) {
        throw new NativeAggregateError(errors, 'plugin contribution cleanup failed')
      }
      return true
    })
    let cleanup
    cleanup = chainNativePromise(
      cleanupWork,
      (value) => {
        if (activeCleanup?.cleanup === cleanup) activeCleanup = null
        return value
      },
      (error) => {
        if (activeCleanup?.cleanup === cleanup) activeCleanup = null
        throw error
      },
    )
    suppressNativeRejection(cleanup)
    const receipt = nativeFreeze({
      visibility,
      cleanup,
      snapshot,
      attempted: nativeFreeze(attempted.map((part) => part.id)),
    })
    activeCleanup = { cleanup, receipt }
    return receipt
  }

  const reactivateRevoked = async () => {
    if (retired) throw lifecycleError('PLUGIN_CONTRIBUTION_RETIRED', 'plugin contribution lifecycle is retired')
    if (activeCleanup) await settleNativePromises([activeCleanup.cleanup])
    const unavailable = parts.filter((part) => part.state !== 'revoked')
    if (unavailable.length > 0) {
      throw lifecycleError(
        'PLUGIN_CONTRIBUTION_RESTORE_UNSAFE',
        `plugin contribution cannot be restored from ${aggregateVisibility(parts)} state`,
      )
    }
    const activated = []
    let reactivatingPart = null
    try {
      for (const part of parts) {
        if (!part.reactivate) {
          throw lifecycleError(
            'PLUGIN_CONTRIBUTION_RESTORE_UNAVAILABLE',
            `plugin contribution part cannot be restored: ${part.id}`,
          )
        }
        reactivatingPart = part
        part.state = 'reactivating'
        const handle = part.reactivate()
        part.handle = captureHandle(handle)
        part.state = 'active'
        part.cleanupState = 'none'
        part.cleanupError = null
        part.protocolError = null
        activated.push(part)
        reactivatingPart = null
      }
      return snapshot()
    } catch (error) {
      const rollbackParts = activated.map((part) => ({
        id: part.id,
        handle: part.handle.dispose,
        reactivate: part.reactivate,
      }))
      if (rollbackParts.length > 0) {
        const rollback = createRuntimePluginContributionLifecycle(rollbackParts).beginRevoke()
        try { await rollback.cleanup } catch { /* caller receives the activation failure */ }
        const rollbackStates = new Map(rollback.snapshot().parts.map((part) => [part.id, part.state]))
        for (const part of activated) part.state = rollbackStates.get(part.id) || 'indeterminate'
      }
      if (reactivatingPart) reactivatingPart.state = 'indeterminate'
      throw error
    }
  }

  const retire = () => {
    if (retired) return false
    if (activeCleanup) return false
    const safe = parts.every((part) => (
      part.state === 'revoked'
      && (part.cleanupState === 'none' || part.cleanupState === 'succeeded')
    ))
    if (!safe) return false
    retired = true
    for (const part of parts) {
      part.state = 'retired'
      part.handle = null
      part.reactivate = null
    }
    return true
  }

  return nativeFreeze({
    snapshot,
    beginRevoke,
    reactivateRevoked,
    retire,
  })
}

export function attachRuntimePluginBeginRevoke(dispose, beginRevoke) {
  if (typeof dispose !== 'function' || nodeTypes.isProxy(dispose)) {
    throw new TypeError('plugin contribution disposer must be a function')
  }
  if (typeof beginRevoke !== 'function' || nodeTypes.isProxy(beginRevoke)) {
    throw new TypeError('plugin contribution beginRevoke must be a function')
  }
  nativeDefineProperty(dispose, 'beginRevoke', {
    value: beginRevoke,
    configurable: false,
    enumerable: false,
    writable: false,
  })
  return dispose
}

export function createRuntimePluginRevokeReceipt(visibility, cleanup = null) {
  if (!VISIBILITIES.has(visibility)) {
    throw new TypeError('runtime plugin revoke receipt visibility is invalid')
  }
  if (cleanup !== null && !nodeTypes.isPromise(cleanup)) {
    throw new TypeError('runtime plugin revoke receipt cleanup must be a native Promise or null')
  }
  return nativeFreeze({ visibility, cleanup })
}
