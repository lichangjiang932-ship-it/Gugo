import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addModelToList,
  applyModelList,
  CATALOG_BASE_URLS,
  parseModelList,
  removeModelFromList,
  replaceModelList,
  resolveProviderDefaultModel,
  seedCustomEditor,
} from '../src/components/modelProviders/providerConfig.js'

// The model box is the only place a provider's catalog is edited, so these three
// helpers decide what the default-model select, the advanced textarea, and the
// save payload all agree on. They must be pure and order-preserving: a fetch
// returns the provider's own ordering and a reader who removes one id expects the
// rest to stay where they were.

test('parseModelList trims, drops blanks, and keeps first-seen order', () => {
  assert.deepEqual(parseModelList('b\na\nb\n\n  c  \n'), ['b', 'a', 'c'])
  assert.deepEqual(parseModelList('x,y , x'), ['x', 'y'])
  assert.deepEqual(parseModelList(['p', ' p ', '', 'q']), ['p', 'q'])
  assert.deepEqual(parseModelList(''), [])
  assert.deepEqual(parseModelList(null), [])
  assert.deepEqual(parseModelList(undefined), [])
})

test('addModelToList appends once and ignores a duplicate or a blank entry', () => {
  assert.deepEqual(addModelToList('a', 'b'), ['a', 'b'])
  assert.deepEqual(addModelToList('a', 'a'), ['a'], 're-adding the same id is a no-op')
  assert.deepEqual(addModelToList('a,b', ' a '), ['a', 'b'])
  assert.deepEqual(addModelToList('a', '   '), ['a'])
  assert.deepEqual(addModelToList('a', ''), ['a'])
  assert.deepEqual(addModelToList('', 'first'), ['first'], 'the first id seeds the catalog')
  assert.deepEqual(addModelToList([], 'first'), ['first'])
})

test('removeModelFromList keeps the remaining order and re-points a removed default', () => {
  assert.deepEqual(removeModelFromList('a\nb\nc', 'b', 'b'), { models: ['a', 'c'], defaultModel: 'a' })
  assert.deepEqual(removeModelFromList('a\nb\nc', 'b', 'c'), { models: ['a', 'c'], defaultModel: 'c' })
  assert.deepEqual(
    removeModelFromList('a\nb\nc', 'b', 'a'),
    { models: ['a', 'c'], defaultModel: 'a' },
    'removing a non-default model leaves the default alone',
  )
})

test('removing the last model leaves an empty catalog rather than a dangling default', () => {
  assert.deepEqual(removeModelFromList('only', 'only', 'only'), { models: [], defaultModel: '' })
  assert.deepEqual(removeModelFromList('', 'missing', 'x'), { models: [], defaultModel: '' })
})

test('a removal result always feeds resolveProviderDefaultModel a valid default', () => {
  // The save path recomputes the default from the list, so the two must not
  // disagree: whatever removeModelFromList returns must survive that call intact.
  for (const [list, removed, current] of [
    ['a\nb\nc', 'a', 'a'],
    ['a\nb\nc', 'c', 'c'],
    ['a', 'a', 'a'],
    ['a\nb', 'b', 'a'],
  ]) {
    const next = removeModelFromList(list, removed, current)
    assert.equal(resolveProviderDefaultModel(next.models, next.defaultModel), next.defaultModel)
  }
})

