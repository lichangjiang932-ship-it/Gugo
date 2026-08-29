import assert from 'node:assert/strict'
import test from 'node:test'

import {
  _wechatIlinkInternals,
  getWechatIlinkQrcode,
} from '../server/adapters/social/wechatIlinkBridge.js'

test('WeChat QR network failures expose a stable unavailable error code', async () => {
  await assert.rejects(
    getWechatIlinkQrcode({ fetchImpl: async () => { throw new TypeError('fetch failed') } }),
    (error) => error.code === 'WECHAT_ILINK_UNAVAILABLE' && error.statusCode === 503,
  )
})

test('WeChat iLink upstream base URLs cannot resolve into the local network', async () => {
  let fetchCalls = 0
  await assert.rejects(
    () => _wechatIlinkInternals.fetchIlinkOutbound(
      'https://upstream-base.example.test/ilink/bot/getupdates',
      { headers: { Authorization: 'Bearer bot-secret' } },
      {
        lookup: async () => [{ address: '10.1.2.3', family: 4 }],
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response('{}')
        },
      },
    ),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(fetchCalls, 0)
})

test('WeChat iLink bot tokens are not forwarded across redirects', async () => {
  const requests = []
  await assert.rejects(
    () => _wechatIlinkInternals.fetchIlinkOutbound(
      'https://upstream-base.example.test/ilink/bot/getupdates',
      { headers: { Authorization: 'Bearer bot-secret' } },
      {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async (url, init) => {
          requests.push({ url: String(url), init })
          return new Response(null, {
            status: 307,
            headers: { location: 'https://credential-thief.example.test/collect' },
          })
        },
      },
    ),
    (error) => error?.code === 'OUTBOUND_REDIRECT_CROSS_ORIGIN',
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.headers.Authorization, 'Bearer bot-secret')
  assert.equal(requests.some(({ url }) => url.includes('credential-thief.example.test')), false)
})
