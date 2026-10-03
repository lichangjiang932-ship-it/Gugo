import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertInputEditor,
  assertModelCatalog,
  INPUT_EDITOR_METHODS,
  MODEL_CATALOG_METHODS,
} from '../../bin/cli/cliContracts.js'
import { createInteractiveModelCatalog } from '../../bin/cli/interactiveModelCatalog.js'
import { CliError } from '../../bin/cli/errors.js'

const noopEditor = () => ({
  question: async () => null,
  clear: () => {},
  suspend: () => {},
  close: () => {},
})

test('the editor contract accepts anything with the right shape and rejects the rest', () => {
  assert.ok(assertInputEditor(noopEditor()))
  assert.deepEqual([...INPUT_EDITOR_METHODS], ['question', 'clear', 'suspend', 'close'])

  const cases = [
    [null, /must be an object/],
    [{}, /missing question/],
    [{ question: () => {} }, /missing clear/],
  ]
  for (const [value, pattern] of cases) {
    assert.throws(() => assertInputEditor(value), (error) => {
      assert.ok(error instanceof CliError)
      assert.equal(error.code, 'CLI_INPUT_EDITOR_INVALID')
      assert.match(error.message, pattern)
      return true
    })
  }
})

const realCatalog = () => createInteractiveModelCatalog({ env: {}, readProviders: async () => [] })

test('the catalogue contract accepts the production factory and names each missing method', () => {
  const real = realCatalog()
  assert.equal(assertModelCatalog(real), real)
  assert.deepEqual([...MODEL_CATALOG_METHODS], ['entries', 'list', 'diagnostics', 'refresh', 'select', 'close'])

  for (const method of MODEL_CATALOG_METHODS) {
    const partial = { ...real }
    delete partial[method]
    assert.throws(() => assertModelCatalog(partial), (error) => {
      assert.equal(error.code, 'CLI_MODEL_CATALOG_INVALID')
      assert.match(error.message, new RegExp(`missing ${method}`))
      return true
    })
  }
})

test('invalid synchronous catalogue snapshots are diagnosed at wiring time', () => {
  const bad = [
    ['list', () => 'not-an-array'], ['list', () => [42]],
    ['entries', () => null], ['entries', () => ['not-an-entry']], ['entries', () => [{}]],
    ['diagnostics', () => null], ['diagnostics', () => []],
    ['diagnostics', () => ({ source: 'provider', lastSuccessfulRefresh: null, cached: false })],
    ['diagnostics', () => ({ source: 'empty', lastSuccessfulRefresh: NaN, cached: false })],
    ['diagnostics', () => ({ source: 'empty', lastSuccessfulRefresh: null, cached: 'false' })],
  ]
  for (const [method, implementation] of bad) {
    assert.throws(() => assertModelCatalog({ ...realCatalog(), [method]: implementation }), (error) => {
      assert.equal(error.code, 'CLI_MODEL_CATALOG_INVALID')
      assert.ok(error.message.includes(`${method}()`), error.message)
      return true
    })
  }
  assert.throws(() => assertModelCatalog(null), /must be an object/)
})

test('declared async snapshot methods are rejected without invoking their bodies', () => {
  for (const method of ['entries', 'list', 'diagnostics']) {
    let calls = 0
    const catalog = { ...realCatalog(), [method]: async () => { calls++; throw new Error('must not execute') } }
    assert.throws(() => assertModelCatalog(catalog), { code: 'CLI_MODEL_CATALOG_INVALID' })
    assert.equal(calls, 0)
  }
})

test('unexpected rejected Promises are observed when refusing asynchronous snapshot implementations', async () => {
  for (const method of ['entries', 'list', 'diagnostics']) {
    const catalog = { ...realCatalog(), [method]: () => Promise.reject(new Error('fixture rejection')) }
    assert.throws(() => assertModelCatalog(catalog), /must be synchronous/u)
  }
  assert.throws(() => assertModelCatalog(Promise.reject(new Error('async factory'))), { code: 'CLI_MODEL_CATALOG_INVALID' })
  await new Promise(setImmediate)
})

test('catalogue checks invoke no refresh, selection, close, or thenable continuations', () => {
  const actions = []
  const catalog = { ...realCatalog(),
    refresh: () => { actions.push('refresh'); return Promise.resolve(false) },
    select: () => { actions.push('select'); return Promise.resolve({}) },
    close: () => { actions.push('close') },
  }
  assert.equal(assertModelCatalog(catalog), catalog)
  for (const method of ['entries', 'list', 'diagnostics']) {
    assert.throws(() => assertModelCatalog({ ...catalog,
      [method]: () => ({ then() { actions.push('then') } }),
    }), /must be synchronous/u)
  }
  assert.deepEqual(actions, [])
})

test('a throwing snapshot method gets a stable contract code without echoing its raw error', () => {
  assert.throws(() => assertModelCatalog({ ...realCatalog(), list() { throw new Error('private provider detail') } }), (error) => {
    assert.equal(error.code, 'CLI_MODEL_CATALOG_INVALID')
    assert.match(error.message, /list\(\)/u)
    assert.doesNotMatch(error.message, /private provider detail/u)
    return true
  })
})

test('editor shape checking invokes none of the input lifecycle methods', () => {
  const calls = []
  const built = Object.fromEntries(INPUT_EDITOR_METHODS.map((method) => [method, () => { calls.push(method) }]))
  assert.equal(assertInputEditor(built), built)
  assert.deepEqual(calls, [])
})
