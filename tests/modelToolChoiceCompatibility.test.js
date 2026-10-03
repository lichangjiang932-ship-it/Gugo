import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOpenAICompatibleRequest } from '../server/adapters/modelRequestBuilder.js'
import { resolveEndpointProfile } from '../server/utils/endpointProfile.js'

const tools = ['another_tool', 'gugo_provider_probe'].map((name) => ({ type: 'function', function: {
  name, description: 'Offline tool-choice fixture.', parameters: { type: 'object', properties: {} },
} }))
const named = { type: 'function', function: { name: 'gugo_provider_probe' } }

function body({ baseUrl = 'http://127.0.0.1:1234/v1', toolChoice = named, overrides = {} } = {}) {
  const config = { baseUrl, modelName: 'fixture', temperature: 0 }
  const profile = resolveEndpointProfile({ ...config, env: {}, overrides })
  return JSON.parse(buildOpenAICompatibleRequest({ config, profile, env: {},
    messages: [{ role: 'user', content: 'Call the selected fixture tool.' }], tools, toolChoice }).init.body)
}

test('LM Studio uses a single authorized tool plus required instead of unsupported named tool_choice', () => {
  const request = body()
  assert.equal(request.tool_choice, 'required')
  assert.deepEqual(request.tools.map((spec) => spec.function.name), ['gugo_provider_probe'])
  assert.equal(tools.length, 2, 'wire adaptation must not mutate the runtime catalog')
  assert.equal(resolveEndpointProfile({ baseUrl: 'http://127.0.0.1:1234', env: {} }).supportsNamedToolChoice, false)
})

test('ordinary automatic selection and named-capable providers keep their original wire contract', () => {
  assert.equal(body({ toolChoice: 'auto' }).tools.length, 2)
  assert.deepEqual(body({ baseUrl: 'https://compatible.example.invalid/v1' }).tool_choice, named)
  assert.deepEqual(body({ overrides: { supportsNamedToolChoice: true } }).tool_choice, named)
})

test('named-tool adaptation cannot invent a capability that was not supplied to the model', () => {
  assert.throws(() => body({ toolChoice: { type: 'function', function: { name: 'unauthorized_tool' } } }),
    { code: 'MODEL_TOOL_CHOICE_UNAVAILABLE' })
})
