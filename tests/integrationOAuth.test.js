import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-integration-oauth-'))

const { DB_SCHEMA_VERSION, getDb } = await import('../server/db.js')
const {
  completeOAuthConnection,
  getOAuthAccessToken,
  getOAuthConnectionStatus,
  listOAuthProviders,
  startOAuthConnection,
} = await import('../server/services/integrationOAuthService.js')
const {
  getEnabledIntegrationCredentials,
  upsertIntegration,
} = await import('../server/services/integrationsStore.js')
const { isCredentialEnvelope } = await import('../server/utils/credentialVault.js')
const { createAppServer } = await import('../server/appServer.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const ENV = {
  APP_PUBLIC_URL: 'http://127.0.0.1:5175',
  GITHUB_OAUTH_CLIENT_ID: 'github-client',
  GITHUB_OAUTH_CLIENT_SECRET: 'github-secret',
  NOTION_OAUTH_CLIENT_ID: 'notion-client',
  NOTION_OAUTH_CLIENT_SECRET: 'notion-secret',
  SLACK_OAUTH_CLIENT_ID: 'slack-client',
  SLACK_OAUTH_CLIENT_SECRET: 'slack-secret',
  GOOGLE_DRIVE_OAUTH_CLIENT_ID: 'google-client',
  GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: 'google-secret',
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

function authState(result) {
  return new URL(result.authorizationUrl).searchParams.get('state')
}

async function withServer(getEnv, fn) {
  const server = createAppServer({ getEnv })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('schema v27 persists OAuth sessions and command-scoped approval grants', () => {
  // 断言下界而不是精确值 —— 这个用例关心的是 v27 引入的表还在,
  // 不是「当前版本号正好等于 27」。写死精确值会让后续每加一个 migration
  // 都要来改这一行,而改动本身和 OAuth 毫无关系。
  assert.ok(DB_SCHEMA_VERSION >= 27, `schema version ${DB_SCHEMA_VERSION} 应 >= 27`)
  const tables = getDb().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'integration_oauth_sessions'",
  ).all()
  assert.equal(tables.length, 1)
  const grantColumns = getDb().prepare('PRAGMA table_info(approval_tool_grants)').all()
  assert.ok(grantColumns.some((column) => column.name === 'command_prefix'))
  assert.deepEqual(
    grantColumns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name),
    ['user_id', 'tool_name', 'command_prefix'],
  )
  assert.deepEqual(listOAuthProviders({ env: ENV }).map(({ provider, configured, pkce }) => ({
    provider,
    configured,
    pkce,
  })), [
    { provider: 'github', configured: true, pkce: true },
    { provider: 'notion', configured: true, pkce: false },
    { provider: 'slack', configured: true, pkce: false },
    { provider: 'google_drive', configured: true, pkce: true },
  ])
})

test('GitHub OAuth start stores a state hash, uses PKCE S256, and isolates session status', () => {
  const alice = issueTestSession({ email: 'oauth-start-alice@example.com' }).userId
  const bob = issueTestSession({ email: 'oauth-start-bob@example.com' }).userId
  const started = startOAuthConnection({ userId: alice, provider: 'github', env: ENV, now: 1000 })
  const authorization = new URL(started.authorizationUrl)
  const state = authorization.searchParams.get('state')

  assert.equal(authorization.origin, 'https://github.com')
  assert.equal(authorization.searchParams.get('scope'), 'read:user')
  assert.equal(authorization.searchParams.get('scope').includes('repo'), false)
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(authorization.searchParams.get('code_challenge'))
  assert.ok(state)
  assert.equal(started.session.status, 'pending')
  assert.equal('codeVerifier' in started.session, false)
  assert.equal('state' in started.session, false)

  const row = getDb().prepare(
    'SELECT state_hash, code_verifier FROM integration_oauth_sessions WHERE id = ?',
  ).get(started.session.id)
  assert.notEqual(row.state_hash, state)
  assert.equal(isCredentialEnvelope(row.code_verifier), true)
  assert.equal(row.code_verifier.includes(authorization.searchParams.get('code_challenge')), false)
  assert.equal(getOAuthConnectionStatus({ userId: bob, id: started.session.id, now: 1001 }), null)
  assert.equal(getOAuthConnectionStatus({ userId: alice, id: started.session.id, now: 1001 }).status, 'pending')
})

