import assert from 'node:assert/strict'
import test from 'node:test'

import { createPreviewRendererRegistry } from '../../src/pages/ChatSplit/preview/previewRendererRegistry.js'

function Renderer() {}

test('preview renderer registry registers, resolves, lists, and reverses ownership safely', () => {
  const registry = createPreviewRendererRegistry()
  const undoFirst = registry.register(' Custom ', { component: Renderer, needsFetch: true, label: 'custom' })

  const descriptor = registry.resolve('custom')
  assert.equal(descriptor.component, Renderer)
  assert.equal(descriptor.needsFetch, true)
  assert.equal(Object.isFrozen(descriptor), true)
  const snapshot = registry.list()
  assert.equal(Object.isFrozen(snapshot), true)
  assert.deepEqual(snapshot.map((entry) => entry.kind), ['custom'])
  assert.equal(Object.isFrozen(snapshot[0]), true)

  assert.equal(registry.unregister('custom'), true)
  const undoSecond = registry.register('custom', { component: Renderer })
  assert.equal(undoFirst(), false, 'an obsolete cleanup must not remove a newer registration')
  assert.ok(registry.resolve('custom'))
  assert.equal(undoSecond(), true)
  assert.equal(undoSecond(), false)
  assert.equal(registry.resolve('custom'), null)
})
test('preview renderer registry fails closed on duplicate or invalid registrations', () => {
  const registry = createPreviewRendererRegistry([['text', { component: Renderer }]])
  assert.throws(
    () => registry.register('TEXT', { component: Renderer }),
    (error) => error?.code === 'PREVIEW_RENDERER_DUPLICATE',
  )
  assert.equal(registry.resolve('text').component, Renderer)
  assert.throws(() => registry.register('', { component: Renderer }), /kind is required/)
  assert.throws(() => registry.register('broken', {}), /requires a component type/)
  assert.throws(() => registry.register('broken', { component: null }), /requires a component type/)
  assert.deepEqual(registry.list().map((entry) => entry.kind), ['text'])
})

test('owned reload replaces only the same owner and stale disposal cannot remove its replacement', () => {
  const registry = createPreviewRendererRegistry()
  const owner = Symbol('builtin')
  const undoOld = registry.registerOwned(owner, 'image', { component: Renderer, label: 'old' })
  assert.equal(registry.unregister('image'), false)
  assert.equal(registry.unregister('image', Symbol('other')), false)
  const undoNew = registry.registerOwned(owner, 'image', { component: Renderer, label: 'new' })
  assert.equal(registry.resolve('image').label, 'new')
  assert.equal(undoOld(), false)
  assert.throws(() => registry.registerOwned(Symbol('other'), 'image', { component: Renderer }),
    (error) => error.code === 'PREVIEW_RENDERER_DUPLICATE')
  assert.throws(() => registry.register('image', { component: Renderer }),
    (error) => error.code === 'PREVIEW_RENDERER_DUPLICATE')
  assert.throws(() => registry.registerOwned(owner, 'image', { component: null }), /requires a component type/)
  assert.equal(registry.resolve('image').label, 'new')
  assert.equal(undoNew(), true)
  assert.equal(registry.resolve('image'), null)
  assert.throws(() => registry.registerOwned('builtin', 'image', { component: Renderer }), /opaque symbol/)
})

test('built-in reload does not clear renderers before an asynchronous replacement is available', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../src/pages/ChatSplit/preview/DirectFilePreview.jsx', import.meta.url), 'utf8')
  assert.match(source, /registerOwned\(BUILTIN_PREVIEW_RENDERER_OWNER/)
  assert.doesNotMatch(source, /import\.meta\.hot\.dispose/)
  const registry = createPreviewRendererRegistry()
  const owner = Symbol('builtins')
  registry.registerOwned(owner, 'unsupported', { component: Renderer })
  await Promise.resolve()
  assert.equal(registry.resolve('unsupported').component, Renderer)
  const undo = registry.registerOwned(owner, 'unsupported', { component: Renderer, label: 'reloaded' })
  assert.equal(registry.resolve('unsupported').label, 'reloaded')
  assert.equal(registry.unregister('unsupported', owner), true)
  assert.equal(undo(), false)
})