test('editing a preset list never resurrects a model the reader deleted', () => {
  // Fetch returns the provider's current list; the reader removes one; adding a
  // different one back must not re-introduce the removed id.
  const fetched = parseModelList('gpt-5.6-sol\ngpt-5.6-terra\ngpt-5.6-luna')
  const afterRemoval = removeModelFromList(fetched, 'gpt-5.6-terra', 'gpt-5.6-sol')
  assert.deepEqual(afterRemoval.models, ['gpt-5.6-sol', 'gpt-5.6-luna'])
  const afterAdd = addModelToList(afterRemoval.models, 'gpt-5.6-nova')
  assert.deepEqual(afterAdd, ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-nova'])
  assert.equal(afterAdd.includes('gpt-5.6-terra'), false)
})

// The knowledge base is a second source for the same editable list, so its two
// actions — "add these ids" and "use exactly this list" — must obey the same
// order, dedup and default-model rules the endpoint fetch already follows.

test('applyModelList adds only unknown ids and reports which ones were added', () => {
  assert.deepEqual(
    applyModelList('a\nb', ['b', 'c', 'd'], 'b'),
    { models: ['a', 'b', 'c', 'd'], added: ['c', 'd'], defaultModel: 'b' },
  )
  assert.deepEqual(
    applyModelList('', ['gpt-6.1-sol'], ''),
    { models: ['gpt-6.1-sol'], added: ['gpt-6.1-sol'], defaultModel: 'gpt-6.1-sol' },
    'the first id applied becomes the default',
  )
  assert.deepEqual(
    applyModelList('a', ['a', ' a ', 'a'], 'a'),
    { models: ['a'], added: [], defaultModel: 'a' },
    'a duplicate is a no-op, so a re-apply reports nothing added',
  )
})

test('applyModelList merges a source list on top of the reader edits', () => {
  // It is a merge, not a sync: re-applying a whole source list re-adds an id that
  // was removed by hand, which is why the screen offers the per-model toggle and
  // hands this helper only the ids that are currently missing.
  const afterRemoval = removeModelFromList('m-one\nm-two\nm-three', 'm-two', 'm-two')
  assert.deepEqual(afterRemoval, { models: ['m-one', 'm-three'], defaultModel: 'm-one' })
  const applied = applyModelList(afterRemoval.models, ['m-one', 'm-two', 'm-three'], afterRemoval.defaultModel)
  assert.deepEqual(applied.models, ['m-one', 'm-three', 'm-two'])
  assert.deepEqual(applied.added, ['m-two'])
  assert.equal(applied.defaultModel, 'm-one')

  const missing = ['m-one', 'm-two', 'm-three'].filter((id) => !afterRemoval.models.includes(id))
  assert.deepEqual(missing, ['m-two'], 'the bulk action only ever sends the missing ids')
  assert.deepEqual(applyModelList(afterRemoval.models, missing, afterRemoval.defaultModel).models, applied.models)
})

test('replaceModelList swaps the whole list while keeping a surviving default', () => {
  assert.deepEqual(
    replaceModelList('old-a\nold-b', 'old-b'),
    { models: ['old-a', 'old-b'], defaultModel: 'old-b' },
  )
  assert.deepEqual(
    replaceModelList(['gpt-6.1-sol', 'gpt-6-luna'], 'gpt-5.6-sol'),
    { models: ['gpt-6.1-sol', 'gpt-6-luna'], defaultModel: 'gpt-6.1-sol' },
    'a default outside the replacement list falls back to its first entry',
  )
  assert.deepEqual(
    replaceModelList('', 'stale'),
    { models: [], defaultModel: '' },
    'an empty replacement never leaves a dangling default',
  )
})

test('a seeded custom editor always starts on the custom path with a usable identity', () => {
  const seeded = seedCustomEditor({}, { key: 'amazon-bedrock', label: 'Amazon Bedrock' })
  assert.equal(seeded.presetId, 'custom')
  assert.equal(seeded.key, 'amazon-bedrock')
  assert.equal(seeded.label, 'Amazon Bedrock')
  assert.equal(seeded.isDefault, true)
  // A custom endpoint is it own credential source, so the save gate must not
  // wait for a preset's API key.
  assert.equal(seeded.baseUrl, '')
})

test('seeding a custom editor on a live edit keeps the saved provider identity and headers', () => {
  const saved = {
    id: 'provider-1',
    key: 'saved-provider',
    label: 'Saved Provider',
    enabled: false,
    isDefault: false,
    hasApiKey: true,
    savedHeaderKeys: ['X-Tenant'],
    apiKey: 'typed-but-unsaved',
    presetId: 'openai',
  }
  const seeded = seedCustomEditor(saved, { key: 'ignored', label: 'Ignored' })
  assert.equal(seeded.id, 'provider-1')
  assert.equal(seeded.key, 'saved-provider')
  assert.equal(seeded.label, 'Saved Provider')
  assert.equal(seeded.enabled, false)
  assert.equal(seeded.clearApiKey, true)
  assert.deepEqual(seeded.removedHeaderKeys, ['X-Tenant'])
  assert.equal(seeded.apiKey, '', 'an unsaved key must not follow the switch')
  assert.equal(seedCustomEditor(seeded, { key: 'other' }), seeded, 're-seeding the same path is idempotent')
})

test('the curated base URLs only cover providers whose OpenAI-compatible endpoint is stable', () => {
  assert.equal(CATALOG_BASE_URLS.cerebras, 'https://api.cerebras.ai/v1')
  assert.equal(CATALOG_BASE_URLS.baseten, 'https://inference.baseten.co/v1')
  // Providers with their own signing scheme must stay absent: guessing an endpoint
  // is worse than asking the reader for the one they use.
  for (const id of ['amazon-bedrock', 'google-vertex', 'github-copilot']) {
    assert.equal(Object.hasOwn(CATALOG_BASE_URLS, id), false, `${id} must not be guessed`)
  }
  for (const [id, url] of Object.entries(CATALOG_BASE_URLS)) {
    assert.match(url, /^https:\/\//, `${id} base URL must be an absolute https endpoint`)
  }
})
