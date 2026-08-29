import test from 'node:test'
import assert from 'node:assert/strict'

import { createFeishuBridgeAdapter } from '../server/adapters/social/feishuBridge.js'
import { createQQBridgeAdapter } from '../server/adapters/social/qqBridge.js'
import {
  _telegramInternals,
  createTelegramBridgeAdapter,
} from '../server/adapters/social/telegramBridge.js'

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }]

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('Telegram inbound attachments retain only opaque file references', () => {
  const message = _telegramInternals.normalizeUpdate({
    message: {
      chat: { id: 42, type: 'private' },
      from: { id: 7, username: 'alice' },
      caption: 'photo',
      photo: [
        { file_id: 'small-file', width: 80, height: 80 },
        { file_id: 'large-file', width: 800, height: 600, file_size: 1234 },
      ],
      document: {
        file_id: 'document-file',
        file_name: 'notes.txt',
        mime_type: 'text/plain',
        file_size: 20,
      },
    },
  })

  assert.equal(message.attachments.length, 2)
  assert.deepEqual(message.attachments.map(({ platformRef }) => platformRef), ['large-file', 'document-file'])
  assert.equal(message.attachments.some((attachment) => 'url' in attachment), false)
})

test('Telegram bot tokens are blocked before a private-DNS request is sent', async () => {
  let fetchCalls = 0
  const adapter = createTelegramBridgeAdapter({
    integration: { secret: { botToken: '123:private-dns-token' } },
    lookup: async () => [{ address: '10.20.30.40', family: 4 }],
    fetchImpl: async () => {
      fetchCalls += 1
      return jsonResponse({ ok: true, result: {} })
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'telegram-user', text: 'hello' }),
    (error) => error?.code === 'TELEGRAM_BRIDGE_UNAVAILABLE'
      && error?.cause?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(fetchCalls, 0)
})

test('Telegram bot tokens are not forwarded across cross-origin redirects', async () => {
  const requests = []
  const adapter = createTelegramBridgeAdapter({
    integration: { secret: { botToken: '123:redirect-token' } },
    lookup: PUBLIC_DNS,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init })
      return new Response(null, {
        status: 307,
        headers: { location: 'https://credential-thief.example.test/telegram' },
      })
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'telegram-user', text: 'hello' }),
    (error) => error?.code === 'TELEGRAM_BRIDGE_UNAVAILABLE'
      && error?.cause?.code === 'OUTBOUND_REDIRECT_CROSS_ORIGIN',
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.redirect, 'manual')
  assert.equal(requests.some(({ url }) => url.includes('credential-thief.example.test')), false)
})

test('Telegram images are resolved to bounded inline data without exposing the bot token', async () => {
  const requests = []
  const adapter = createTelegramBridgeAdapter({
    integration: { secret: { botToken: '123:attachment-token' } },
    lookup: PUBLIC_DNS,
    fetchImpl: async (url) => {
      const value = String(url)
      requests.push(value)
      if (value.includes('/getFile?')) {
        return jsonResponse({ ok: true, result: { file_path: 'photos/file 1.jpg' } })
      }
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '4' },
      })
    },
  })

  const resolved = await adapter.resolveAttachment({
    type: 'image',
    platformRef: 'telegram-file-id',
    mimeType: 'image/jpeg',
  })
  assert.equal(resolved.url, 'data:image/jpeg;base64,/9j/2Q==')
  assert.equal(resolved.url.includes('attachment-token'), false)
  assert.equal(requests.length, 2)
  assert.match(requests[1], /photos\/file%201\.jpg$/)
})

test('Telegram image materialization rejects declared oversized bodies', async () => {
  const adapter = createTelegramBridgeAdapter({
    integration: { secret: { botToken: '123:size-token' } },
    lookup: PUBLIC_DNS,
    fetchImpl: async (url) => String(url).includes('/getFile?')
      ? jsonResponse({ ok: true, result: { file_path: 'photos/large.jpg' } })
      : new Response('x', {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(10 * 1024 * 1024 + 1) },
        }),
  })

  await assert.rejects(
    adapter.resolveAttachment({ type: 'image', platformRef: 'large-file', mimeType: 'image/jpeg' }),
    (error) => error?.code === 'TELEGRAM_BRIDGE_RESPONSE_TOO_LARGE',
  )
})

