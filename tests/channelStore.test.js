import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-channel-store-'))
}

async function setup() {
  const dir = tmpDir()
  process.env.APP_DATA_DIR = dir
  const dbMod = await import('../server/db.js')
  dbMod.closeDb()
  const authMod = await import('../server/adapters/authAccount.js')
  const agentMod = await import('../server/services/agentStore.js')
  const store = await import('../server/services/channelStore.js')
  const issued = authMod.issueEmailCode({ email: `store-${Date.now()}-${Math.random()}@example.com` })
  const login = authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
  const userId = login.user.id
  const a = agentMod.createAgent({ userId, name: 'Hanako' })
  const b = agentMod.createAgent({ userId, name: 'Ming' })
  return { dir, dbMod, userId, agents: [a, b], store }
}

test('channelStore: CRUD channel', { concurrency: false }, async () => {
  const { userId, agents, store } = await setup()
  const channel = store.createChannel({
    userId,
    name: 'Crew',
    kind: 'group',
    agentIds: agents.map((agent) => agent.id),
    defaultAgentId: agents[0].id,
  })
  assert.equal(channel.name, 'Crew')
  assert.equal(channel.agents.length, 2)
  assert.equal(channel.defaultAgentId, agents[0].id)

  const listed = store.listChannels({ userId, archived: 'all' })
  assert.equal(listed.length, 1)
  assert.equal(store.getChannel({ userId, channelId: channel.id }).id, channel.id)

  const updated = store.updateChannel({ userId, channelId: channel.id, patch: { name: 'Crew 2', archived: true } })
  assert.equal(updated.name, 'Crew 2')
  assert.ok(updated.archivedAt)

  const active = store.listChannels({ userId, archived: 'false' })
  assert.equal(active.length, 0)
})

test('channelStore: addAgent / removeAgent', { concurrency: false }, async () => {
  const { userId, agents, store } = await setup()
  const channel = store.createChannel({ userId, name: 'Crew', kind: 'group', agentIds: [agents[0].id] })
  const added = store.addAgentToChannel({ userId, channelId: channel.id, agentId: agents[1].id, role: 'owner' })
  assert.deepEqual(added.agents.map((agent) => agent.id).sort(), [agents[0].id, agents[1].id].sort())
  assert.equal(added.agents.find((agent) => agent.id === agents[1].id).role, 'owner')

  const removed = store.removeAgentFromChannel({ userId, channelId: channel.id, agentId: agents[0].id })
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.channel.agents.map((agent) => agent.id), [agents[1].id])
})

test('channelStore: appendMessage / listMessages', { concurrency: false }, async () => {
  const { userId, agents, store } = await setup()
  const channel = store.createChannel({ userId, name: 'Crew', kind: 'group', agentIds: [agents[0].id] })
  const userMsg = store.appendMessage({
    userId,
    channelId: channel.id,
    senderKind: 'user',
    senderId: userId,
    content: '@Hanako hi',
    mentions: [agents[0].id],
    now: 100,
  })
  const agentMsg = store.appendMessage({
    userId,
    channelId: channel.id,
    senderKind: 'agent',
    senderId: agents[0].id,
    content: 'hello',
    parentMessageId: userMsg.id,
    now: 101,
  })

  const messages = store.listMessages({ userId, channelId: channel.id, limit: 10 })
  assert.equal(messages.length, 2)
  assert.equal(messages[0].mentions[0], agents[0].id)
  assert.equal(messages[1].id, agentMsg.id)
  assert.equal(store.getMessageDepth({ userId, channelId: channel.id, messageId: agentMsg.id }), 1)
})
