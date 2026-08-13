import assert from 'node:assert/strict'
import test from 'node:test'

import { discoverOllamaEndpoint } from '../server/adapters/ollamaNative.js'

function fakeFetch(url, init = {}) {
  const pathname = new URL(url).pathname
  if (pathname === '/api/tags') {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ models: [{ name: 'short:latest' }, { name: 'long:latest' }] }),
    })
  }
  if (pathname === '/api/show') {
    const model = JSON.parse(init.body).model
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        capabilities: ['tools'],
        model_info: { 'test.context_length': model === 'short:latest' ? 8192 : 131072 },
      }),
    })
  }
  return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' })
}

test('Ollama discovery keeps a different context window for every model', async () => {
  const result = await discoverOllamaEndpoint({
    baseUrl: 'http://localhost:11434/v1',
    fetchImpl: fakeFetch,
  })

  assert.equal(result.modelProfiles['short:latest'].contextWindow, 8192)
  assert.equal(result.modelProfiles['long:latest'].contextWindow, 131072)
  assert.equal(result.models[0].profile.contextWindow, 8192)
  assert.equal(result.models[1].profile.contextWindow, 131072)
})

test('Ollama discovery resolves an untagged configured model through its latest tag', async () => {
  const result = await discoverOllamaEndpoint({
    baseUrl: 'http://localhost:11434/v1',
    modelName: 'short',
    fetchImpl: fakeFetch,
  })

  assert.equal(result.modelProfiles['short:latest'].contextWindow, 8192)
  assert.equal(result.profile.contextWindow, 8192)
})