test('GitHub OAuth callback validates before persisting and state is one-time', async () => {
  const userId = issueTestSession({ email: 'oauth-complete@example.com' }).userId
  const started = startOAuthConnection({ userId, provider: 'github', env: ENV })
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).includes('/access_token')) return jsonResponse({
      access_token: 'oauth-access-token',
      token_type: 'bearer',
      scope: 'repo,read:user',
    })
    return jsonResponse({ login: 'octocat', id: 1 })
  }

  const completed = await completeOAuthConnection({
    provider: 'github',
    state: authState(started),
    code: 'authorization-code',
    env: ENV,
    fetchImpl,
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.integration.enabled, true)
  assert.equal(completed.integration.config.authSource, 'oauth')
  assert.equal(completed.integration.secret.token.present, true)
  assert.equal(JSON.stringify(completed).includes('oauth-access-token'), false)
  assert.match(String(requests[0].init.body), /code_verifier=/)
  assert.equal(requests[1].init.headers.Authorization, 'Bearer oauth-access-token')
  assert.equal(getDb().prepare(
    'SELECT code_verifier FROM integration_oauth_sessions WHERE id = ?',
  ).get(started.session.id).code_verifier, '')

  await assert.rejects(
    completeOAuthConnection({
      provider: 'github',
      state: authState(started),
      code: 'replayed-code',
      env: ENV,
      fetchImpl,
    }),
    (error) => error.code === 'OAUTH_STATE_USED' && error.statusCode === 409,
  )
})

test('legacy plaintext PKCE verifier migrates during exchange and is cleared at completion', async () => {
  const userId = issueTestSession({ email: 'oauth-legacy-pkce@example.com' }).userId
  const started = startOAuthConnection({ userId, provider: 'github', env: ENV })
  getDb().prepare('UPDATE integration_oauth_sessions SET code_verifier = ? WHERE id = ?')
    .run('legacy-pkce-verifier', started.session.id)
  let exchangeBody = ''
  const completed = await completeOAuthConnection({
    provider: 'github',
    state: authState(started),
    code: 'legacy-code',
    env: ENV,
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('/access_token')) {
        exchangeBody = String(init.body)
        return jsonResponse({ access_token: 'legacy-oauth-token', scope: 'read:user' })
      }
      return jsonResponse({ login: 'legacy-user', id: 2 })
    },
  })
  assert.equal(completed.status, 'completed')
  assert.match(exchangeBody, /code_verifier=legacy-pkce-verifier/)
  assert.equal(getDb().prepare(
    'SELECT code_verifier FROM integration_oauth_sessions WHERE id = ?',
  ).get(started.session.id).code_verifier, '')
})

test('failed OAuth validation does not overwrite an existing working token', async () => {
  const userId = issueTestSession({ email: 'oauth-preserve@example.com' }).userId
  const existing = upsertIntegration({
    userId,
    provider: 'github',
    name: 'GitHub',
    enabled: true,
    config: { account: 'existing' },
    secret: { token: 'existing-good-token' },
  })
  const started = startOAuthConnection({
    userId,
    provider: 'github',
    integrationId: existing.id,
    env: ENV,
  })
  const fetchImpl = async (url) => String(url).includes('/access_token')
    ? jsonResponse({ access_token: 'bad-new-token' })
    : jsonResponse({ message: 'Bad credentials' }, 401)

  const failed = await completeOAuthConnection({
    provider: 'github',
    state: authState(started),
    code: 'bad-code',
    env: ENV,
    fetchImpl,
  })
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /GitHub 401/)
  assert.equal(
    getEnabledIntegrationCredentials({ userId, provider: 'github' }).secret.token,
    'existing-good-token',
  )
})

test('expired and denied OAuth sessions fail closed without creating integrations', async () => {
  const userId = issueTestSession({ email: 'oauth-expiry@example.com' }).userId
  const expiredStart = startOAuthConnection({
    userId,
    provider: 'github',
    env: ENV,
    now: 10,
  })
  const expired = getOAuthConnectionStatus({
    userId,
    id: expiredStart.session.id,
    now: 10 + (10 * 60 * 1000) + 1,
  })
  assert.equal(expired.status, 'expired')
  await assert.rejects(
    completeOAuthConnection({
      provider: 'github',
      state: authState(expiredStart),
      code: 'late',
      env: ENV,
      now: 10 + (10 * 60 * 1000) + 2,
    }),
    (error) => error.code === 'OAUTH_SESSION_EXPIRED',
  )

  const deniedStart = startOAuthConnection({ userId, provider: 'notion', env: ENV })
  const denied = await completeOAuthConnection({
    provider: 'notion',
    state: authState(deniedStart),
    providerError: 'access_denied',
    env: ENV,
  })
  assert.equal(denied.status, 'failed')
  assert.equal(denied.error, 'access_denied')
})

