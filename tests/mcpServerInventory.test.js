import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-mcp-inventory-'))
const previousDataDir = process.env.APP_DATA_DIR
process.env.APP_DATA_DIR = tempDir

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { listMcpServerInventory, upsertServer } = await import('../server/mcp/mcpStore.js')

test.after(() => {
  closeDb()
  if (previousDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('MCP inventory is tenant-isolated and never returns connection secrets', () => {
  createUser({ id: 'inventory-alice', email: 'inventory-alice@example.com' })
  createUser({ id: 'inventory-bob', email: 'inventory-bob@example.com' })
  const secret = 'mcp-secret-must-not-leak'

  upsertServer({
    id: 'alice-private-server',
    userId: 'inventory-alice',
    name: 'Alice private server',
    transport: 'stdio',
    command: `run-${secret}`,
    args: ['--token', secret],
    env: { SECRET_TOKEN: secret },
    cwd: `C:\\${secret}`,
    url: `https://${secret}.example`,
    headers: { Authorization: `Bearer ${secret}` },
    enabled: true,
    autoApprove: ['private_tool'],
    tools: { private_tool: { riskLevel: 'high', requiresApproval: true } },
  })
  upsertServer({
    id: 'bob-private-server',
    userId: 'inventory-bob',
    name: 'Bob private server',
    transport: 'http',
    url: `https://bob-${secret}.example`,
    headers: { Authorization: `Bearer ${secret}` },
    enabled: false,
  })

  const legacyEnv = Buffer.from(JSON.stringify({ SECRET_TOKEN: secret }), 'utf8').toString('base64')
  const legacyHeaders = Buffer.from(JSON.stringify({ Authorization: `Bearer ${secret}` }), 'utf8').toString('base64')
  getDb().prepare('UPDATE mcp_servers SET env_json = ?, headers_json = ? WHERE id = ?')
    .run(legacyEnv, legacyHeaders, 'alice-private-server')

  const alice = listMcpServerInventory('inventory-alice')
  assert.equal(Object.isFrozen(alice), true)
  assert.deepEqual(alice.map((entry) => entry.id), ['alice-private-server'])
  assert.deepEqual(Object.keys(alice[0]).sort(), ['enabled', 'id', 'name', 'transport', 'updatedAt'])
  assert.equal(Object.isFrozen(alice[0]), true)
  assert.equal(alice[0].transport, 'stdio')
  assert.equal(alice[0].enabled, true)
  assert.equal(Number.isFinite(alice[0].updatedAt), true)
  for (const forbidden of ['args', 'command', 'env', 'headers', 'url', 'userId']) {
    assert.equal(Object.hasOwn(alice[0], forbidden), false)
  }
  assert.doesNotMatch(JSON.stringify(alice), new RegExp(secret, 'u'))
  assert.deepEqual(
    getDb().prepare('SELECT env_json, headers_json FROM mcp_servers WHERE id = ?')
      .get('alice-private-server'),
    { env_json: legacyEnv, headers_json: legacyHeaders },
  )

  const bob = listMcpServerInventory('inventory-bob')
  assert.deepEqual(bob.map((entry) => entry.id), ['bob-private-server'])
  assert.deepEqual(listMcpServerInventory('missing-user'), [])
  assert.deepEqual(listMcpServerInventory(''), [])
})
