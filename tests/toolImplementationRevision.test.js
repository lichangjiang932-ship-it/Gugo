import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-tool-revision-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser } = await import('../server/db.js')
const { upsertServer } = await import('../server/mcp/mcpStore.js')
const {
  resolveToolImplementationRevisions,
} = await import('../server/services/toolImplementationRevision.js')
const { registerDynamicTool } = await import('../server/services/toolRegistry.js')

const userId = 'tool-revision-user'
createUser({ id: userId, email: 'tool-revision@example.com' })

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function toolSpec(name) {
  return {
    type: 'function',
    function: { name, parameters: { type: 'object', properties: {} } },
  }
}

test('tool revisions cover built-ins and statically executable Connector tools', () => {
  const revisions = resolveToolImplementationRevisions({
    userId,
    toolSpecs: [toolSpec('read_file'), toolSpec('github_search_repositories')],
  })
  assert.match(revisions.builtinRevision, /^sha256-[a-f0-9]{64}$/u)
  assert.match(revisions.connectorRevision, /^sha256-[a-f0-9]{64}$/u)
  assert.deepEqual(revisions.mcpTools, [])
})

test('MCP config generation changes revision without exposing connection secrets', () => {
  const name = 'mcp__private_server__lookup'
  const firstServer = upsertServer({
    userId,
    name: 'private server',
    transport: 'stdio',
    command: 'node',
    args: ['secret-entry.js'],
    env: { MCP_TOKEN: 'first-private-token' },
    headers: { Authorization: 'Bearer first-private-token' },
    enabled: true,
    tools: {},
  })
  const dispose = registerDynamicTool({
    userId,
    name,
    origin: 'mcp',
    source: `${userId}:${firstServer.id}`,
    spec: toolSpec(name),
  })

  try {
    const first = resolveToolImplementationRevisions({ userId, toolSpecs: [toolSpec(name)] })
    const secondServer = upsertServer({
      id: firstServer.id,
      userId,
      name: 'private server',
      transport: 'stdio',
      command: 'node',
      args: ['secret-entry.js', '--changed'],
      env: { MCP_TOKEN: 'second-private-token' },
      headers: { Authorization: 'Bearer second-private-token' },
      enabled: true,
      tools: {},
    })
    const second = resolveToolImplementationRevisions({ userId, toolSpecs: [toolSpec(name)] })

    assert.ok(secondServer.updatedAt > firstServer.updatedAt)
    assert.notEqual(first.mcpTools[0].revision, second.mcpTools[0].revision)
    const serialized = JSON.stringify([first, second])
    for (const secret of [
      'secret-entry.js',
      'first-private-token',
      'second-private-token',
      '--changed',
      'Authorization',
      'MCP_TOKEN',
    ]) assert.equal(serialized.includes(secret), false)
  } finally {
    dispose()
  }
})
