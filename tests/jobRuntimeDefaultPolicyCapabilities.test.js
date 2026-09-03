import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultExecuteStep as createJobRuntimeExecuteStep } from '../server/services/jobRuntime.js'
import {
  createDefaultExecuteStep as createPolicyExecuteStep,
  createDefaultJobRuntimePolicyCapabilities,
} from '../server/services/jobRuntimeDefaultPolicyCapabilities.js'
import { createDefaultExecuteStep as createStepExecution } from '../server/services/jobStepExecutionRuntime.js'
import { resolveAgentModelRuntimeBinding } from '../server/services/modelReadinessService.js'
import { applyRuntimeTaskPlanGuard } from '../server/services/taskPlanGuard.js'

test('default job policy capabilities are isolated per runtime and frozen', () => {
  const first = createDefaultJobRuntimePolicyCapabilities()
  const second = createDefaultJobRuntimePolicyCapabilities()

  assert.equal(Object.isFrozen(first), true)
  assert.deepEqual(Object.keys(first), [
    'planner',
    'executeStep',
    'runtimeCore',
    'taskPlanGuard',
    'modelBindingResolver',
  ])
  assert.equal(typeof first.planner, 'function')
  assert.equal(typeof first.executeStep, 'function')
  assert.strictEqual(first.taskPlanGuard, applyRuntimeTaskPlanGuard)
  assert.strictEqual(first.modelBindingResolver, resolveAgentModelRuntimeBinding)
  assert.notStrictEqual(first.planner, second.planner)
  assert.notStrictEqual(first.runtimeCore, second.runtimeCore)
  assert.notEqual(first.runtimeCore.lease.ownerId, second.runtimeCore.lease.ownerId)
  assert.notStrictEqual(first.executeStep, second.executeStep)
})

test('default job runtime core uses the supplied execution lease coordinator', () => {
  const calls = []
  const executionLeases = {
    ownerId: 'job-runtime-test-owner',
    claim(jobId) {
      calls.push(['claim', jobId])
      return true
    },
    proof(jobId) {
      calls.push(['proof', jobId])
      return { ownerId: this.ownerId, fencingToken: 7 }
    },
    hold(jobId) {
      calls.push(['hold', jobId])
      return () => calls.push(['release', jobId])
    },
  }
  const capabilities = createDefaultJobRuntimePolicyCapabilities({
    executeStep: () => {},
    executionLeases,
  })

  assert.equal(capabilities.runtimeCore.lease.ownerId, executionLeases.ownerId)
  const lease = capabilities.runtimeCore.lease.acquire({ jobId: 'job-lease-test' })
  assert.deepEqual(lease.executionLease, {
    ownerId: executionLeases.ownerId,
    fencingToken: 7,
  })
  lease.release()
  assert.deepEqual(calls, [
    ['claim', 'job-lease-test'],
    ['proof', 'job-lease-test'],
    ['hold', 'job-lease-test'],
    ['release', 'job-lease-test'],
  ])
})

test('job runtime preserves the default step executor compatibility export identity', () => {
  assert.strictEqual(createJobRuntimeExecuteStep, createPolicyExecuteStep)
  assert.strictEqual(createPolicyExecuteStep, createStepExecution)
})

test('explicit job policy capability overrides retain their identities', () => {
  const planner = () => {}
  const executeStep = () => {}
  const runtimeCore = Object.freeze({ lease: Object.freeze({}) })
  const taskPlanGuard = () => {}
  const modelBindingResolver = () => {}
  const capabilities = createDefaultJobRuntimePolicyCapabilities({
    planner,
    executeStep,
    executionLeases: Object.freeze({}),
    runtimeCore,
    taskPlanGuard,
    modelBindingResolver,
  })

  assert.strictEqual(capabilities.planner, planner)
  assert.strictEqual(capabilities.executeStep, executeStep)
  assert.strictEqual(capabilities.runtimeCore, runtimeCore)
  assert.strictEqual(capabilities.taskPlanGuard, taskPlanGuard)
  assert.strictEqual(capabilities.modelBindingResolver, modelBindingResolver)
})
