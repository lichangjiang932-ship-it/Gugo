import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-channel-routes-'))
}

function makeReq({ method = 'GET', url, token = null, body = null }) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method
  req.url = url
  req.headers = {}
  if (token) req.headers.authorization = `Bearer ${token}`
  if (body) req.headers['content-type'] = 'application/json'
  req.on = req.on.bind(req)
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    listeners: new Map(),
    on(event, listener) {
      const listeners = this.listeners.get(event) || []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    },
    emit(event) {
      for (const listener of this.listeners.get(event) || []) listener()
    },
    writeHead(status, headers = {}) {
      this.statusCode = status
      this.headers = headers
    },
    write(chunk) {
      this.chunks.push(Buffer.from(String(chunk)))
    },
    end(chunk = '') {
      if (chunk) this.chunks.push(Buffer.from(String(chunk)))
      this.ended = true
    },
    json() {
      const text = Buffer.concat(this.chunks).toString('utf8')
      return text ? JSON.parse(text) : {}
    },
  }
}

async function call(route, opts) {
  const req = makeReq(opts)
  const res = makeRes()
  res.request = req
  await route(req, res)
  return res
}

async function setup({ useRealModelBinding = false, runSubagentImpl = null } = {}) {
  process.env.APP_DATA_DIR = tmpDir()
  const dbMod = await import('../server/db.js')
  dbMod.closeDb()
  const authMod = await import('../server/adapters/authAccount.js')
  const agentMod = await import('../server/services/agentStore.js')
  const dispatcher = await import('../server/services/channelDispatcher.js')
  const routeMod = await import('../server/routes/channelRoutes.js')
  const calls = []
  dispatcher.configureChannelDispatcherForTests({
    runSubagent: (payload) => {
      calls.push(payload)
      return runSubagentImpl ? runSubagentImpl(payload) : new Promise(() => {})
    },
    ...(!useRealModelBinding ? {
      resolveModelBinding: () => ({
        providerId: 'channel-route-provider',
        modelName: 'channel-route-model',
        configRevision: 1,
      }),
    } : {}),
  })
  const loginAs = (email) => {
    const issued = authMod.issueEmailCode({ email })
    return authMod.verifyEmailCode({ email: issued.email, code: issued.devCode })
  }
  const login1 = loginAs(`route-${Date.now()}-${Math.random()}@example.com`)
  const login2 = loginAs(`route-other-${Date.now()}-${Math.random()}@example.com`)
  const a = agentMod.createAgent({ userId: login1.user.id, name: 'Hanako' })
  const b = agentMod.createAgent({ userId: login1.user.id, name: 'Ming' })
  const c = agentMod.createAgent({ userId: login1.user.id, name: 'Kong' })
  const other = agentMod.createAgent({ userId: login2.user.id, name: 'Other' })
  return {
    route: routeMod.handleChannelRequest,
    token: login1.token,
    userId: login1.user.id,
    agents: { a, b, c, other },
    dispatcher,
    calls,
  }
}

test('channelRoutes: message locale reaches the dispatched agent turn', { concurrency: false }, async () => {
  const { route, token, userId, agents, dispatcher, calls } = await setup({
    runSubagentImpl: async () => ({ resultText: '' }),
  })
  const createRes = await call(route, {
    method: 'POST',
    url: '/api/channels',
    token,
    body: {
      name: 'Localized channel',
      kind: 'group',
      agentIds: [agents.a.id],
      defaultAgentId: agents.a.id,
    },
  })
  const channel = createRes.json().channel

  const postRes = await call(route, {
    method: 'POST',
    url: `/api/channels/${channel.id}/messages`,
    token,
    body: { content: 'continue', locale: 'en' },
  })
  assert.equal(postRes.statusCode, 200)
  await dispatcher.waitForChannelDispatcherIdleForTests({ userId, channelId: channel.id })
  assert.equal(calls[0].locale, 'en')
})

