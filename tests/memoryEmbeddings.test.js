import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MEMORY_EMBEDDING_MAX_BATCH,
  blendMemoryScores,
  cosineSimilarity,
  deserializeMemoryVector,
  embedMemoryTexts,
  memoryContentFingerprint,
  memoryEmbeddingSpaceId,
  prepareMemoryQueryVector,
  memoryEmbeddingUrl,
  resolveMemoryEmbeddingConfig,
  semanticMemoryPoints,
  serializeMemoryVector,
} from '../server/services/memoryEmbeddingService.js'

test('embeddings stay disabled unless explicitly configured', () => {
  assert.equal(resolveMemoryEmbeddingConfig({}), null)
  assert.equal(resolveMemoryEmbeddingConfig({ MEMORY_EMBEDDINGS_ENABLED: '1' }), null)
  assert.equal(resolveMemoryEmbeddingConfig({
    MEMORY_EMBEDDINGS_ENABLED: '1', MEMORY_EMBEDDING_MODEL: 'embed-1',
  }), null, 'a model without a base URL must not enable network calls')
  assert.equal(resolveMemoryEmbeddingConfig({
    MEMORY_EMBEDDINGS_ENABLED: '0',
    MEMORY_EMBEDDING_MODEL: 'embed-1',
    MEMORY_EMBEDDING_BASE_URL: 'http://127.0.0.1:1234/v1',
  }), null)
})

test('explicit configuration enables embeddings and falls back to MODEL_* env', () => {
  const explicit = resolveMemoryEmbeddingConfig({
    MEMORY_EMBEDDINGS_ENABLED: '1',
    MEMORY_EMBEDDING_MODEL: 'embed-1',
    MEMORY_EMBEDDING_BASE_URL: 'http://127.0.0.1:1234/v1/',
    MEMORY_EMBEDDING_API_KEY: 'k',
    MEMORY_EMBEDDING_TIMEOUT_MS: '999999',
  })
  assert.equal(explicit.model, 'embed-1')
  assert.equal(explicit.baseUrl, 'http://127.0.0.1:1234/v1')
  assert.equal(explicit.apiKey, 'k')
  assert.equal(explicit.timeoutMs, 60_000, 'timeout is bounded')

  const fallback = resolveMemoryEmbeddingConfig({
    MEMORY_EMBEDDINGS_ENABLED: '1',
    MEMORY_EMBEDDING_MODEL: 'embed-2',
    MODEL_BASE_URL: 'https://example.test/v1',
    MODEL_API_KEY: 'model-key',
  })
  assert.equal(fallback.baseUrl, 'https://example.test/v1')
  assert.equal(fallback.apiKey, 'model-key')
})

test('embedding URL handles both base and explicit endpoints', () => {
  assert.equal(memoryEmbeddingUrl('http://x/v1'), 'http://x/v1/embeddings')
  assert.equal(memoryEmbeddingUrl('http://x/v1/embeddings'), 'http://x/v1/embeddings')
})

test('cosine similarity is bounded and rejects malformed input', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1)
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), null, 'dimension mismatch')
  assert.equal(cosineSimilarity([0, 0], [1, 1]), null, 'zero vector')
  assert.equal(cosineSimilarity([1, Number.NaN], [1, 1]), null)
  assert.equal(cosineSimilarity('nope', [1]), null)
})

test('semantic points are additive, bounded and ignore negative similarity', () => {
  assert.equal(semanticMemoryPoints(0), 0)
  assert.equal(semanticMemoryPoints(-0.5), 0)
  assert.equal(semanticMemoryPoints(Number.NaN), 0)
  assert.equal(semanticMemoryPoints(1), 70)
  assert.ok(semanticMemoryPoints(0.5) < 70)

  assert.equal(blendMemoryScores({ lexicalScore: 10, similarity: null }), 10)
  assert.equal(blendMemoryScores({ lexicalScore: 0, similarity: 1 }), 70)
  assert.equal(blendMemoryScores({ lexicalScore: -5, similarity: 0 }), 0)
  // A semantic-only match must never outrank a strong exact title hit.
  assert.ok(blendMemoryScores({ lexicalScore: 140, similarity: 1 }) > blendMemoryScores({ lexicalScore: 0, similarity: 1 }))
})