test('QQ app credentials are blocked before a private-DNS request is sent', async () => {
  let fetchCalls = 0
  const adapter = createQQBridgeAdapter({
    integration: {
      config: { appId: 'qq-app-id' },
      secret: { appSecret: 'qq-private-app-secret' },
    },
    lookup: async () => [{ address: '10.1.2.3', family: 4 }],
    fetchImpl: async () => {
      fetchCalls += 1
      return jsonResponse({ access_token: 'must-not-be-returned' })
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'qq-user', text: 'hello' }),
    (error) => error?.code === 'QQ_BRIDGE_UNAVAILABLE'
      && error?.statusCode === 503
      && error?.cause?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(fetchCalls, 0)
})

test('QQ bot tokens are not forwarded across a cross-origin 307 redirect', async () => {
  const requests = []
  const adapter = createQQBridgeAdapter({
    integration: { secret: { botToken: 'qq-redirect-protected-token' } },
    lookup: PUBLIC_DNS,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init })
      return new Response(null, {
        status: 307,
        headers: { location: 'https://credential-thief.example.test/qq' },
      })
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'qq-user', text: 'hello' }),
    (error) => error?.code === 'QQ_BRIDGE_UNAVAILABLE'
      && error?.cause?.code === 'OUTBOUND_REDIRECT_CROSS_ORIGIN',
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.redirect, 'manual')
  assert.equal(requests[0].init.headers.Authorization, 'QQBot qq-redirect-protected-token')
  assert.equal(requests.some(({ url }) => url.includes('credential-thief.example.test')), false)
})

test('QQ bot requests revalidate DNS after a same-origin redirect', async () => {
  let lookupCalls = 0
  const requests = []
  const adapter = createQQBridgeAdapter({
    integration: { secret: { botToken: 'qq-rebinding-protected-token' } },
    lookup: async () => {
      lookupCalls += 1
      return [{ address: lookupCalls === 1 ? '93.184.216.34' : '192.168.1.25', family: 4 }]
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init })
      return new Response(null, {
        status: 307,
        headers: { location: '/v2/users/qq-user/messages/continued' },
      })
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'qq-user', text: 'hello' }),
    (error) => error?.code === 'QQ_BRIDGE_UNAVAILABLE'
      && error?.cause?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(lookupCalls, 2)
  assert.equal(requests.length, 1)
})

test('QQ bridge aborts slow response bodies and returns a stable timeout contract', async () => {
  let requestSignal = null
  const adapter = createQQBridgeAdapter({
    integration: { secret: { botToken: 'qq-timeout-token' } },
    lookup: PUBLIC_DNS,
    timeoutMs: 10,
    fetchImpl: async (_url, init = {}) => {
      requestSignal = init.signal
      return {
        ok: true,
        status: 200,
        json: async () => new Promise(() => {}),
      }
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'qq-user', text: 'hello' }),
    (error) => error?.code === 'QQ_BRIDGE_TIMEOUT'
      && error?.statusCode === 504
      && error?.retryable === true,
  )
  assert.equal(requestSignal instanceof AbortSignal, true)
  assert.equal(requestSignal.aborted, true)
})

test('QQ bridge distinguishes non-2xx responses from successful invalid JSON', async () => {
  for (const { response, code, upstreamStatus } of [
    {
      response: new Response('temporarily unavailable', { status: 503 }),
      code: 'QQ_BRIDGE_HTTP_ERROR',
      upstreamStatus: 503,
    },
    {
      response: new Response('not-json', { status: 200 }),
      code: 'QQ_BRIDGE_RESPONSE_INVALID',
      upstreamStatus: undefined,
    },
  ]) {
    const adapter = createQQBridgeAdapter({
      integration: { secret: { botToken: 'qq-response-token' } },
      lookup: PUBLIC_DNS,
      fetchImpl: async () => response,
    })
    await assert.rejects(
      adapter.sendMessage({ chatId: 'qq-user', text: 'hello' }),
      (error) => error?.code === code
        && error?.statusCode === 502
        && error?.upstreamStatus === upstreamStatus,
    )
  }
})

