import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-channel-dispatcher-'))
}

async function setup({ runSubagent } = {}) {
  process.env.APP_DATA_DIR = tmpDir()
  const dbMod = await import('../server/db.js')
  dbMod.closeDb()
  const authMod = await import('../server/adapters/authAccount.js')
  const agentMod = await import('../server/services/agentStore.js')
  const store = await import('../server/services/channelStore.js')
  const dispatcher = await import('../server/services/channelDispatcher.js')
  const issued = authMod.issueEmailCode({ email: `dispatcher-${Date.now()}-${Math.random()}@example.com` })
  const login = authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
  const userId = login.user.id
  const hanako = agentMod.createAgent({ userId, name: 'Hanako' })
  const ming = agentMod.createAgent({ userId, name: 'Ming' })
  const calls = []
  dispatcher.configureChannelDispatcherForTests({
    resolveModelBinding: ({ providerId, modelName, configRevision }) => ({
      providerId: providerId || 'channel-provider',
      modelName: modelName || 'channel-model',
      configRevision: configRevision || 7,
    }),
    runSubagent: (payload) => {
      calls.push(payload)
      return runSubagent ? runSubagent(payload) : new Promise(() => {})
    },
  })
  return { userId, agents: { hanako, ming }, store, dispatcher, calls }
}

test('dispatchUserMessage: mentions create N jobs', { concurrency: false }, async () => {
  const releases = []
  const { userId, agents, store, dispatcher, calls } = await setup({
    runSubagent: () => new Promise((resolve) => releases.push(resolve)),
  })
  const channel = store.createChannel({
    userId,
    name: 'Crew',
    kind: 'group',
    agentIds: [agents.hanako.id, agents.ming.id],
  })
  const result = await dispatcher.dispatchUserMessage(channel.id, userId, '@Hanako @Ming help')
  assert.equal(result.jobIds.length, 2)
  assert.equal(calls.length, 1)
  releases[0]({ resultText: '' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2)
  releases[1]({ resultText: '' })
  await dispatcher.waitForChannelDispatcherIdleForTests({ userId, channelId: channel.id })
})

test('dispatchUserMessage: one channel preserves turn and reply order', { concurrency: false }, async () => {
  const releases = []
  const { userId, agents, store, dispatcher, calls } = await setup({
    runSubagent: () => new Promise((resolve) => releases.push(resolve)),
  })
  const channel = store.createChannel({
    userId,
    name: 'Ordered Crew',
    kind: 'group',
    agentIds: [agents.hanako.id],
    defaultAgentId: agents.hanako.id,
  })

  const [first, second] = await Promise.all([
    dispatcher.dispatchUserMessage(channel.id, userId, 'first request'),
    dispatcher.dispatchUserMessage(channel.id, userId, 'second request'),
  ])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].parentMessageId, first.messageId)
  assert.doesNotMatch(calls[0].prompt, /second request/)

  releases[0]({ resultText: 'first reply' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2)
  assert.equal(calls[1].parentMessageId, second.messageId)
  assert.match(calls[1].prompt, /first reply/)

  releases[1]({ resultText: '' })
  await dispatcher.waitForChannelDispatcherIdleForTests({ userId, channelId: channel.id })
})

test('dispatchUserMessage: a failed queued turn does not block the next turn', { concurrency: false }, async () => {
  let callCount = 0
  const { userId, agents, store, dispatcher, calls } = await setup({
    runSubagent: async () => {
      callCount += 1
      if (callCount === 1) throw new Error('first turn failed')
      return { resultText: '' }
    },
  })
  const channel = store.createChannel({
    userId,
    name: 'Resilient Crew',
    kind: 'group',
    agentIds: [agents.ming.id],
    defaultAgentId: agents.ming.id,
  })

  await Promise.all([
    dispatcher.dispatchUserMessage(channel.id, userId, 'will fail'),
    dispatcher.dispatchUserMessage(channel.id, userId, 'must still run'),
  ])
  await dispatcher.waitForChannelDispatcherIdleForTests({ userId, channelId: channel.id })
  assert.equal(calls.length, 2)
  assert.match(calls[1].prompt, /must still run/)
})

