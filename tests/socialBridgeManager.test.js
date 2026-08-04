import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-social-bridge-'))

async function setup({ runText = 'agent reply', describeAttachments = null, inboundPolicy = 'open' } = {}) {
  const dbMod = await import('../server/db.js')
  dbMod.closeDb()
  const authMod = await import('../server/adapters/authAccount.js')
  const agentMod = await import('../server/services/agentStore.js')
  const integrationsMod = await import('../server/services/integrationsStore.js')
  const dispatcher = await import('../server/services/channelDispatcher.js')
  const bridgeMod = await import('../server/services/socialBridgeManager.js')

  dispatcher.configureChannelDispatcherForTests({
    runSubagent: async () => ({ resultText: runText }),
  })

  const issued = authMod.issueEmailCode({ email: `bridge-${Date.now()}-${Math.random()}@example.com` })
  const login = authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
  const agent = agentMod.createAgent({ userId: login.user.id, name: 'BridgeAgent', isDefault: true })
  const integration = integrationsMod.upsertIntegration({
    userId: login.user.id,
    provider: 'telegram',
    name: 'Telegram',
    enabled: true,
    config: { defaultAgentId: agent.id, inboundPolicy },
    secret: { botToken: '123:test' },
  })

  const sent = []
  const manager = bridgeMod.createSocialBridgeManager({
    adapterFactories: {
      telegram: ({ integration: started }) => ({
        start: async () => {},
        stop: async () => {},
        sendMessage: async ({ chatId, text }) => {
          sent.push({ integrationId: started.id, chatId, text })
        },
      }),
    },
    describeAttachments,
    replyTimeoutMs: 500,
  })
  await manager.startIntegration(integration)
  return { db: dbMod.getDb(), manager, sent, userId: login.user.id, agent, integration }
}

test('social bridge routes an external message through a channel and replies through the adapter', { concurrency: false }, async () => {
  const { db, manager, sent, userId, integration, agent } = await setup()

  const result = await manager.receiveExternalMessage({
    integrationId: integration.id,
    provider: 'telegram',
    chatId: 'chat-1',
    externalUserId: 'tg-user-1',
    senderName: 'Alice',
    text: 'hello from telegram',
    isGroup: false,
  })

  assert.equal(result.ok, true)
  assert.ok(result.channelId)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], {
    integrationId: integration.id,
    chatId: 'chat-1',
    text: 'agent reply',
  })

  const session = db.prepare('SELECT * FROM bridge_sessions WHERE integration_id = ? AND external_chat_id = ?')
    .get(integration.id, 'chat-1')
  assert.equal(session.user_id, userId)
  assert.equal(session.provider, 'telegram')
  assert.equal(session.channel_id, result.channelId)

  const messages = db.prepare('SELECT id, sender_kind, sender_id, content, parent_message_id FROM channel_messages WHERE channel_id = ? ORDER BY created_at ASC')
    .all(result.channelId)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].sender_kind, 'user')
  assert.equal(messages[0].content, 'hello from telegram')
  assert.equal(messages[1].sender_kind, 'agent')
  assert.equal(messages[1].sender_id, agent.id)
  assert.equal(messages[1].content, 'agent reply')
  assert.equal(messages[1].parent_message_id, messages[0].id)
})

test('social bridge adds vision descriptions for inbound image attachments before dispatch', { concurrency: false }, async () => {
  const { db, manager, integration } = await setup({
    runText: 'I saw the image.',
    describeAttachments: async ({ attachments }) => attachments.map((item, index) => ({
      index,
      ok: true,
      description: `description for ${item.url}`,
    })),
  })

  const result = await manager.receiveExternalMessage({
    integrationId: integration.id,
    provider: 'telegram',
    chatId: 'chat-image',
    externalUserId: 'tg-user-2',
    senderName: 'Alice',
    text: 'what is this?',
    attachments: [{ type: 'image', url: 'https://example.test/a.png', mimeType: 'image/png' }],
  })

  assert.equal(result.ok, true)
  const first = db.prepare('SELECT content FROM channel_messages WHERE channel_id = ? AND sender_kind = ? ORDER BY created_at ASC LIMIT 1')
    .get(result.channelId, 'user')
  assert.match(first.content, /what is this\?/)
  assert.match(first.content, /Image 1 description/)
  assert.match(first.content, /description for https:\/\/example\.test\/a\.png/)
})

