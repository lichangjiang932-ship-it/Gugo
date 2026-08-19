import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildServerToolCatalogFallback,
  fetchServerToolCatalog,
  normalizeServerToolCatalog,
  selectEnabledServerToolSpecs,
} from '../src/lib/serverToolCatalog.js'
import { SERVER_TURN_TOOL_TOGGLE_NAMES } from '../src/lib/serverToolConfig.js'
import { buildToolSpecs } from '../src/lib/tools/toolSpecs.js'

const BROWSER_TOOL_NAMES = [
  'browser_open_url',
  'browser_navigate',
  'browser_state',
  'browser_snapshot',
  'browser_console',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_wait',
  'browser_screenshot',
]

function spec(name) {
  return { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }
}

test('fallback keeps enabled server-only tools without copying their live schemas', () => {
  const result = buildServerToolCatalogFallback(
    ['read_file', 'pdf_transform', 'media_transform'],
  )
  assert.deepEqual(
    result.map((item) => item.function.name),
    [...BROWSER_TOOL_NAMES, 'media_transform', 'pdf_transform', 'read_file']
      .sort((left, right) => left.localeCompare(right, 'en')),
  )

  for (const item of result) {
    assert.equal(
      Object.hasOwn(item.function, 'parameters'),
      false,
      `${item.function.name} fallback must not duplicate server parameters`,
    )
  }
})

test('fallback represents every configurable server turn tool without the retired client catalog', () => {
  const names = new Set(
    buildServerToolCatalogFallback(SERVER_TURN_TOOL_TOGGLE_NAMES)
      .map((item) => item.function.name),
  )

  for (const name of SERVER_TURN_TOOL_TOGGLE_NAMES) {
    assert.ok(names.has(name), `${name} is missing from the context-estimation fallback`)
  }
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

test('a newly returned server tool needs no frontend schema registration', () => {
  const serverOnlySpec = {
    type: 'function',
    function: {
      name: 'server_only_new_tool',
      description: 'Defined only by the server catalog.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'integer', minimum: 1 } },
        required: ['value'],
      },
    },
  }
  const catalog = normalizeServerToolCatalog({
    specs: [{ origin: 'builtin', tool: serverOnlySpec }],
  })

  assert.equal(buildToolSpecs(['server_only_new_tool'], catalog)[0], serverOnlySpec)
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
