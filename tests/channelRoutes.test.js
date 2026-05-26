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
  await route(req, res)
  return res
}

async function setup() {
  process.env.APP_DATA_DIR = tmpDir()
  const dbMod = await import('../server/db.js')
  dbMod.closeDb()
  const authMod = await import('../server/adapters/billingAuth.js')
  const agentMod = await import('../server/services/agentStore.js')
  const dispatcher = await import('../server/services/channelDispatcher.js')
  const routeMod = await import('../server/routes/channelRoutes.js')
  dispatcher.configureChannelDispatcherForTests({
    runSubagent: () => new Promise(() => {}),
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
  }
}

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