test('dispatchUserMessage: no mention routes to default agent', { concurrency: false }, async () => {
  const { userId, agents, store, dispatcher, calls } = await setup()
  const channel = store.createChannel({
    userId,
    name: 'Crew',
    kind: 'group',
    agentIds: [agents.hanako.id, agents.ming.id],
    defaultAgentId: agents.ming.id,
  })
  const result = await dispatcher.dispatchUserMessage(channel.id, userId, 'hello')
  assert.equal(result.jobIds.length, 1)
  assert.equal(calls[0].parentSessionId, `channel:${channel.id}`)
  assert.equal(calls[0].modelName, 'channel-model')
  assert.equal(calls[0].modelProviderId, 'channel-provider')
  assert.equal(calls[0].modelConfigRevision, 7)
  assert.match(calls[0].prompt, /Ming/)
})

test('dispatchUserMessage: selected model binding is snapshotted before a queued turn runs', { concurrency: false }, async () => {
  const releases = []
  const { userId, agents, store, dispatcher, calls } = await setup({
    runSubagent: () => new Promise((resolve) => releases.push(resolve)),
  })
  const channel = store.createChannel({
    userId,
    name: 'Pinned Crew',
    kind: 'group',
    agentIds: [agents.hanako.id],
    defaultAgentId: agents.hanako.id,
  })

  await dispatcher.dispatchUserMessage({
    channelId: channel.id,
    userId,
    text: 'use the selected model',
    modelName: 'selected-model',
    modelProviderId: 'selected-provider',
    modelConfigRevision: 11,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].modelName, 'selected-model')
  assert.equal(calls[0].modelProviderId, 'selected-provider')
  assert.equal(calls[0].modelConfigRevision, 11)
  releases[0]({ resultText: '' })
  await dispatcher.waitForChannelDispatcherIdleForTests({ userId, channelId: channel.id })
})

test('dispatchUserMessage: no default routes to most recent speaking agent', { concurrency: false }, async () => {
  const { userId, agents, store, dispatcher, calls } = await setup()
  const channel = store.createChannel({
    userId,
    name: 'Crew',
    kind: 'group',
    agentIds: [agents.hanako.id, agents.ming.id],
  })
  store.appendMessage({
    userId,
    channelId: channel.id,
    senderKind: 'agent',
    senderId: agents.hanako.id,
    content: 'last speaker',
  })
  const result = await dispatcher.dispatchUserMessage(channel.id, userId, 'no mention')
  assert.equal(result.jobIds.length, 1)
  assert.match(calls[0].prompt, /Hanako/)
})

test('dispatchUserMessage: channel with no agents has no routable target', { concurrency: false }, async () => {
  const { userId, store, dispatcher, calls } = await setup()
  const channel = store.createChannel({ userId, name: 'Empty', kind: 'group', agentIds: [] })
  const result = await dispatcher.dispatchUserMessage(channel.id, userId, 'hello')
  assert.deepEqual(result.jobIds, [])
  assert.equal(calls.length, 0)
})

test('dispatchAgentMessage: skips self-mention', { concurrency: false }, async () => {
  const { userId, agents, store, dispatcher, calls } = await setup()
  const channel = store.createChannel({ userId, name: 'Crew', kind: 'group', agentIds: [agents.hanako.id, agents.ming.id] })
  const msg = store.appendMessage({
    userId,
    channelId: channel.id,
    senderKind: 'agent',
    senderId: agents.hanako.id,
    content: '@Hanako self',
  })
  const result = await dispatcher.dispatchAgentMessage(channel.id, agents.hanako.id, '@Hanako self', { parentMessageId: msg.id })
  assert.deepEqual(result.jobIds, [])
  assert.equal(calls.length, 0)
})

test('dispatchAgentMessage: chain depth greater than 3 is rejected', { concurrency: false }, async () => {
  const { userId, agents, store, dispatcher, calls } = await setup()
  const channel = store.createChannel({ userId, name: 'Crew', kind: 'group', agentIds: [agents.hanako.id, agents.ming.id] })
  const root = store.appendMessage({ userId, channelId: channel.id, senderKind: 'user', senderId: userId, content: 'root' })
  const a = store.appendMessage({ userId, channelId: channel.id, senderKind: 'agent', senderId: agents.hanako.id, content: 'a', parentMessageId: root.id })
  const b = store.appendMessage({ userId, channelId: channel.id, senderKind: 'agent', senderId: agents.ming.id, content: 'b', parentMessageId: a.id })
  const c = store.appendMessage({ userId, channelId: channel.id, senderKind: 'agent', senderId: agents.hanako.id, content: '@Ming c', parentMessageId: b.id })
  const result = await dispatcher.dispatchAgentMessage(channel.id, agents.hanako.id, '@Ming c', { parentMessageId: c.id })
  assert.deepEqual(result.jobIds, [])
  assert.equal(result.rejected, 'max_depth')
  assert.equal(calls.length, 0)
})
