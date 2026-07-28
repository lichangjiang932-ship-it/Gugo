import assert from 'node:assert/strict'
import test from 'node:test'

import { getWechatIlinkQrcode } from '../server/adapters/social/wechatIlinkBridge.js'

test('WeChat QR network failures expose a stable unavailable error code', async () => {
  await assert.rejects(
    getWechatIlinkQrcode({ fetchImpl: async () => { throw new TypeError('fetch failed') } }),
    (error) => error.code === 'WECHAT_ILINK_UNAVAILABLE' && error.statusCode === 503,
  )
})
