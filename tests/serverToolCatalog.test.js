import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildServerToolCatalogFallback,
  fetchServerToolCatalog,
  normalizeServerToolCatalog,
  selectEnabledServerToolSpecs,
} from '../src/lib/serverToolCatalog.js'

function spec(name) {
  return { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }
}

test('fallback keeps enabled server-only tools without copying their live schemas', () => {
  const result = buildServerToolCatalogFallback(
    ['read_file', 'pdf_transform', 'media_transform'],
    [spec('read_file')],
  )
  assert.deepEqual(result.map((item) => item.function.name), [
    'media_transform',
    'pdf_transform',
    'read_file',
  ])
  assert.deepEqual(result[0].function.parameters, { type: 'object', additionalProperties: true })
  assert.deepEqual(result[2], spec('read_file'))
})

test('normalizes registry entries, deduplicates by name, and sorts stably', () => {
  const first = spec('media_transform')
  const replacement = { ...spec('media_transform'), function: { ...spec('media_transform').function, description: 'canonical' } }
  const result = normalizeServerToolCatalog({
    specs: [
      { origin: 'builtin', tool: first },
      { origin: 'builtin', tool: spec('image_info') },
      { origin: 'builtin', tool: replacement },
      { origin: 'broken' },
    ],
  })
  assert.deepEqual(result.map((item) => item.function.name), ['image_info', 'media_transform'])
  assert.equal(result[1].function.description, 'canonical')
})

test('selects only switches explicitly enabled in the persisted server tool config', () => {
  const result = selectEnabledServerToolSpecs(
    [spec('pdf_info'), spec('pdf_transform'), spec('archive_create')],
    { pdf_info: true, pdf_transform: false },
  )
  assert.deepEqual(result.map((item) => item.function.name), ['pdf_info'])
})

test('fetches canonical specs from the server catalog endpoint', async () => {
  const originalFetch = globalThis.fetch
  let request = null
  globalThis.fetch = async (url, init) => {
    request = { url, init }
    return new Response(JSON.stringify({ ok: true, specs: [{ tool: spec('batch_rename') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const result = await fetchServerToolCatalog({ mode: 'chat' })
    assert.deepEqual(result.map((item) => item.function.name), ['batch_rename'])
    assert.equal(request.url, '/api/tools/specs?mode=chat')
    assert.equal(request.init.method, 'GET')
  } finally {
    globalThis.fetch = originalFetch
  }
})