test('channelRoutes: ambiguous model names return a code and an explicit Provider UUID succeeds', { concurrency: false }, async () => {
  const { route, token, userId, agents } = await setup({ useRealModelBinding: true })
  const {
    recordModelProviderReadiness,
    upsertModelProvider,
  } = await import('../server/services/modelProviderStore.js')
  const modelName = `channel-ambiguous-model-${Date.now()}`
  const providers = ['channel-ambiguous-a', 'channel-ambiguous-b'].map((key) => upsertModelProvider({
    userId,
    provider: {
      key,
      label: key,
      baseUrl: `https://${key}.example.test/v1`,
      models: [modelName],
      defaultModel: modelName,
      enabled: true,
    },
  }))
  for (const provider of providers) {
    recordModelProviderReadiness({
      userId,
      id: provider.id,
      readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
    })
  }
  const createRes = await call(route, {
    method: 'POST',
    url: '/api/channels',
    token,
    body: {
      name: 'Provider identity channel',
      kind: 'group',
      agentIds: [agents.a.id],
      defaultAgentId: agents.a.id,
    },
  })
  const channel = createRes.json().channel

  const ambiguous = await call(route, {
    method: 'POST',
    url: `/api/channels/${channel.id}/messages`,
    token,
    body: { content: 'do not choose silently', modelName },
  })
  assert.equal(ambiguous.statusCode, 409)
  assert.equal(ambiguous.json().error.code, 'MODEL_PROVIDER_AMBIGUOUS')
  assert.equal(ambiguous.json().error.action, 'choose_agent_provider')
  assert.equal(ambiguous.json().error.modelName, modelName)
  const afterRejected = await call(route, {
    url: `/api/channels/${channel.id}/messages`,
    token,
  })
  assert.deepEqual(afterRejected.json().messages, [])

  const explicit = await call(route, {
    method: 'POST',
    url: `/api/channels/${channel.id}/messages`,
    token,
    body: {
      content: 'use the selected provider',
      modelName,
      modelProviderId: providers[1].id,
    },
  })
  assert.equal(explicit.statusCode, 200)
  assert.equal(explicit.json().jobIds.length, 1)
})

test('channelRoutes: CRUD routes return 200', { concurrency: false }, async () => {
  const { route, token, agents } = await setup()
  const createRes = await call(route, {
    method: 'POST',
    url: '/api/channels',
    token,
    body: { name: 'Crew', kind: 'group', agentIds: [agents.a.id, agents.b.id], defaultAgentId: agents.a.id },
  })
  assert.equal(createRes.statusCode, 200)
  const channel = createRes.json().channel
  assert.ok(channel.id)

  assert.equal((await call(route, { url: '/api/channels?archived=all', token })).statusCode, 200)
  assert.equal((await call(route, { url: `/api/channels/${channel.id}`, token })).statusCode, 200)

  const patchRes = await call(route, {
    method: 'PATCH',
    url: `/api/channels/${channel.id}`,
    token,
    body: { name: 'Crew v2', defaultAgentId: agents.b.id },
  })
  assert.equal(patchRes.statusCode, 200)
  assert.equal(patchRes.json().channel.name, 'Crew v2')

  const addRes = await call(route, {
    method: 'POST',
    url: `/api/channels/${channel.id}/agents`,
    token,
    body: { agentId: agents.c.id, role: 'member' },
  })
  assert.equal(addRes.statusCode, 200)

  const postMsg = await call(route, {
    method: 'POST',
    url: `/api/channels/${channel.id}/messages`,
    token,
    body: { content: '@Hanako hello' },
  })
  assert.equal(postMsg.statusCode, 200)
  assert.equal(postMsg.json().jobIds.length, 1)

  const listMsg = await call(route, { url: `/api/channels/${channel.id}/messages?limit=50`, token })
  assert.equal(listMsg.statusCode, 200)
  assert.equal(listMsg.json().messages.length, 1)

  const removeRes = await call(route, {
    method: 'DELETE',
    url: `/api/channels/${channel.id}/agents/${agents.c.id}`,
    token,
  })
  assert.equal(removeRes.statusCode, 200)

  const deleteRes = await call(route, { method: 'DELETE', url: `/api/channels/${channel.id}`, token })
  assert.equal(deleteRes.statusCode, 200)
  assert.ok(deleteRes.json().channel.archivedAt)
})

test('channelRoutes: unauthenticated requests return 401', { concurrency: false }, async () => {
  const { route } = await setup()
  const res = await call(route, { url: '/api/channels' })
  assert.equal(res.statusCode, 401)
})

