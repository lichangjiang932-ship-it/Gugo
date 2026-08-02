import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchWithEnvProxy, shouldUseEnvProxy } from '../server/adapters/proxyFetch.js'

test('public endpoints use configured HTTP(S) proxy', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:8080' }
  assert.equal(shouldUseEnvProxy('https://api.deepseek.com/v1/models', env), true)
})

test('local and private model endpoints always bypass proxy', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:8080' }
  assert.equal(shouldUseEnvProxy('http://127.0.0.1:11434/v1/models', env), false)
  assert.equal(shouldUseEnvProxy('http://localhost:1234/v1/models', env), false)
  assert.equal(shouldUseEnvProxy('http://192.168.1.20:8000/v1/models', env), false)
})

test('no proxy configuration keeps native direct fetch', () => {
  assert.equal(shouldUseEnvProxy('https://api.example.com/v1/models', {}), false)
})

test('runtime fetch overrides keep precedence for tests and embedding hosts', async () => {
  const originalFetch = globalThis.fetch
  const expected = new Response('{}', { status: 200 })
  let called = 0
  globalThis.fetch = async () => {
    called += 1
    return expected
  }
  try {
    const response = await fetchWithEnvProxy('https://api.example.com/v1/models')
    assert.equal(response, expected)
    assert.equal(called, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
