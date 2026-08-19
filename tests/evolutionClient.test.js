import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createEvolutionReplaySuiteApi,
  generateEvolutionCandidateApi,
  getEvolutionCandidateApi,
  getEvolutionDatasetApi,
  getEvolutionReplayRunApi,
  listEvolutionCandidatesApi,
  listEvolutionEvidenceApi,
  listEvolutionExclusionsApi,
  listEvolutionReplayRunsApi,
  listEvolutionReplaySuitesApi,
  recordChatFeedback,
  runEvolutionReplayApi,
  setEvolutionEvidenceExcludedApi,
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

test('evolution client reads curated datasets and manages reversible exclusions', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url.startsWith('/api/evolution/dataset')
      ? { ok: true, dataset: { schemaVersion: 1, records: [] } }
      : url === '/api/evolution/exclusions' && init.method === 'POST'
        ? { ok: true, exclusion: { evidenceId: 'feedback:1', excluded: true } }
        : { ok: true, exclusions: [] }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const dataset = await getEvolutionDatasetApi({ limit: 50 })
    const exclusions = await listEvolutionExclusionsApi()
    const result = await setEvolutionEvidenceExcludedApi('feedback:1', true, 'duplicate')
    assert.equal(dataset.dataset.schemaVersion, 1)
    assert.deepEqual(exclusions.exclusions, [])
    assert.equal(result.exclusion.excluded, true)
    assert.equal(requests[0].url, '/api/evolution/dataset?limit=50')
    assert.equal(requests[1].url, '/api/evolution/exclusions')
    assert.equal(requests[1].init.method, undefined)
    assert.equal(requests[2].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[2].init.body), {
      evidenceId: 'feedback:1',
      excluded: true,
      reason: 'duplicate',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client generates and reads inert candidates without an apply client', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url === '/api/evolution/candidates/generate'
      ? { ok: true, candidate: { id: 'candidate-1', state: 'proposed' } }
      : url === '/api/evolution/candidates?limit=10'
        ? { ok: true, schemaVersion: 1, candidates: [] }
        : { ok: true, candidate: { id: 'candidate-1', content: 'proposal' } }
    return new Response(JSON.stringify(body), {
      status: url === '/api/evolution/candidates/generate' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const input = {
      kind: 'prompt',
      target: 'prompt:system',
      objective: 'Improve verification',
      datasetFingerprint: 'a'.repeat(64),
      sourceRecordIds: ['record:1234567890abcdef12345678'],
    }
    const generated = await generateEvolutionCandidateApi(input)
    const listed = await listEvolutionCandidatesApi({ limit: 10 })
    const detail = await getEvolutionCandidateApi('candidate/1')
    assert.equal(generated.candidate.state, 'proposed')
    assert.deepEqual(listed.candidates, [])
    assert.equal(detail.candidate.content, 'proposal')
    assert.equal(requests[0].url, '/api/evolution/candidates/generate')
    assert.equal(requests[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[0].init.body), input)
    assert.equal(requests[1].url, '/api/evolution/candidates?limit=10')
    assert.equal(requests[2].url, '/api/evolution/candidates/candidate%2F1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('evolution client creates suites and reads isolated replay results without evaluation or apply clients', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init })
    const body = url === '/api/evolution/replay-suites' && init.method === 'POST'
      ? { ok: true, suite: { id: 'suite-1' } }
      : url === '/api/evolution/replays/run'
        ? { ok: true, replay: { id: 'run-1', state: 'completed' } }
        : url.startsWith('/api/evolution/replay-suites?')
          ? { ok: true, suites: [] }
          : url.startsWith('/api/evolution/replays?')
            ? { ok: true, replays: [] }
            : { ok: true, replay: { id: 'run-1', results: [] } }
    return new Response(JSON.stringify(body), {
      status: init.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await createEvolutionReplaySuiteApi({ name: 'suite' })
    await listEvolutionReplaySuitesApi({ limit: 10 })
    await runEvolutionReplayApi({ suiteId: 'suite-1' })
    await listEvolutionReplayRunsApi({ limit: 20 })
    await getEvolutionReplayRunApi('run/1')
    assert.equal(requests[0].url, '/api/evolution/replay-suites')
    assert.equal(requests[0].init.method, 'POST')
    assert.equal(requests[1].url, '/api/evolution/replay-suites?limit=10')
    assert.equal(requests[2].url, '/api/evolution/replays/run')
    assert.equal(requests[2].init.method, 'POST')
    assert.equal(requests[3].url, '/api/evolution/replays?limit=20')
    assert.equal(requests[4].url, '/api/evolution/replays/run%2F1')
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
