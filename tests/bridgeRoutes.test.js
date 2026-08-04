import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createHmac, createPrivateKey, sign } from 'node:crypto'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-bridge-routes-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function qqPrivateKey(secret) {
  let seedText = secret
  while (Buffer.byteLength(seedText, 'utf8') < 32) seedText += seedText
  return createPrivateKey({
    key: Buffer.concat([ED25519_SEED_PREFIX, Buffer.from(seedText, 'utf8').subarray(0, 32)]),
    format: 'der',
    type: 'pkcs8',
  })
}

function makeReq({ method = 'GET', url, body = null, token = null, headers = {} }) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
  req.method = method
  req.url = url
  req.headers = { ...headers }
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

test.after(async () => {
  const { closeDb } = await import('../server/db.js')
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('bridge route returns Feishu URL verification challenge', async () => {
  const routeMod = await import('../server/routes/bridgeRoutes.js')
  const route = routeMod.createBridgeRequestHandler({
    manager: { receiveExternalMessage: async () => ({ ok: true }) },
    getIntegration: () => ({
      id: 'int-1',
      provider: 'feishu',
      enabled: true,
      secret: { verificationToken: 'verify-feishu' },
    }),
  })

  const res = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/feishu/int-1',
    body: { type: 'url_verification', challenge: 'challenge-token', token: 'verify-feishu' },
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { challenge: 'challenge-token' })
})

test('bridge route normalizes Telegram webhook messages', async () => {
  const calls = []
  const routeMod = await import('../server/routes/bridgeRoutes.js')
  const route = routeMod.createBridgeRequestHandler({
    getIntegration: () => ({
      id: 'int-telegram',
      provider: 'telegram',
      enabled: true,
      secret: { webhookSecret: 'telegram-webhook-secret' },
    }),
    manager: {
      receiveExternalMessage: async (message) => {
        calls.push(message)
        return { ok: true, channelId: 'channel-1' }
      },
    },
  })

  const res = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/telegram/int-telegram',
    headers: { 'x-telegram-bot-api-secret-token': 'telegram-webhook-secret' },
    body: {
      message: {
        message_id: 10,
        chat: { id: 123, type: 'private' },
        from: { id: 42, first_name: 'Alice' },
        text: 'hello',
      },
    },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    integrationId: 'int-telegram',
    provider: 'telegram',
    chatId: '123',
    externalUserId: '42',
    senderName: 'Alice',
    text: 'hello',
    isGroup: false,
    attachments: [],
    raw: calls[0].raw,
  })
})

test('bridge route rejects unsigned webhooks before dispatch', async () => {
  let deliveries = 0
  let starts = 0
  const routeMod = await import('../server/routes/bridgeRoutes.js')
  const route = routeMod.createBridgeRequestHandler({
    getIntegration: () => ({
      id: 'int-telegram',
      provider: 'telegram',
      enabled: true,
      secret: { webhookSecret: 'telegram-webhook-secret' },
    }),
    manager: {
      startIntegration: async () => { starts += 1 },
      receiveExternalMessage: async () => { deliveries += 1 },
    },
  })

  const res = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/telegram/int-telegram',
    body: { message: { chat: { id: 123 }, from: { id: 42 }, text: 'forged' } },
  })

  assert.equal(res.statusCode, 401)
  assert.equal(deliveries, 0)
  assert.equal(starts, 0)
})

test('bridge route does not echo an unauthenticated Feishu challenge', async () => {
  const routeMod = await import('../server/routes/bridgeRoutes.js')
  const route = routeMod.createBridgeRequestHandler({
    getIntegration: () => ({
      id: 'int-1',
      provider: 'feishu',
      enabled: true,
      secret: { verificationToken: 'verify-feishu' },
    }),
  })

  const res = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/feishu/int-1',
    body: { type: 'url_verification', challenge: 'do-not-echo', token: 'wrong' },
  })

  assert.equal(res.statusCode, 401)
  assert.notEqual(res.json().challenge, 'do-not-echo')
})

