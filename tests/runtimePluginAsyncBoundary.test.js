import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createHandledRejectedPromise,
} from '../server/plugins/runtimePluginAsyncBoundary.js'

const HostPromise = Promise

async function observeRejection(promise) {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

test('prehandled lifecycle rejections preserve the original reason for every observer', async () => {
  const reason = new Error('guard rejection identity')
  const rejection = createHandledRejectedPromise(reason)

  assert.equal(Object.hasOwn(rejection, 'constructor'), false)
  const [first, second] = await HostPromise.all([
    observeRejection(rejection),
    observeRejection(rejection),
  ])
  assert.equal(first, reason)
  assert.equal(second, reason)
})

test('prehandling is immune to same-realm Promise intrinsic surface tampering', async () => {
  const reason = new Error('guard rejection under poisoned Promise surfaces')
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  const globalPromiseDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Promise')
  const rejectDescriptor = Object.getOwnPropertyDescriptor(HostPromise, 'reject')
  const speciesDescriptor = Object.getOwnPropertyDescriptor(HostPromise, Symbol.species)
  const thenDescriptor = Object.getOwnPropertyDescriptor(HostPromise.prototype, 'then')
  const constructorDescriptor = Object.getOwnPropertyDescriptor(
    HostPromise.prototype,
    'constructor',
  )
  let observed

  process.on('unhandledRejection', onUnhandled)
  try {
    Object.defineProperty(globalThis, 'Promise', {
      ...globalPromiseDescriptor,
      value: function PoisonedGlobalPromise() {
        throw new Error('poisoned global Promise constructor')
      },
    })
    Object.defineProperty(HostPromise, 'reject', {
      ...rejectDescriptor,
      value() {
        throw new Error('poisoned Promise.reject')
      },
    })
    Object.defineProperty(HostPromise, Symbol.species, {
      configurable: true,
      get() {
        throw new Error('poisoned Promise species')
      },
    })
    Object.defineProperty(HostPromise.prototype, 'then', {
      ...thenDescriptor,
      value() {
        throw new Error('poisoned Promise.prototype.then')
      },
    })
    Object.defineProperty(HostPromise.prototype, 'constructor', {
      ...constructorDescriptor,
      value: function PoisonedPromiseConstructor() {
        throw new Error('poisoned Promise.prototype.constructor')
      },
    })

    void createHandledRejectedPromise(reason)
    observed = createHandledRejectedPromise(reason)
    assert.equal(observed instanceof HostPromise, true)
    assert.equal(Object.hasOwn(observed, 'constructor'), false)
  } finally {
    Object.defineProperty(globalThis, 'Promise', globalPromiseDescriptor)
    Object.defineProperty(HostPromise, 'reject', rejectDescriptor)
    Object.defineProperty(HostPromise, Symbol.species, speciesDescriptor)
    Object.defineProperty(HostPromise.prototype, 'then', thenDescriptor)
    Object.defineProperty(HostPromise.prototype, 'constructor', constructorDescriptor)
  }

  assert.equal(await observeRejection(observed), reason)
  await new HostPromise((resolve) => setImmediate(resolve))
  await new HostPromise((resolve) => setImmediate(resolve))
  process.off('unhandledRejection', onUnhandled)
  assert.deepEqual(unhandled, [])
})
