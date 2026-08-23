import { types as nodeTypes } from 'node:util'

const NativePromise = Promise
const nativePromiseThen = Promise.prototype.then
const nativeDefineProperty = Object.defineProperty
const safePromiseSpeciesConstructor = Object.create(null)
nativeDefineProperty(safePromiseSpeciesConstructor, Symbol.species, {
  value: NativePromise,
  configurable: false,
  enumerable: false,
  writable: false,
})
Object.freeze(safePromiseSpeciesConstructor)

function loopEventBusError(method) {
  const error = new TypeError(`loop event bus.${method} must be an own function property`)
  error.code = 'PLUGIN_LOOP_EVENT_BUS_INVALID'
  error.retryable = false
  return error
}

export function pluginAsyncResultKind(result) {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return null
  if (nodeTypes.isPromise(result)) return 'promise'
  const descriptor = Object.getOwnPropertyDescriptor(result, 'then')
  if (!descriptor) return null
  if (!Object.hasOwn(descriptor, 'value')) return 'thenable'
  return typeof descriptor.value === 'function' ? 'thenable' : null
}

export function suppressNativePromiseRejection(promise) {
  try {
    nativePromiseThen.call(promise, undefined, () => {})
  } catch {
    // Async plugin results are rejected regardless of rejection-handler attachment.
  }
}

export function createHandledRejectedPromise(error) {
  // Do not call Promise.reject here: same-realm plugin code can replace that
  // mutable static method. Give the intrinsic `then` a private, immutable
  // species only while attaching the rejection handler so mutations to
  // Promise.prototype.constructor or Promise[Symbol.species] cannot prevent
  // Node from marking the rejection as handled. The temporary own property is
  // removed before the original promise crosses the host boundary.
  const rejection = new NativePromise((_resolve, reject) => reject(error))
  nativeDefineProperty(rejection, 'constructor', {
    value: safePromiseSpeciesConstructor,
    configurable: true,
    enumerable: false,
    writable: false,
  })
  try {
    nativePromiseThen.call(rejection, undefined, () => {})
  } finally {
    delete rejection.constructor
  }
  return rejection
}

export function assertLoopCleanupSynchronous(result) {
  const asyncResultKind = nodeTypes.isProxy(result) ? 'thenable' : pluginAsyncResultKind(result)
  if (!asyncResultKind) return
  if (asyncResultKind === 'promise') suppressNativePromiseRejection(result)
  const error = new TypeError('loop event cleanup must be synchronous')
  error.code = 'PLUGIN_LOOP_EVENT_CLEANUP_ASYNC_UNSUPPORTED'
  error.retryable = false
  throw error
}

export function snapshotLoopEventBus(events) {
  if (!events || (typeof events !== 'object' && typeof events !== 'function')) {
    throw loopEventBusError('on')
  }
  const methods = {}
  for (const method of ['on', 'off']) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(events, method)
    } catch {
      throw loopEventBusError(method)
    }
    if (!descriptor
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function') {
      throw loopEventBusError(method)
    }
    const callback = descriptor.value
    methods[method] = (...args) => callback.call(events, ...args)
  }
  return Object.freeze(methods)
}
