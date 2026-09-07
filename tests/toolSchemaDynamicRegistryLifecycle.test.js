import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getDynamicTool,
  registerDynamicTool,
  unregisterUserDynamicTools,
} from '../server/utils/toolSchemaDynamicRegistry.js'

function definition(userId, name) {
  return {
    name, userId, origin: 'test', source: 'user-registry-lifecycle',
    spec: { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } },
  }
}

test('a disposer from a cleared user generation cannot delete a fresh user registry', () => {
  const userId = 'user-registry-generation-test'
  const oldDispose = registerDynamicTool(definition(userId, 'old_generation_tool'))
  try {
    assert.equal(unregisterUserDynamicTools(userId), 1)
    const freshDispose = registerDynamicTool(definition(userId, 'fresh_generation_tool'))
    try {
      const fresh = getDynamicTool('fresh_generation_tool', { userId })
      assert.ok(fresh)
      assert.equal(oldDispose(), false)
      assert.strictEqual(getDynamicTool('fresh_generation_tool', { userId }), fresh)
    } finally { freshDispose() }
  } finally { unregisterUserDynamicTools(userId) }
})

test('clearing a user generation prevents old shadow disposers from restoring its tools', () => {
  const userId = 'user-registry-shadow-generation-test'
  const baseDispose = registerDynamicTool(definition(userId, 'shared_generation_tool'))
  const shadowDispose = registerDynamicTool(definition(userId, 'shared_generation_tool'))
  try {
    assert.equal(unregisterUserDynamicTools(userId), 1)
    assert.equal(getDynamicTool('shared_generation_tool', { userId }), null)
    const freshDispose = registerDynamicTool(definition(userId, 'shared_generation_tool'))
    try {
      const fresh = getDynamicTool('shared_generation_tool', { userId })
      shadowDispose()
      baseDispose()
      assert.strictEqual(getDynamicTool('shared_generation_tool', { userId }), fresh)
    } finally { freshDispose() }
  } finally { unregisterUserDynamicTools(userId) }
})
