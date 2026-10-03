import assert from 'node:assert/strict'
import test from 'node:test'
import { load } from '../scripts/jsxLoader.mjs'

test('the component test loader accepts existing side-effect CSS imports as empty modules', async () => {
  const url = new URL('../src/index.css', import.meta.url).href
  const result = await load(url, {}, () => assert.fail('plain CSS must not reach Node\'s unsupported-extension loader'))
  assert.equal(result.format, 'module')
  assert.equal(result.shortCircuit, true)
  const namespace = await import(`data:text/javascript,${encodeURIComponent(result.source)}`)
  assert.deepEqual(Object.keys(namespace), [], 'a side-effect stylesheet must not fabricate CSS-module exports')
})

test('the CSS import adapter still rejects missing stylesheets instead of hiding broken imports', async () => {
  const missing = new URL('./fixtures/this-stylesheet-must-not-exist.css', import.meta.url).href
  await assert.rejects(
    load(missing, {}, () => assert.fail('the stylesheet must be checked before it is ignored')),
    (error) => error.code === 'ENOENT',
  )
})

test('CSS value queries and non-CSS modules retain their normal loader semantics', async () => {
  for (const suffix of ['index.css?inline', 'index.css?raw', 'data.js', 'assets/icon.svg']) {
    const url = new URL(`../src/${suffix}`, import.meta.url).href
    const expected = { format: 'module', source: 'export const delegated = true' }
    const context = { importAttributes: {} }
    assert.strictEqual(await load(url, context, (actualUrl, actualContext) => {
      assert.equal(actualUrl, url)
      assert.strictEqual(actualContext, context)
      return expected
    }), expected)
  }
  const originalFailure = new Error('unrelated loader failure')
  await assert.rejects(
    load(new URL('../src/missing.js', import.meta.url).href, {}, async () => { throw originalFailure }),
    (error) => error === originalFailure,
  )
})

test('CSS support keeps the real JSX transform enabled', async () => {
  const result = await load(new URL('../src/components/ToolApprovalCard.jsx', import.meta.url).href, {}, () => (
    assert.fail('JSX still uses the installed transform')
  ))
  assert.equal(result.format, 'module')
  assert.equal(result.shortCircuit, true)
  assert.match(result.source, /react\/jsx-runtime/u)
})
