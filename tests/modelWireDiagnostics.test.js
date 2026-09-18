import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { getModelWireDiagnostics, describeModelWireRequest } from '../server/adapters/modelWireDiagnostics.js'
import { emitWirePreparation } from '../server/services/loop/runtimeContextDiagnostics.js'

const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const config = { modelName: 'fixture-model', baseUrl: 'https://endpoint.invalid/v1', apiKey: 'PRIVATE_KEY', providerId: 'fixture-provider', configRevision: 3 }
const tools = [{ type: 'function', function: { name: 'fixture_tool', parameters: { type: 'object' } } }]
const messages = [{ role: 'system', content: 'PRIVATE_PREFIX', __gugoPromptStability: 'stable' }, { role: 'user', content: 'PRIVATE_USER' }]
const profile = { kind: 'openai-compatible', supportsTools: true, supportsStreaming: true }

test('wire fingerprints derive from the actual adapted body and never add provider metadata', () => {
  const request = buildModelProviderRequest({ config, profile, messages, tools, cacheOwnerId: 'alice' })
  const observation = getModelWireDiagnostics(request)
  assert.equal(observation.stage, 'wire')
  assert.equal(observation.available, true)
  assert.equal(observation.bodyFingerprint, digest(`gugo:wire:v1:body:${observation.ownerScopeFingerprint}\0${request.init.body}`))
  const body = JSON.parse(request.init.body)
  assert.equal(observation.prefixFingerprint, digest(`gugo:wire:v1:prefix:${observation.ownerScopeFingerprint}\0${JSON.stringify(body.messages.slice(0, 1))}`))
  assert.equal(observation.toolsFingerprint, digest(`gugo:wire:v1:tools:${observation.ownerScopeFingerprint}\0${JSON.stringify(body.tools)}`))
  assert.doesNotMatch(request.init.body, /wireDiagnostics|ownerScopeFingerprint|bodyFingerprint/u)
  assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_|endpoint\.invalid|fixture-model|alice/u)
})

test('owner isolation and endpoint/model/config changes prevent unsafe comparisons', () => {
  const create = (owner, nextConfig = config) => getModelWireDiagnostics(buildModelProviderRequest({ config: nextConfig, profile, messages, tools, cacheOwnerId: owner }))
  const first = create('alice')
  assert.notEqual(create('bob').ownerScopeFingerprint, first.ownerScopeFingerprint)
  assert.notEqual(create('bob').bodyFingerprint, first.bodyFingerprint)
  assert.notEqual(create('alice', { ...config, modelName: 'another-model' }).modelFingerprint, first.modelFingerprint)
  assert.notEqual(create('alice', { ...config, configRevision: 4 }).configFingerprint, first.configFingerprint)
  assert.equal(create(null).identityComparable, false)
})

test('credential changes never become endpoint/config fingerprint input', () => {
  const create = (key) => describeModelWireRequest({
    providerRequest: { url: `https://name:${key}@endpoint.invalid/v1/chat/completions?api_key=${key}`, init: { body: '{"model":"fixture","messages":[]}' } },
    config: { ...config, apiKey: key, headers: { Authorization: `Bearer ${key}` } }, profile, ownerId: 'alice',
  })
  const first = create('PRIVATE_ONE')
  const second = create('PRIVATE_TWO')
  assert.equal(first.endpointFingerprint, second.endpointFingerprint)
  assert.equal(first.configFingerprint, second.configFingerprint)
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|endpoint\.invalid|name/u)
})

test('oversized diagnostic bodies stay untouched and report unavailable/truncated', () => {
  const body = JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] })
  const request = { url: config.baseUrl, init: { body } }
  const observation = describeModelWireRequest({ providerRequest: request, config, profile, ownerId: 'alice' })
  assert.equal(observation.available, false)
  assert.equal(observation.truncated, true)
  assert.equal(observation.bodyFingerprint, null)
  assert.equal(request.init.body, body)
})

test('wire comparison is local to one state and only compares identical non-secret owner/endpoint/model/config scopes', async () => {
  const phases = []
  const state = { iter: 0, onModelPhase: async (value) => phases.push(value) }
  const create = (owner = 'alice', nextMessages = messages, nextConfig = config) => getModelWireDiagnostics(buildModelProviderRequest({
    config: nextConfig, profile, messages: nextMessages, tools, cacheOwnerId: owner,
  }))
  const emit = (wireDiagnostics) => emitWirePreparation(state, { wireDiagnostics, modelRequestId: 'comparison', physicalAttempt: phases.length + 1 })
  await emit(create())
  await emit(create('alice', [...messages, { role: 'assistant', content: 'another response' }]))
  assert.equal(phases[0].wireDiagnostics.prefixComparable, false)
  assert.equal(phases[1].wireDiagnostics.prefixComparable, true)
  assert.equal(phases[1].wireDiagnostics.prefixChanged, false)
  assert.equal(phases[1].wireDiagnostics.bodyChanged, true)
  await emit(create('bob'))
  assert.equal(phases[2].wireDiagnostics.prefixComparable, false)
  assert.equal(phases[2].wireDiagnostics.toolsChanged, null)
  await emit(create('bob', messages, { ...config, configRevision: 4 }))
  assert.equal(phases[3].wireDiagnostics.prefixComparable, false)
})

test('unknown query routing and arbitrary headers disable comparability without hashing their secret values', () => {
  const create = (secret) => describeModelWireRequest({
    providerRequest: { url: `https://endpoint.invalid/v1?${secret}=${secret}`, init: { body: '{"messages":[]}' } },
    config: { ...config, headers: { 'x-private-routing': secret } }, profile, ownerId: 'alice',
  })
  const first = create('PRIVATE_FIRST')
  const second = create('PRIVATE_SECOND')
  assert.equal(first.identityComparable, false)
  assert.equal(first.endpointFingerprint, second.endpointFingerprint)
  assert.equal(first.configFingerprint, second.configFingerprint)
})