test('bridge route verifies QQ Ed25519 signatures before dispatch', async () => {
  const secret = 'qq-app-secret'
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = {
    d: {
      id: 'message-1',
      user_openid: 'user-1',
      content: 'signed hello',
    },
  }
  const raw = JSON.stringify(body)
  const signature = sign(
    null,
    Buffer.from(`${timestamp}${raw}`, 'utf8'),
    qqPrivateKey(secret),
  ).toString('hex')
  const calls = []
  const routeMod = await import('../server/routes/bridgeRoutes.js')
  const route = routeMod.createBridgeRequestHandler({
    getIntegration: () => ({
      id: 'int-qq',
      provider: 'qq',
      enabled: true,
      secret: { appSecret: secret },
    }),
    manager: {
      receiveExternalMessage: async (message) => {
        calls.push(message)
        return { ok: true }
      },
    },
  })

  const res = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/qq/int-qq',
    headers: {
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signature,
    },
    body,
  })

  assert.equal(res.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, 'signed hello')
})

test('custom HMAC webhooks require a fresh signed timestamp and reject replay', async () => {
  const secret = 'generic-webhook-signing-secret'
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = {
    chatId: 'chat-1',
    userId: 'external-user-1',
    text: 'signed payload',
  }
  const raw = JSON.stringify(body)
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${raw}`)
    .digest('hex')
  let deliveries = 0
  const routeMod = await import('../server/routes/bridgeRoutes.js')
  const route = routeMod.createBridgeRequestHandler({
    getIntegration: () => ({
      id: 'int-webhook',
      provider: 'webhook',
      enabled: true,
      secret: { signingSecret: secret },
    }),
    manager: {
      receiveExternalMessage: async () => {
        deliveries += 1
        return { ok: true }
      },
    },
  })

  const unsignedTimestamp = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/webhook/int-webhook',
    headers: { 'x-gugo-signature': signature },
    body,
  })
  assert.equal(unsignedTimestamp.statusCode, 401)

  const headers = {
    'x-gugo-timestamp': timestamp,
    'x-gugo-signature': `sha256=${signature}`,
  }
  const accepted = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/webhook/int-webhook',
    headers,
    body,
  })
  assert.equal(accepted.statusCode, 200)
  assert.equal(deliveries, 1)

  const replayed = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/webhook/int-webhook',
    headers,
    body,
  })
  assert.equal(replayed.statusCode, 409)
  assert.equal(replayed.json().code, 'WEBHOOK_REPLAYED')
  assert.equal(deliveries, 1)

  const expiredTimestamp = String(Math.floor((Date.now() - 6 * 60 * 1000) / 1000))
  const expiredSignature = createHmac('sha256', secret)
    .update(`${expiredTimestamp}.${raw}`)
    .digest('hex')
  const expired = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/webhook/int-webhook',
    headers: {
      'x-gugo-timestamp': expiredTimestamp,
      'x-gugo-signature': expiredSignature,
    },
    body,
  })
  assert.equal(expired.statusCode, 401)
  assert.equal(expired.json().code, 'WEBHOOK_TIMESTAMP_EXPIRED')
})

test('bridge route preserves the WeChat iLink unavailable error code', async () => {
  const routeMod = await import('../server/routes/bridgeRoutes.js')
  const route = routeMod.createBridgeRequestHandler({
    authenticate: () => 'user-1',
    getWechatQrcode: async () => {
      throw Object.assign(new Error('WeChat iLink service is unavailable'), {
        code: 'WECHAT_ILINK_UNAVAILABLE',
        statusCode: 503,
      })
    },
  })

  const res = await call(route, {
    method: 'GET',
    url: '/api/bridge/wechat/qrcode',
  })

  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.json(), {
    ok: false,
    error: 'WeChat iLink service is unavailable',
    code: 'WECHAT_ILINK_UNAVAILABLE',
  })
})
