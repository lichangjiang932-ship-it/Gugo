import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addModelToList,
  parseModelList,
  removeModelFromList,
  resolveProviderDefaultModel,
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