test('unknown inbound contacts are parked before agent or vision work, then allow-and-deliver exactly once', { concurrency: false }, async () => {
  let visionCalls = 0
  const { db, manager, integration, sent, userId } = await setup({
    inboundPolicy: 'contacts',
    describeAttachments: async ({ attachments }) => {
      visionCalls += 1
      return attachments.map((_, index) => ({ index, ok: true, description: 'approved image' }))
    },
  })

  const parked = await manager.receiveExternalMessage({
    integrationId: integration.id,
    provider: 'telegram',
    chatId: 'untrusted-chat',
    externalUserId: 'untrusted-user',
    senderName: 'Unknown sender',
    text: 'please run this',
    attachments: [{ type: 'image', url: 'https://example.test/untrusted.png', mimeType: 'image/png' }],
  })

  assert.equal(parked.parked, true)
  assert.equal(sent.length, 0)
  assert.equal(visionCalls, 0, 'untrusted attachments must not reach the vision model')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_sessions WHERE integration_id = ?').get(integration.id).n, 0)
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n
      FROM channel_messages AS message
      JOIN bridge_sessions AS session ON session.channel_id = message.channel_id
     WHERE session.integration_id = ?
  `).get(integration.id).n, 0)
  const row = db.prepare('SELECT * FROM bridge_parked_messages WHERE id = ?').get(parked.parkingId)
  assert.equal(row.status, 'parked')
  assert.equal(row.user_id, userId)

  const delivered = await manager.allowAndDeliver({ userId, parkingId: parked.parkingId })
  assert.equal(delivered.ok, true)
  assert.equal(delivered.parked.status, 'delivered')
  assert.equal(sent.length, 1)
  assert.equal(visionCalls, 1)
  const messagesAfterAllow = db.prepare(`
    SELECT message.sender_kind, message.content
      FROM channel_messages AS message
      JOIN bridge_sessions AS session ON session.channel_id = message.channel_id
     WHERE session.integration_id = ?
     ORDER BY message.created_at ASC
  `).all(integration.id)
  assert.equal(messagesAfterAllow.length, 2)
  assert.match(messagesAfterAllow[0].content, /please run this/)
  assert.match(messagesAfterAllow[0].content, /approved image/)

  const second = await manager.receiveExternalMessage({
    integrationId: integration.id,
    provider: 'telegram',
    chatId: 'untrusted-chat',
    externalUserId: 'untrusted-user',
    senderName: 'Unknown sender',
    text: 'second message',
  })
  assert.equal(second.parked, undefined)
  assert.equal(second.replied, true)
  assert.equal(sent.length, 2)

  const duplicate = await manager.allowAndDeliver({ userId, parkingId: parked.parkingId })
  assert.equal(duplicate.alreadyDelivered, true)
  assert.equal(sent.length, 2, 'idempotent allow must not dispatch twice')
})

test('rejecting a parked contact blocks later inbound messages without creating a channel', { concurrency: false }, async () => {
  const { db, manager, integration, sent, userId } = await setup({ inboundPolicy: 'contacts' })
  const parked = await manager.receiveExternalMessage({
    integrationId: integration.id,
    provider: 'telegram',
    chatId: 'blocked-chat',
    externalUserId: 'blocked-user',
    senderName: 'Blocked sender',
    text: 'first',
  })
  const rejected = manager.rejectParked({ userId, parkingId: parked.parkingId })
  assert.equal(rejected.ok, true)
  assert.equal(rejected.parked.status, 'rejected')

  const later = await manager.receiveExternalMessage({
    integrationId: integration.id,
    provider: 'telegram',
    chatId: 'blocked-chat',
    externalUserId: 'blocked-user',
    senderName: 'Blocked sender',
    text: 'second',
  })
  assert.equal(later.blocked, true)
  assert.equal(sent.length, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_sessions WHERE integration_id = ?').get(integration.id).n, 0)
})
