import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getDynamicTool,
  getToolMetadata,
  listAllSpecs,
  registerDynamicTool,
  unregisterUserDynamicTools,
} from '../server/services/toolRegistry.js'

function spec(name) {
  return {
    type: 'function',
    function: { name, parameters: { type: 'object', properties: {} } },
  }
}

test('dynamic tool names and metadata are isolated by user', () => {
  const name = 'mcp__shared__lookup'
  registerDynamicTool({
    name,
    origin: 'mcp',
    userId: 'registry-user-a',
    spec: spec(name),
    metadata: { riskClass: 'read' },
  })
  registerDynamicTool({
    name,
    origin: 'mcp',
    userId: 'registry-user-b',
    spec: spec(name),
    metadata: { riskClass: 'external' },
  })

  try {
    assert.equal(getDynamicTool(name), null)
    assert.equal(getToolMetadata(name, { userId: 'registry-user-a' }).riskClass, 'read')
    assert.equal(getToolMetadata(name, { userId: 'registry-user-b' }).riskClass, 'external')
    assert.equal(listAllSpecs().some((entry) => entry.name === name), false)
    assert.equal(listAllSpecs({ userId: 'registry-user-a' }).filter((entry) => entry.name === name).length, 1)
    assert.equal(listAllSpecs({ userId: 'registry-user-b' }).filter((entry) => entry.name === name).length, 1)
  } finally {
    unregisterUserDynamicTools('registry-user-a')
    unregisterUserDynamicTools('registry-user-b')
  }
})
