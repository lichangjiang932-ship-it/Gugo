import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-qr-registration-'))

const { getDb } = await import('../server/db.js')
const { pollQrRegistration, startQrRegistration } = await import(
  '../server/services/integrationQrRegistration.js'
)
const { getIntegrationByProvider } = await import('../server/services/integrationsStore.js')
const { isCredentialEnvelope } = await import('../server/utils/credentialVault.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const REGISTRATION = 'https://accounts.feishu.cn/oauth/v1/app/registration'
const LARK_REGISTRATION = 'https://accounts.larksuite.com/oauth/v1/app/registration'
const TENANT_TOKEN = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

const BEGIN = {
  device_code: 'device-1',
  verification_uri_complete: 'https://accounts.feishu.cn/qr/abc',
  expires_in: 600,
  interval: 5,
}

function feishuFetch({ onPoll } = {}) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    const body = String(init.body || '')
    requests.push({ url: target, init, body })
    if (target === REGISTRATION || target === LARK_REGISTRATION) {
      if (new URLSearchParams(body).get('action') === 'begin') return jsonResponse(BEGIN)
      return onPoll ? onPoll(new URLSearchParams(body), target) : jsonResponse({ error: 'authorization_pending' }, 400)
    }
    if (target === TENANT_TOKEN) return jsonResponse({ code: 0, tenant_access_token: 'tenant-token' })
    throw new Error(`unexpected request: ${target}`)
  }
  return { fetchImpl, requests }
}

test('扫码注册：begin 请求是匿名的，二维码带上 createOnly，会话停在待授权', async () => {
  const userId = issueTestSession({ email: 'qr-begin@example.com' }).userId
  const { fetchImpl, requests } = feishuFetch({})
  const started = await startQrRegistration({ userId, provider: 'feishu', env: {}, fetchImpl, now: 1000 })

  assert.equal(requests[0].url, REGISTRATION)
  // 这个端点是匿名的 —— 没有 Authorization，也没有任何预先存在的应用凭据。
  assert.equal(requests[0].init.headers.Authorization, undefined)
  const body = new URLSearchParams(requests[0].body)
  assert.equal(body.get('action'), 'begin')
  assert.equal(body.get('archetype'), 'PersonalAgent')
  assert.equal(body.get('auth_method'), 'client_secret')
  assert.equal(body.get('request_user_info'), 'open_id')

  assert.match(started.qr.url, /^https:\/\/accounts\.feishu\.cn\/qr\/abc\?/)
  assert.match(started.qr.url, /createOnly=true/)
  assert.equal(started.session.status, 'pending')
  // 二维码地址只交给客户端，不塞进会话
  assert.equal('url' in started.session, false)

  const row = getDb().prepare(
    'SELECT code_verifier FROM integration_oauth_sessions WHERE id = ?',
  ).get(started.session.id)
  assert.equal(isCredentialEnvelope(row.code_verifier), true)
  assert.equal(row.code_verifier.includes('device-1'), false)
})

test('扫码注册：授权前保持 pending，授权后建出应用并落成集成', async () => {
  const userId = issueTestSession({ email: 'qr-complete@example.com' }).userId
  let authorized = false
  const { fetchImpl, requests } = feishuFetch({
    onPoll: () => (authorized
      ? jsonResponse({ client_id: 'cli_new', client_secret: 'secret_new', user_info: { open_id: 'ou_1' } })
      : jsonResponse({ error: 'authorization_pending' }, 400)),
  })
  const started = await startQrRegistration({ userId, provider: 'feishu', env: {}, fetchImpl })

  const waiting = await pollQrRegistration({ userId, id: started.session.id, env: {}, fetchImpl })
  assert.equal(waiting.status, 'pending')

  authorized = true
  const done = await pollQrRegistration({ userId, id: started.session.id, env: {}, fetchImpl })
  assert.equal(done.status, 'completed')
  assert.equal(done.integration.enabled, true)

  const stored = getIntegrationByProvider({ userId, provider: 'feishu' })
  assert.equal(stored.config.appId, 'cli_new')
  assert.equal(stored.config.authSource, 'qr')
  assert.equal(stored.secret.appSecret.present, true)
  assert.equal(JSON.stringify(done).includes('secret_new'), false)

  // 新应用先被真探测过才启用，且用的是它自己的凭据。
  const probe = requests.find((request) => request.url === TENANT_TOKEN)
  assert.ok(probe, 'the new app is verified before it is enabled')
  assert.match(probe.body, /cli_new/)
})