test('vector serialization round-trips Float32 with dimension guards', () => {
  const vector = [0.5, -1.25, 3]
  const buffer = serializeMemoryVector(vector)
  assert.ok(Buffer.isBuffer(buffer))
  assert.equal(buffer.length, 12)
  const restored = deserializeMemoryVector(buffer, 3)
  assert.equal(restored.length, 3)
  for (let index = 0; index < vector.length; index += 1) {
    assert.ok(Math.abs(restored[index] - vector[index]) < 1e-6)
  }
  assert.equal(deserializeMemoryVector(buffer, 2), null, 'dimension must match the buffer')
  assert.equal(serializeMemoryVector([]), null)
  assert.equal(serializeMemoryVector([1, 'x']), null)
})

test('content fingerprint changes with the body and is stable otherwise', () => {
  const base = { type: 'user', title: 'a', body: 'b' }
  const same = { ...base }
  const changed = { ...base, body: 'c' }
  assert.match(memoryContentFingerprint(base), /^[a-f0-9]{64}$/u)
  assert.equal(memoryContentFingerprint(base), memoryContentFingerprint(same))
  assert.notEqual(memoryContentFingerprint(base), memoryContentFingerprint(changed))
})

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

const CONFIG = Object.freeze({
  enabled: true,
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: '',
  model: 'embed-test',
  timeoutMs: 1_000,
})

test('embedMemoryTexts validates the provider response shape', async () => {
  const ok = await embedMemoryTexts({
    config: CONFIG,
    texts: ['first', 'second'],
    fetchImpl: async () => jsonResponse({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    }),
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.vectors, [[1, 0], [0, 1]])
  assert.equal(ok.dimensions, 2)

  for (const payload of [
    { data: [{ index: 0, embedding: [1, 0] }] },
    { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] },
    { data: [{ index: 0, embedding: [] }] },
    { data: [{ index: 0, embedding: [1, Number.NaN] }] },
    {},
  ]) {
    const result = await embedMemoryTexts({
      config: CONFIG, texts: ['a', 'b'], fetchImpl: async () => jsonResponse(payload),
    })
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.equal(result.code, 'MEMORY_EMBEDDING_RESPONSE_INVALID')
  }
})

test('embedMemoryTexts reports transport, batch and disabled states without throwing', async () => {
  assert.equal((await embedMemoryTexts({ config: null, texts: ['a'] })).code, 'MEMORY_EMBEDDINGS_DISABLED')
  assert.equal((await embedMemoryTexts({
    config: CONFIG, texts: ['a'], fetchImpl: async () => jsonResponse({}, 500),
  })).code, 'MEMORY_EMBEDDING_HTTP_500')
  assert.equal((await embedMemoryTexts({
    config: CONFIG, texts: ['a'], fetchImpl: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }) },
  })).code, 'ENOTFOUND')
  assert.equal((await embedMemoryTexts({
    config: CONFIG, texts: Array.from({ length: MEMORY_EMBEDDING_MAX_BATCH + 1 }, () => 'x'),
  })).code, 'MEMORY_EMBEDDING_BATCH_TOO_LARGE')
  assert.deepEqual(await embedMemoryTexts({ config: CONFIG, texts: [] }), { ok: true, vectors: [], dimensions: 0 })
})

test('an already cancelled embedding operation performs no network request', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const result = await embedMemoryTexts({
    config: CONFIG, texts: ['private input'], signal: controller.signal,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] })
    },
  })
  assert.equal(calls, 0)
  assert.deepEqual(result, { ok: false, code: 'MEMORY_EMBEDDING_ABORTED' })
})