test('Notion OAuth uses confidential-client exchange and validates the token', async () => {
  const userId = issueTestSession({ email: 'oauth-notion@example.com' }).userId
  const started = startOAuthConnection({ userId, provider: 'notion', env: ENV })
  const authorization = new URL(started.authorizationUrl)
  assert.equal(authorization.searchParams.has('code_challenge'), false)
  assert.equal(authorization.searchParams.get('response_type'), 'code')
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).includes('/oauth/token')) return jsonResponse({
      access_token: 'notion-access-token',
      token_type: 'bearer',
      workspace_id: 'workspace-id',
      workspace_name: 'Atelier',
      bot_id: 'bot-id',
    })
    return jsonResponse({ id: 'bot-id', name: 'Atelier', type: 'bot' })
  }
  const completed = await completeOAuthConnection({
    provider: 'notion',
    state: authState(started),
    code: 'notion-code',
    env: ENV,
    fetchImpl,
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.integration.config.workspace, 'Atelier')
  assert.match(requests[0].init.headers.Authorization, /^Basic /)
  assert.equal(requests[1].init.headers.Authorization, 'Bearer notion-access-token')
})

test('Slack OAuth requests read scopes and stores a probed bot token', async () => {
  const userId = issueTestSession({ email: 'oauth-slack@example.com' }).userId
  const started = startOAuthConnection({ userId, provider: 'slack', env: ENV })
  const authorization = new URL(started.authorizationUrl)
  assert.equal(authorization.origin, 'https://slack.com')
  assert.equal(authorization.searchParams.get('scope'), 'channels:read,channels:history')
  assert.equal(authorization.searchParams.has('code_challenge'), false)
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).includes('/oauth.v2.access')) return jsonResponse({
      ok: true,
      access_token: 'xoxb-oauth-token',
      token_type: 'bot',
      scope: 'channels:read,channels:history',
      bot_user_id: 'B123',
      team: { id: 'T123', name: 'Atelier' },
    })
    return jsonResponse({ ok: true, team: 'Atelier', user: 'atelier-bot' })
  }
  const completed = await completeOAuthConnection({
    provider: 'slack',
    state: authState(started),
    code: 'slack-code',
    env: ENV,
    fetchImpl,
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.integration.config.workspace, 'Atelier')
  assert.equal(completed.integration.secret.botToken.present, true)
  assert.match(String(requests[0].init.body), /client_secret=slack-secret/)
  assert.equal(requests[1].init.headers.Authorization, 'Bearer xoxb-oauth-token')
})

test('Google Drive OAuth is read-only, uses PKCE, and refreshes expired access tokens', async () => {
  const userId = issueTestSession({ email: 'oauth-drive@example.com' }).userId
  const started = startOAuthConnection({ userId, provider: 'google_drive', env: ENV })
  const authorization = new URL(started.authorizationUrl)
  assert.equal(authorization.origin, 'https://accounts.google.com')
  assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.readonly')
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorization.searchParams.get('access_type'), 'offline')
  const fetchImpl = async (url) => String(url).includes('oauth2.googleapis.com/token')
    ? jsonResponse({
      access_token: 'drive-access-token',
      refresh_token: 'drive-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
    })
    : jsonResponse({ user: { emailAddress: 'reader@example.com' } })
  const completed = await completeOAuthConnection({
    provider: 'google_drive',
    state: authState(started),
    code: 'google-code',
    env: ENV,
    fetchImpl,
  })
  assert.equal(completed.status, 'completed')
  assert.equal(JSON.stringify(completed).includes('drive-access-token'), false)
  assert.equal(JSON.stringify(completed).includes('drive-refresh-token'), false)
  const credentials = getEnabledIntegrationCredentials({ userId, provider: 'google_drive' })
  assert.equal(credentials.secret.refreshToken, 'drive-refresh-token')

  let refreshBody = ''
  const refreshed = await getOAuthAccessToken({
    userId,
    provider: 'google_drive',
    env: ENV,
    now: Number(credentials.secret.expiresAt) + 1,
    fetchImpl: async (_url, init) => {
      refreshBody = String(init.body)
      return jsonResponse({ access_token: 'drive-refreshed-token', token_type: 'Bearer', expires_in: 3600 })
    },
  })
  assert.equal(refreshed, 'drive-refreshed-token')
  assert.match(refreshBody, /grant_type=refresh_token/)
  assert.match(refreshBody, /refresh_token=drive-refresh-token/)
  const persisted = getEnabledIntegrationCredentials({ userId, provider: 'google_drive' })
  assert.equal(persisted.secret.token, 'drive-refreshed-token')
  assert.equal(persisted.secret.refreshToken, 'drive-refresh-token')
})

