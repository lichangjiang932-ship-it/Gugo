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
  assert.deepEqual(registry.list().map((entry) => entry.kind), ['text'])
})
