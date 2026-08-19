import assert from 'node:assert/strict'
import test from 'node:test'

import {
  listEvolutionEvidenceApi,
  recordChatFeedback,
} from '../src/lib/evolutionClient.js'

test('evolution client persists feedback and reads only the versioned evidence corpus', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url === '/api/evolution/feedback'
      ? { ok: true, evidence: { id: 'feedback:1' } }
      : { ok: true, schemaVersion: 1, evidence: [] }
    return new Response(JSON.stringify(body), {
      status: url === '/api/evolution/feedback' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    assert.equal(await recordChatFeedback(' improve errors ', 'chat-1'), true)
    const corpus = await listEvolutionEvidenceApi({ limit: 25 })
    assert.equal(corpus.schemaVersion, 1)
    assert.equal(requests[0].url, '/api/evolution/feedback')
    assert.equal(requests[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      feedback: 'improve errors',
      sessionId: 'chat-1',
    })
    assert.equal(requests[1].url, '/api/evolution/evidence?limit=25')
    assert.equal(requests[1].init.method, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client does not submit empty feedback', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('must not fetch')
  }
  try {
    assert.equal(await recordChatFeedback('   ', 'chat-1'), false)
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
