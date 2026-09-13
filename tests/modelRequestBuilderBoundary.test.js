import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import * as modelProxy from '../server/adapters/modelProxy.js'
import * as requestBuilder from '../server/adapters/modelRequestBuilder.js'
import { loadModelConfig } from '../server/adapters/modelProviderConfig.js'

const builderSourceUrl = new URL('../server/adapters/modelRequestBuilder.js', import.meta.url)

test('the example configuration leaves compatible output uncapped and honors explicit user limits', async () => {
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  const exampleLimit = example.match(/^MODEL_MAX_TOKENS=(.*)$/m)?.[1]?.trim()
  const baseEnv = { MODEL_BASE_URL: 'http://127.0.0.1:11434', MODEL_NAME: 'offline-limit-fixture' }
  const buildBody = (maxTokens) => {
    const env = { ...baseEnv, MODEL_MAX_TOKENS: maxTokens }
    const request = requestBuilder.buildOpenAICompatibleRequest({
      config: loadModelConfig(env), env, tools: [],
      messages: [{ role: 'user', content: 'Reply briefly.' }],
    })
    return JSON.parse(request.init.body)
  }
  assert.equal(Object.hasOwn(buildBody(exampleLimit), 'max_tokens'), false)
  assert.equal(buildBody('8192').max_tokens, 8192)
})

test('modelProxy keeps request-builder exports as identity-preserving compatibility aliases', () => {
  for (const name of [
    'buildModelProviderRequest',
    'buildOpenAICompatibleRequest',
    'normalizeOpenAICompatibleUrl',
    'supportsStreamUsage',
  ]) {
    assert.equal(modelProxy[name], requestBuilder[name], name)
  }
})

test('model request building remains a leaf without execution, transport, or persistence dependencies', async () => {
  const source = await readFile(builderSourceUrl, 'utf8')
  for (const forbidden of [
    "from './modelProxy.js'",
    "from './modelStreamingTransport.js'",
    "from './modelFailover.js'",
    "from '../db.js'",
    "from '../services/",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})
