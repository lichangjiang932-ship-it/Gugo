import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRegisteredToolSpec, onMcpToolsChange, synchronizeToolsForConnection, unregisterAllMcpToolsForUser,
} from '../server/mcp/mcpToolRegistry.js'
import { getDynamicTool } from '../server/utils/toolSchemaDynamicRegistry.js'
import { validateToolCall } from '../server/utils/toolCallArguments.js'

test('a bad later MCP schema cannot partially replace a previous catalog or approval identity', (t) => {
  const userId = 'mcp-schema-atomic-owner'
  const server = { id: 'schema-atomic', name: 'Schema Atomic' }
  const previous = { tools: ['first', 'second'].map((name) => ({ name, inputSchema: {
    type: 'object', properties: { value: { type: 'integer', minimum: 1 } },
  } })) }
  t.after(() => unregisterAllMcpToolsForUser(userId))
  synchronizeToolsForConnection(userId, server, null, previous)
  const names = previous.tools.map((tool) => buildRegisteredToolSpec(server, tool).function.name)
  const before = names.map((name) => getDynamicTool(name, { userId }))
  const registrations = previous._mcpToolRegistrations
  const changes = []
  t.after(onMcpToolsChange((event) => changes.push(event)))
  const next = { tools: [
    { name: 'first', inputSchema: { type: 'object', properties: { value: { const: 3 } } } },
    { name: 'second', inputSchema: { $ref: 'https://untrusted.invalid/private-schema' } },
  ] }
  assert.throws(() => synchronizeToolsForConnection(userId, server, previous, next), { code: 'tool_schema_unsupported' })
  assert.deepEqual(names.map((name) => getDynamicTool(name, { userId })), before)
  assert.equal(previous._mcpToolRegistrations, registrations)
  assert.equal(next._mcpToolRegistrations, undefined)
  assert.deepEqual(changes, [])
})

test('a legitimate false inputSchema is not broadened to an unconstrained object', (t) => {
  const userId = 'mcp-schema-false-owner'
  const server = { id: 'false-schema', name: 'False Schema' }
  const tool = { name: 'disabled-by-schema', inputSchema: false }
  const spec = buildRegisteredToolSpec(server, tool)
  assert.equal(spec.function.parameters, false)
  const connection = { tools: [tool] }
  t.after(() => unregisterAllMcpToolsForUser(userId))
  synchronizeToolsForConnection(userId, server, null, connection)
  assert.equal(validateToolCall({ name: spec.function.name, args: {} }, [spec])?.code, 'tool_arguments_validation_failed')
})
