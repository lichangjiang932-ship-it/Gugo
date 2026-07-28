import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

function makeReq({ method = 'GET', url, body = null, token = null }) {
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

test('bridge route returns Feishu URL verification challenge', async () => {
  const routeMod = await import('../server/routes/bridgeRoutes.js')
  const route = routeMod.createBridgeRequestHandler({
    manager: { receiveExternalMessage: async () => ({ ok: true }) },
  })

  const res = await call(route, {
    method: 'POST',
    url: '/api/bridge/webhook/feishu/int-1',
    body: { type: 'url_verification', challenge: 'challenge-token' },
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { challenge: 'challenge-token' })
})

test('bridge route normalizes Telegram webhook messages', async () => {
  const calls = []
  const routeMod = await import('../server/routes/bridgeRoutes.js')
  const route = routeMod.createBridgeRequestHandler({
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