test('Feishu app secrets are blocked before a metadata-address request is sent', async () => {
  let fetchCalls = 0
  const adapter = createFeishuBridgeAdapter({
    integration: {
      config: { appId: 'feishu-app-id' },
      secret: { appSecret: 'feishu-metadata-protected-secret' },
    },
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    fetchImpl: async () => {
      fetchCalls += 1
      return jsonResponse({ code: 0, tenant_access_token: 'must-not-be-returned' })
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'feishu-chat', text: 'hello' }),
    (error) => error?.code === 'FEISHU_BRIDGE_UNAVAILABLE'
      && error?.statusCode === 503
      && error?.cause?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(fetchCalls, 0)
})

test('Feishu bearer tokens are not forwarded across a cross-origin 307 redirect', async () => {
  const requests = []
  const adapter = createFeishuBridgeAdapter({
    integration: {
      config: { appId: 'feishu-app-id' },
      secret: { appSecret: 'feishu-app-secret' },
    },
    lookup: PUBLIC_DNS,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'feishu-redirect-protected-token', expire: 7200 })
      }
      return new Response(null, {
        status: 307,
        headers: { location: 'https://credential-thief.example.test/feishu' },
      })
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'feishu-chat', text: 'hello' }),
    (error) => error?.code === 'FEISHU_BRIDGE_UNAVAILABLE'
      && error?.cause?.code === 'OUTBOUND_REDIRECT_CROSS_ORIGIN',
  )
  assert.equal(requests.length, 2)
  assert.equal(requests[1].init.redirect, 'manual')
  assert.equal(requests[1].init.headers.Authorization, 'Bearer feishu-redirect-protected-token')
  assert.equal(requests.some(({ url }) => url.includes('credential-thief.example.test')), false)
})

test('Feishu token acquisition revalidates DNS after a same-origin redirect', async () => {
  let lookupCalls = 0
  const requests = []
  const adapter = createFeishuBridgeAdapter({
    integration: {
      config: { appId: 'feishu-app-id' },
      secret: { appSecret: 'feishu-rebinding-protected-secret' },
    },
    lookup: async () => {
      lookupCalls += 1
      return [{ address: lookupCalls === 1 ? '93.184.216.34' : '172.16.4.5', family: 4 }]
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init })
      return new Response(null, {
        status: 307,
        headers: { location: '/open-apis/auth/v3/tenant_access_token/continued' },
      })
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'feishu-chat', text: 'hello' }),
    (error) => error?.code === 'FEISHU_BRIDGE_UNAVAILABLE'
      && error?.cause?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(lookupCalls, 2)
  assert.equal(requests.length, 1)
  assert.match(String(requests[0].init.body), /feishu-rebinding-protected-secret/)
})

test('Feishu bridge aborts slow response bodies and returns a stable timeout contract', async () => {
  let requestSignal = null
  const adapter = createFeishuBridgeAdapter({
    integration: {
      config: { appId: 'feishu-app-id' },
      secret: { appSecret: 'feishu-timeout-secret' },
    },
    lookup: PUBLIC_DNS,
    timeoutMs: 10,
    fetchImpl: async (_url, init = {}) => {
      requestSignal = init.signal
      return {
        ok: true,
        status: 200,
        json: async () => new Promise(() => {}),
      }
    },
  })

  await assert.rejects(
    adapter.sendMessage({ chatId: 'feishu-chat', text: 'hello' }),
    (error) => error?.code === 'FEISHU_BRIDGE_TIMEOUT'
      && error?.statusCode === 504
      && error?.retryable === true,
  )
  assert.equal(requestSignal instanceof AbortSignal, true)
  assert.equal(requestSignal.aborted, true)
})

test('Feishu bridge distinguishes non-2xx responses from successful invalid JSON', async () => {
  for (const { response, code, upstreamStatus } of [
    {
      response: new Response('temporarily unavailable', { status: 503 }),
      code: 'FEISHU_BRIDGE_HTTP_ERROR',
      upstreamStatus: 503,
    },
    {
      response: new Response('not-json', { status: 200 }),
      code: 'FEISHU_BRIDGE_RESPONSE_INVALID',
      upstreamStatus: undefined,
    },
  ]) {
    const adapter = createFeishuBridgeAdapter({
      integration: {
        config: { appId: 'feishu-app-id' },
        secret: { appSecret: 'feishu-response-secret' },
      },
      lookup: PUBLIC_DNS,
      fetchImpl: async () => response,
    })
    await assert.rejects(
      adapter.sendMessage({ chatId: 'feishu-chat', text: 'hello' }),
      (error) => error?.code === code
        && error?.statusCode === 502
        && error?.upstreamStatus === upstreamStatus,
    )
  }
})