test('space identity separates routes, revisions and widths but normalizes the effective endpoint', () => {
  const base = { baseUrl: 'https://Embeddings.test/v1', model: 'embed-1' }
  const expected = memoryEmbeddingSpaceId(base)
  assert.match(expected, /^memspace:v2:/u)
  assert.equal(memoryEmbeddingSpaceId({ ...base, baseUrl: 'https://embeddings.test/v1/embeddings' }), expected)
  assert.equal(memoryEmbeddingSpaceId({ ...base, baseUrl: 'https://name:secret@embeddings.test/v1' }), expected)
  for (const changed of [
    { baseUrl: 'http://embeddings.test/v1' },
    { baseUrl: 'https://embeddings.test/V1' },
    { baseUrl: 'https://embeddings.test/v1?deployment=another' },
    { model: 'embed-2' },
    { revision: 'weights-2026-09' },
    { dimensions: 2 },
  ]) assert.notEqual(memoryEmbeddingSpaceId({ ...base, ...changed }), expected)
  assert.doesNotMatch(expected, /secret|embeddings\.test/u)
  assert.equal(memoryEmbeddingSpaceId({ ...base, baseUrl: 'file:///embeddings' }), null)
  assert.equal(memoryEmbeddingUrl('https://x/v1?deployment=local'), 'https://x/v1/embeddings?deployment=local')
  assert.equal(memoryEmbeddingUrl('https://x/v1/?deployment=local/'), 'https://x/v1/embeddings?deployment=local/')
  const routed = resolveMemoryEmbeddingConfig({
    MEMORY_EMBEDDINGS_ENABLED: '1', MEMORY_EMBEDDING_MODEL: 'embed-1',
    MEMORY_EMBEDDING_BASE_URL: 'https://x/v1/?deployment=local/',
  })
  assert.equal(routed.baseUrl, 'https://x/v1?deployment=local/')
})

test('explicit embedding width is sent and a provider width mismatch is rejected', async () => {
  const config = resolveMemoryEmbeddingConfig({
    MEMORY_EMBEDDINGS_ENABLED: '1', MEMORY_EMBEDDING_MODEL: 'embed-1',
    MEMORY_EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
    MEMORY_EMBEDDING_DIMENSIONS: '2', MEMORY_EMBEDDING_REVISION: 'revision-1',
  })
  assert.equal(config.dimensions, 2)
  assert.equal(config.revision, 'revision-1')
  let request
  const result = await embedMemoryTexts({
    config, texts: ['x'], fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body)
      return jsonResponse({ data: [{ index: 0, embedding: [1, 0, 0] }] })
    },
  })
  assert.equal(request.dimensions, 2)
  assert.equal(result.code, 'MEMORY_EMBEDDING_DIMENSIONS_MISMATCH')
})

test('stored vectors reject Float32 overflow, underflow-to-zero and non-finite blobs', () => {
  for (const vector of [[0, 0], [1e100, 1], [1e-100, 0]]) assert.equal(serializeMemoryVector(vector), null)
  const invalid = Buffer.alloc(8)
  invalid.writeFloatLE(Infinity, 0)
  assert.equal(deserializeMemoryVector(invalid, 2), null)
  assert.equal(deserializeMemoryVector(Buffer.alloc(8), 2), null)
  assert.equal(deserializeMemoryVector(new Uint8Array(8), 2), null)
  assert.equal(semanticMemoryPoints(5), 70)
})

test('cancelled responses are never returned as successful embeddings', async () => {
  const controller = new AbortController()
  const result = await embedMemoryTexts({
    config: CONFIG, texts: ['x'], signal: controller.signal,
    fetchImpl: async () => {
      controller.abort()
      return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] })
    },
  })
  assert.equal(result.code, 'MEMORY_EMBEDDING_ABORTED')
  let calls = 0
  const query = await prepareMemoryQueryVector({
    query: 'x', env: {}, fetchImpl: async () => { calls += 1 },
  })
  assert.equal(query, null)
  assert.equal(calls, 0, 'disabled embeddings must never request a query vector')
})