test('failed Google Drive refresh preserves the last stored token pair', async () => {
  const userId = issueTestSession({ email: 'oauth-drive-refresh-failure@example.com' }).userId
  upsertIntegration({
    userId,
    provider: 'google_drive',
    name: 'Google Drive',
    enabled: true,
    config: { authSource: 'oauth' },
    secret: {
      token: 'last-access-token',
      refreshToken: 'last-refresh-token',
      expiresAt: '1000',
    },
  })
  await assert.rejects(
    getOAuthAccessToken({
      userId,
      provider: 'google_drive',
      env: ENV,
      now: 2000,
      fetchImpl: async () => jsonResponse({ error: 'temporarily_unavailable' }, 503),
    }),
    (error) => error.code === 'OAUTH_TOKEN_EXCHANGE_FAILED',
  )
  const preserved = getEnabledIntegrationCredentials({ userId, provider: 'google_drive' })
  assert.equal(preserved.secret.token, 'last-access-token')
  assert.equal(preserved.secret.refreshToken, 'last-refresh-token')
  assert.equal(preserved.secret.expiresAt, '1000')
})

test('OAuth refresh refuses cloud metadata DNS before sending refresh credentials', async () => {
  const userId = issueTestSession({ email: 'oauth-refresh-metadata@example.com' }).userId
  upsertIntegration({
    userId,
    provider: 'google_drive',
    name: 'Google Drive',
    enabled: true,
    config: { authSource: 'oauth' },
    secret: {
      token: 'expired-access-token',
      refreshToken: 'metadata-protected-refresh-token',
      expiresAt: '1000',
    },
  })
  let fetchCalls = 0
  await assert.rejects(
    getOAuthAccessToken({
      userId,
      provider: 'google_drive',
      env: ENV,
      now: 2000,
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
      fetchImpl: async () => {
        fetchCalls += 1
        return jsonResponse({ access_token: 'must-not-be-returned' })
      },
    }),
    (error) => error?.code === 'OAUTH_TOKEN_EXCHANGE_FAILED'
      && error?.cause?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(fetchCalls, 0)
})

test('OAuth authorization-code secrets are not forwarded across a 307 redirect', async () => {
  const userId = issueTestSession({ email: 'oauth-code-cross-origin@example.com' }).userId
  const started = startOAuthConnection({ userId, provider: 'github', env: ENV })
  const requests = []
  const completed = await completeOAuthConnection({
    provider: 'github',
    state: authState(started),
    code: 'redirect-protected-code',
    env: ENV,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init })
      return new Response(null, {
        status: 307,
        headers: { location: 'https://credential-thief.example.test/oauth' },
      })
    },
  })

  assert.equal(completed.status, 'failed')
  assert.equal(completed.error, 'OAuth token request was blocked or unavailable')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://github.com/login/oauth/access_token')
  assert.equal(requests[0].init.redirect, 'manual')
  assert.match(String(requests[0].init.body), /code=redirect-protected-code/)
  assert.equal(requests.some(({ url }) => url.includes('credential-thief.example.test')), false)
})

test('OAuth refresh revalidates DNS after a same-origin redirect', async () => {
  const userId = issueTestSession({ email: 'oauth-refresh-rebinding@example.com' }).userId
  upsertIntegration({
    userId,
    provider: 'google_drive',
    name: 'Google Drive',
    enabled: true,
    config: { authSource: 'oauth' },
    secret: {
      token: 'expired-rebinding-token',
      refreshToken: 'rebinding-protected-refresh-token',
      expiresAt: '1000',
    },
  })
  let lookupCalls = 0
  const requests = []
  await assert.rejects(
    getOAuthAccessToken({
      userId,
      provider: 'google_drive',
      env: ENV,
      now: 2000,
      lookup: async () => {
        lookupCalls += 1
        return [{
          address: lookupCalls === 1 ? '93.184.216.34' : '10.23.45.67',
          family: 4,
        }]
      },
      fetchImpl: async (url, init = {}) => {
        requests.push({ url: String(url), init })
        return new Response(null, {
          status: 307,
          headers: { location: '/token/continued' },
        })
      },
    }),
    (error) => error?.code === 'OAUTH_TOKEN_EXCHANGE_FAILED'
      && error?.cause?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(lookupCalls, 2)
  assert.equal(requests.length, 1)
  assert.match(String(requests[0].init.body), /refresh_token=rebinding-protected-refresh-token/)
})

test('OAuth routes require auth, expose start/status, and report missing server config', async () => {
  const { token } = issueTestSession({ email: 'oauth-routes@example.com' })
  await withServer(() => ENV, async (base) => {
    const unauthorized = await fetch(`${base}/api/integrations/oauth/providers`)
    assert.equal(unauthorized.status, 401)
    const start = await fetch(`${base}/api/integrations/oauth/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({ provider: 'github' }),
    })
    assert.equal(start.status, 200)
    const body = await start.json()
    assert.equal(body.session.status, 'pending')
    const status = await fetch(`${base}/api/integrations/oauth/sessions/${body.session.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(status.status, 200)
  })

  await withServer(() => ({ APP_PUBLIC_URL: 'http://127.0.0.1:5175' }), async (base) => {
    const response = await fetch(`${base}/api/integrations/oauth/start`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'github' }),
    })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'OAUTH_NOT_CONFIGURED')
  })
})
