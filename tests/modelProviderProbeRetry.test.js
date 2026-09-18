import assert from 'node:assert/strict'
import test from 'node:test'

import { runProviderDiagnosticSteps } from '../server/services/modelProviderDiagnosticService.js'

const PROVIDER = Object.freeze({
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: '',
  headers: {},
  models: ['demo-model'],
  defaultModel: 'demo-model',
})
const PROFILE = Object.freeze({ supportsTools: true })

function dependencies({ withTools, completion = async () => 'pong' } = {}) {
  return {
    getSystemDiagnostics: async () => ({ endpoint: { ok: true, remoteModels: ['demo-model'] } }),
    callBackgroundModel: completion,
    callBackgroundModelWithTools: withTools,
  }
}

function run(deps) {
  return runProviderDiagnosticSteps(
    { provider: PROVIDER, modelName: 'demo-model', userId: 'u1', testEnv: {}, profile: PROFILE },
    deps,
  )
}

const probeCall = {
  id: 'call-1',
  type: 'function',
  function: { name: 'gugo_provider_probe', arguments: '{"value":"ok"}' },
}

test('the tool probe retries once before declaring chat_only', async () => {
  let calls = 0
  const steps = await run(dependencies({
    withTools: async () => {
      calls += 1
      return calls === 1 ? { content: 'sure', toolCalls: [] } : { toolCalls: [probeCall] }
    },
  }))
  const toolStep = steps.find((step) => step.name === 'tools')
  assert.equal(toolStep.ok, true)
  assert.equal(toolStep.mode, 'agent')
  assert.equal(toolStep.retried, true)
  assert.equal(calls, 2)
})

test('the tool probe still fails chat_only after two misses', async () => {
  let calls = 0
  const steps = await run(dependencies({
    withTools: async () => { calls += 1; return { content: 'sure', toolCalls: [] } },
  }))
  const toolStep = steps.find((step) => step.name === 'tools')
  assert.equal(toolStep.ok, false)
  assert.equal(toolStep.advisory, true)
  assert.equal(toolStep.errorCode, 'PROVIDER_TOOL_CALL_MISSING')
  assert.equal(toolStep.mode, 'chat_only')
  assert.equal(calls, 2)
})

test('a malformed tool call is not retried', async () => {
  let calls = 0
  const steps = await run(dependencies({
    withTools: async () => {
      calls += 1
      return { toolCalls: [{ id: 'c', type: 'function', function: { name: 'gugo_provider_probe', arguments: '{"value":"nope"}' } }] }
    },
  }))
  const toolStep = steps.find((step) => step.name === 'tools')
  assert.equal(toolStep.ok, false)
  assert.equal(toolStep.errorCode, 'PROVIDER_TOOL_ARGUMENTS_INVALID')
  assert.equal(calls, 1, 'a well-formed but wrong call is a real failure, not a flake')
})

test('a tools-disabled profile reports disabled without probing', async () => {
  let calls = 0
  const steps = await runProviderDiagnosticSteps(
    { provider: PROVIDER, modelName: 'demo-model', userId: 'u1', testEnv: {}, profile: { supportsTools: false } },
    dependencies({ withTools: async () => { calls += 1; return {} } }),
  )
  const toolStep = steps.find((step) => step.name === 'tools')
  assert.equal(toolStep.ok, false)
  assert.equal(toolStep.errorCode, 'PROVIDER_TOOLS_DISABLED')
  assert.equal(calls, 0)
})