test('扫码注册：slow_down 拉长间隔但仍待授权，access_denied 直接失败', async () => {
  const userId = issueTestSession({ email: 'qr-slow@example.com' }).userId
  let mode = 'slow'
  const { fetchImpl } = feishuFetch({
    onPoll: () => (mode === 'slow'
      ? jsonResponse({ error: 'slow_down' }, 400)
      : jsonResponse({ error: 'access_denied', error_description: 'The reader said no' }, 400)),
  })
  const started = await startQrRegistration({ userId, provider: 'feishu', env: {}, fetchImpl })

  const slowed = await pollQrRegistration({ userId, id: started.session.id, env: {}, fetchImpl })
  assert.equal(slowed.status, 'pending')

  mode = 'denied'
  const denied = await pollQrRegistration({ userId, id: started.session.id, env: {}, fetchImpl })
  assert.equal(denied.status, 'failed')
  assert.match(String(denied.error), /said no/i)
})

test('扫码注册：expired_token 让会话过期而不是无限等下去', async () => {
  const userId = issueTestSession({ email: 'qr-expired@example.com' }).userId
  const { fetchImpl } = feishuFetch({ onPoll: () => jsonResponse({ error: 'expired_token' }, 400) })
  const started = await startQrRegistration({ userId, provider: 'feishu', env: {}, fetchImpl })
  const expired = await pollQrRegistration({ userId, id: started.session.id, env: {}, fetchImpl })
  assert.equal(expired.status, 'expired')
})

test('扫码注册：租户在 Lark 时换域名继续，不当作失败', async () => {
  const userId = issueTestSession({ email: 'qr-lark@example.com' }).userId
  const seen = []
  const { fetchImpl } = feishuFetch({
    onPoll: (_params, target) => {
      seen.push(target)
      if (target === REGISTRATION) return jsonResponse({ tenant_brand: 'lark' })
      return jsonResponse({ client_id: 'cli_lark', client_secret: 'sec_lark' })
    },
  })
  const started = await startQrRegistration({ userId, provider: 'feishu', env: {}, fetchImpl })
  const done = await pollQrRegistration({ userId, id: started.session.id, env: {}, fetchImpl })

  assert.deepEqual(seen, [REGISTRATION, LARK_REGISTRATION])
  assert.equal(done.status, 'completed')
  assert.equal(getIntegrationByProvider({ userId, provider: 'feishu' }).config.appId, 'cli_lark')
})

test('扫码注册：不被它自己的轮询端点认领的会话返回 null，交给别的流程', async () => {
  const userId = issueTestSession({ email: 'qr-not-mine@example.com' }).userId
  const { fetchImpl } = feishuFetch({})
  const started = await startQrRegistration({ userId, provider: 'feishu', env: {}, fetchImpl })
  assert.equal(await pollQrRegistration({ userId, id: 'no-such-session', env: {}, fetchImpl }), null)
  assert.equal(await pollQrRegistration({ userId: 'someone-else', id: started.session.id, env: {}, fetchImpl }), null)
})

test('扫码注册：只支持已经实现的 provider', async () => {
  const userId = issueTestSession({ email: 'qr-unsupported@example.com' }).userId
  await assert.rejects(
    () => startQrRegistration({ userId, provider: 'slack', env: {}, fetchImpl: async () => jsonResponse({}) }),
    (error) => error.code === 'QR_PROVIDER_UNSUPPORTED',
  )
})