test('channelRoutes: adding an agent outside current user returns 403', { concurrency: false }, async () => {
  const { route, token, agents } = await setup()
  const createRes = await call(route, {
    method: 'POST',
    url: '/api/channels',
    token,
    body: { name: 'Crew', kind: 'group', agentIds: [agents.a.id] },
  })
  const channel = createRes.json().channel
  const bad = await call(route, {
    method: 'POST',
    url: `/api/channels/${channel.id}/agents`,
    token,
    body: { agentId: agents.other.id },
  })
  assert.equal(bad.statusCode, 403)
})

test('channelRoutes: SSE tickets are one-time and bound to one channel', { concurrency: false }, async () => {
  const { route, token, agents } = await setup()
  const firstCreate = await call(route, {
    method: 'POST',
    url: '/api/channels',
    token,
    body: { name: 'First stream', kind: 'group', agentIds: [agents.a.id] },
  })
  const secondCreate = await call(route, {
    method: 'POST',
    url: '/api/channels',
    token,
    body: { name: 'Second stream', kind: 'group', agentIds: [agents.b.id] },
  })
  const firstId = firstCreate.json().channel.id
  const secondId = secondCreate.json().channel.id

  const wrongChannelTicketResponse = await call(route, {
    method: 'POST',
    url: `/api/channels/${firstId}/stream-ticket`,
    token,
  })
  assert.equal(wrongChannelTicketResponse.statusCode, 201)
  const wrongChannelTicket = wrongChannelTicketResponse.json().ticket
  const wrongChannelStream = await call(route, {
    url: `/api/channels/${secondId}/stream?ticket=${encodeURIComponent(wrongChannelTicket)}`,
  })
  assert.equal(wrongChannelStream.statusCode, 401)
  const burnedTicket = await call(route, {
    url: `/api/channels/${firstId}/stream?ticket=${encodeURIComponent(wrongChannelTicket)}`,
  })
  assert.equal(burnedTicket.statusCode, 401)

  const ticketResponse = await call(route, {
    method: 'POST',
    url: `/api/channels/${firstId}/stream-ticket`,
    token,
  })
  assert.equal(ticketResponse.statusCode, 201)
  const body = ticketResponse.json()
  assert.equal(body.ok, true)
  assert.equal(body.expiresIn, 60)
  assert.match(body.ticket, /^st_[a-f0-9]{48}$/)
  assert.equal(body.ticket.includes(token), false)

  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let heartbeat = null
  globalThis.setInterval = (callback, delay) => {
    heartbeat = {
      callback,
      delay,
      unrefCalled: false,
      unref() { this.unrefCalled = true },
    }
    return heartbeat
  }
  globalThis.clearInterval = (timer) => { timer.clearCount = (timer.clearCount || 0) + 1 }
  let stream
  try {
    stream = await call(route, {
      url: `/api/channels/${firstId}/stream?ticket=${encodeURIComponent(body.ticket)}`,
    })
    assert.equal(stream.statusCode, 200)
    assert.equal(stream.headers['Cache-Control'], 'no-cache, no-transform')
    assert.equal(stream.headers['X-Accel-Buffering'], 'no')
    assert.match(Buffer.concat(stream.chunks).toString('utf8'), /event: ready[\s\S]*"channelId"/)
    assert.equal(heartbeat.delay, 15_000)
    assert.equal(heartbeat.unrefCalled, true)
    heartbeat.callback()
    assert.match(Buffer.concat(stream.chunks).toString('utf8'), /: keep-alive\n\n/)

    stream.request.emit('close')
    stream.emit('close')
    assert.equal(heartbeat.clearCount, 1)
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }

  const replay = await call(route, {
    url: `/api/channels/${firstId}/stream?ticket=${encodeURIComponent(body.ticket)}`,
  })
  assert.equal(replay.statusCode, 401)
  const durableTokenQuery = await call(route, {
    url: `/api/channels/${firstId}/stream?token=${encodeURIComponent(token)}`,
  })
  assert.equal(durableTokenQuery.statusCode, 401)
})

test('channelRoutes: stream-ticket issuance authenticates and hides missing channels', { concurrency: false }, async () => {
  const { route, token } = await setup()
  const unauthenticated = await call(route, {
    method: 'POST',
    url: '/api/channels/missing/stream-ticket',
  })
  assert.equal(unauthenticated.statusCode, 401)

  const missing = await call(route, {
    method: 'POST',
    url: '/api/channels/missing/stream-ticket',
    token,
  })
  assert.equal(missing.statusCode, 404)
})
