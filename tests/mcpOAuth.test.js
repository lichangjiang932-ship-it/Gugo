import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-mcp-oauth-'))
process.env.APP_DATA_DIR = dir
process.env.APP_DB_PATH = path.join(dir, 'app.db')
process.env.CREDENTIAL_KEY_PATH = path.join(dir, '.credentials.key')

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { upsertServer } = await import('../server/mcp/mcpStore.js')
const {
  beginMcpOAuth,
  completeMcpOAuth,
  disconnectMcpOAuth,
  getMcpOAuthHeaders,
  getMcpOAuthStatus,
} = await import('../server/mcp/mcpOAuth.js')
const { isCredentialEnvelope } = await import('../server/utils/credentialVault.js')

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function discoveryFetch(requests) {
  return async (url, options = {}) => {
    const href = String(url)
    requests.push({ url: href, options })
    if (href === 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp') {
      return jsonResponse({
        resource: 'https://mcp.example.test/mcp',
        authorization_servers: ['https://auth.example.test'],
        scopes_supported: ['mcp.read', 'mcp.write'],
      })
    }
    if (href === 'https://auth.example.test/.well-known/oauth-authorization-server') {
      return jsonResponse({
        issuer: 'https://auth.example.test',
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://auth.example.test/token',
        registration_endpoint: 'https://auth.example.test/register',
      })
    }
    if (href === 'https://auth.example.test/token') {
      const body = new URLSearchParams(options.body)
      if (body.get('grant_type') === 'refresh_token') {
        return jsonResponse({
          access_token: 'access-refreshed',
          refresh_token: 'refresh-2',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp.read mcp.write',
        })
      }
      return jsonResponse({
        access_token: 'access-initial',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp.read mcp.write',
      })
    }
    throw new Error(`unexpected OAuth request: ${href}`)
  }
}

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('MCP OAuth discovers metadata, uses PKCE, encrypts tokens, and refreshes them', async () => {
  createUser({ id: 'oauth-user', email: 'oauth-user@example.com' })
  createUser({ id: 'other-user', email: 'other-user@example.com' })
  const server = upsertServer({
    userId: 'oauth-user',
    name: 'Remote OAuth MCP',
    transport: 'http',
    url: 'https://mcp.example.test/mcp',
    headers: {},
    enabled: true,
    autoApprove: [],
  })
  const requests = []
  const fetchImpl = discoveryFetch(requests)
  const started = await beginMcpOAuth({
    userId: 'oauth-user',
    serverId: server.id,
    redirectUri: 'http://127.0.0.1:5175/api/mcp/oauth/callback',
    config: { clientId: 'client-123', clientSecret: 'secret-123' },
    fetchImpl,
  })
  const authorizationUrl = new URL(started.authorizationUrl)
  assert.equal(authorizationUrl.origin, 'https://auth.example.test')
  assert.equal(authorizationUrl.searchParams.get('client_id'), 'client-123')
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(authorizationUrl.searchParams.get('code_challenge').length >= 40)
  assert.equal(authorizationUrl.searchParams.get('resource'), 'https://mcp.example.test/mcp')
  assert.equal(authorizationUrl.searchParams.get('scope'), 'mcp.read mcp.write')

  const pendingRow = getDb().prepare(`
    SELECT state_hash, pending_json, expires_at
    FROM mcp_oauth_pending_authorizations
    WHERE user_id = ? AND server_id = ?
  `).get('oauth-user', server.id)
  assert.ok(pendingRow)
  assert.equal(pendingRow.state_hash.length, 64)
  assert.notEqual(pendingRow.state_hash, started.state)
  assert.equal(isCredentialEnvelope(pendingRow.pending_json), true)
  assert.equal(pendingRow.pending_json.includes(started.state), false)
  assert.equal(pendingRow.pending_json.includes('secret-123'), false)

  // Loading a fresh module instance simulates a process/module restart: the
  // pending state remains available because it is stored in SQLite, not a Map.
  const restartedOAuth = await import(`../server/mcp/mcpOAuth.js?restart=${Date.now()}`)
  const completed = await restartedOAuth.completeMcpOAuth({
    state: started.state,
    code: 'authorization-code',
    fetchImpl,
  })
  assert.equal(completed.userId, 'oauth-user')
  assert.equal(completed.serverId, server.id)
  assert.equal(getDb().prepare(
    'SELECT COUNT(*) AS count FROM mcp_oauth_pending_authorizations WHERE server_id = ?',
  ).get(server.id).count, 0)
  await assert.rejects(
    () => completeMcpOAuth({ state: started.state, code: 'replayed-code', fetchImpl }),
    (error) => error.code === 'MCP_OAUTH_STATE_INVALID',
  )
  assert.equal(getMcpOAuthStatus('oauth-user', server.id).connected, true)
  assert.deepEqual(getMcpOAuthStatus('other-user', server.id), { configured: false, connected: false })
  assert.deepEqual(await getMcpOAuthHeaders('oauth-user', server.id, { fetchImpl }), {
    Authorization: 'Bearer access-initial',
  })

  const row = getDb().prepare(
    'SELECT credential_json FROM mcp_oauth_credentials WHERE server_id = ?',
  ).get(server.id)
  assert.equal(isCredentialEnvelope(row.credential_json), true)
  assert.equal(row.credential_json.includes('access-initial'), false)
  assert.equal(row.credential_json.includes('secret-123'), false)

  getDb().prepare('UPDATE mcp_oauth_credentials SET expires_at = ? WHERE server_id = ?')
    .run(Date.now() - 1, server.id)
  assert.deepEqual(await getMcpOAuthHeaders('oauth-user', server.id, { fetchImpl }), {
    Authorization: 'Bearer access-refreshed',
  })
  const refreshRequest = requests.find(({ url, options }) => (
    url.endsWith('/token') && new URLSearchParams(options.body).get('grant_type') === 'refresh_token'
  ))
  assert.ok(refreshRequest)
  assert.equal(disconnectMcpOAuth('other-user', server.id), false)
  assert.equal(disconnectMcpOAuth('oauth-user', server.id), true)
  assert.deepEqual(getMcpOAuthStatus('oauth-user', server.id), { configured: false, connected: false })
})

test('MCP OAuth callback origin ignores request headers unless proxy trust is explicit', async () => {
  const { _mcpRoutesInternals } = await import('../server/routes/mcpRoutes.js')
  const req = {
    headers: {
      host: 'attacker.example',
      'x-forwarded-host': 'forwarded-attacker.example',
      'x-forwarded-proto': 'https',
    },
    socket: { encrypted: false, localPort: 6111 },
  }
  assert.equal(_mcpRoutesInternals.requestOrigin(req, {
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: '5175',
  }), 'http://127.0.0.1:5175')
  assert.equal(_mcpRoutesInternals.requestOrigin(req, {
    SERVER_HOST: '127.0.0.1',
    SERVER_PORT: '5175',
    TRUST_PROXY: '1',
  }), 'https://forwarded-attacker.example')
  assert.equal(_mcpRoutesInternals.requestOrigin(req, {
    APP_PUBLIC_URL: 'https://atelier.example/base/path',
    TRUST_PROXY: '0',
  }), 'https://atelier.example')
})

test('MCP OAuth dynamically registers a client when no Client ID is configured', async () => {
  const server = upsertServer({
    userId: 'oauth-user',
    name: 'Dynamic OAuth MCP',
    transport: 'http',
    url: 'https://mcp.example.test/mcp',
    headers: {},
    enabled: true,
    autoApprove: [],
  })
  const requests = []
  const baseFetch = discoveryFetch(requests)
  const fetchImpl = async (url, options = {}) => {
    if (String(url) === 'https://auth.example.test/register') {
      requests.push({ url: String(url), options })
      return jsonResponse({ client_id: 'dynamic-client', token_endpoint_auth_method: 'none' }, 201)
    }
    return baseFetch(url, options)
  }
  const result = await beginMcpOAuth({
    userId: 'oauth-user',
    serverId: server.id,
    redirectUri: 'http://localhost:5175/api/mcp/oauth/callback',
    fetchImpl,
  })
  assert.equal(new URL(result.authorizationUrl).searchParams.get('client_id'), 'dynamic-client')
  const registration = requests.find(({ url }) => url.endsWith('/register'))
  assert.ok(registration)
  assert.deepEqual(JSON.parse(registration.options.body).redirect_uris, [
    'http://localhost:5175/api/mcp/oauth/callback',
  ])
  getDb().prepare(
    'UPDATE mcp_oauth_pending_authorizations SET expires_at = ? WHERE state_hash = ?',
  ).run(Date.now() - 1, (await import('../server/mcp/mcpOAuthPendingStore.js'))
    ._mcpOAuthPendingStoreInternals.stateHash(result.state))
  await assert.rejects(
    () => completeMcpOAuth({ state: result.state, code: 'expired-code', fetchImpl }),
    (error) => error.code === 'MCP_OAUTH_STATE_INVALID',
  )
  assert.equal(getDb().prepare(
    'SELECT COUNT(*) AS count FROM mcp_oauth_pending_authorizations WHERE server_id = ?',
  ).get(server.id).count, 0)
})

test('remote MCP metadata cannot grant OAuth access to a loopback token endpoint', async () => {
  const userId = 'oauth-remote-local-policy'
  createUser({ id: userId, email: `${userId}@example.com` })
  const server = upsertServer({
    userId,
    name: 'Remote metadata policy MCP',
    transport: 'http',
    url: 'https://remote-policy.example.test/mcp',
    headers: {},
    enabled: true,
    autoApprove: [],
  })
  let loopbackFetches = 0
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href === 'https://remote-policy.example.test/.well-known/oauth-protected-resource/mcp') {
      return jsonResponse({
        resource: server.url,
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'http://127.0.0.1:7777/token',
      })
    }
    if (href === 'http://127.0.0.1:7777/token') loopbackFetches += 1
    return jsonResponse({}, 404)
  }
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const started = await beginMcpOAuth({
    userId,
    serverId: server.id,
    redirectUri: 'http://127.0.0.1:5175/api/mcp/oauth/callback',
    config: { clientId: 'remote-client', clientSecret: 'remote-secret' },
    fetchImpl,
    lookup,
  })

  await assert.rejects(
    () => completeMcpOAuth({ state: started.state, code: 'secret-code', fetchImpl, lookup }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(loopbackFetches, 0)
})

test('an explicitly configured local MCP keeps local OAuth endpoints usable', async () => {
  const userId = 'oauth-explicit-local'
  createUser({ id: userId, email: `${userId}@example.com` })
  const server = upsertServer({
    userId,
    name: 'Local OAuth MCP',
    transport: 'http',
    url: 'http://127.0.0.1:6111/mcp',
    headers: {},
    enabled: true,
    autoApprove: [],
  })
  let tokenFetches = 0
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href === 'http://127.0.0.1:6111/.well-known/oauth-protected-resource/mcp') {
      return jsonResponse({
        resource: server.url,
        authorization_endpoint: 'http://127.0.0.1:6111/authorize',
        token_endpoint: 'http://127.0.0.1:6111/token',
      })
    }
    if (href === 'http://127.0.0.1:6111/token') {
      tokenFetches += 1
      return jsonResponse({ access_token: 'local-access', token_type: 'Bearer', expires_in: 3600 })
    }
    return jsonResponse({}, 404)
  }
  const started = await beginMcpOAuth({
    userId,
    serverId: server.id,
    redirectUri: 'http://127.0.0.1:5175/api/mcp/oauth/callback',
    config: { clientId: 'local-client' },
    fetchImpl,
  })

  const completed = await completeMcpOAuth({
    state: started.state,
    code: 'local-code',
    fetchImpl,
  })
  assert.equal(completed.serverId, server.id)
  assert.equal(tokenFetches, 1)
})

test('OAuth token DNS is checked before credentials are sent', async () => {
  const userId = 'oauth-private-dns'
  createUser({ id: userId, email: `${userId}@example.com` })
  const server = upsertServer({
    userId,
    name: 'Poisoned token DNS MCP',
    transport: 'http',
    url: 'https://dns-policy.example.test/mcp',
    headers: {},
    enabled: true,
    autoApprove: [],
  })
  let tokenFetches = 0
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href === 'https://dns-policy.example.test/.well-known/oauth-protected-resource/mcp') {
      return jsonResponse({
        resource: server.url,
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://poisoned-token.example.test/token',
      })
    }
    if (href === 'https://poisoned-token.example.test/token') tokenFetches += 1
    return jsonResponse({}, 404)
  }
  const lookup = async (hostname) => [{
    address: hostname === 'poisoned-token.example.test' ? '192.168.1.25' : '93.184.216.34',
    family: 4,
  }]
  const started = await beginMcpOAuth({
    userId,
    serverId: server.id,
    redirectUri: 'http://127.0.0.1:5175/api/mcp/oauth/callback',
    config: { clientId: 'dns-client', clientSecret: 'dns-secret' },
    fetchImpl,
    lookup,
  })

  await assert.rejects(
    () => completeMcpOAuth({ state: started.state, code: 'dns-code', fetchImpl, lookup }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(tokenFetches, 0)
})

test('OAuth token redirects cannot leak secrets across origins', async () => {
  const userId = 'oauth-cross-origin-redirect'
  createUser({ id: userId, email: `${userId}@example.com` })
  const server = upsertServer({
    userId,
    name: 'Redirect policy MCP',
    transport: 'http',
    url: 'https://redirect-policy.example.test/mcp',
    headers: {},
    enabled: true,
    autoApprove: [],
  })
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    const href = String(url)
    requests.push({ url: href, options })
    if (href === 'https://redirect-policy.example.test/.well-known/oauth-protected-resource/mcp') {
      return jsonResponse({
        resource: server.url,
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://redirect-auth.example.test/token',
      })
    }
    if (href === 'https://redirect-auth.example.test/token') {
      return new Response(null, {
        status: 307,
        headers: { location: 'https://credential-thief.example.test/token' },
      })
    }
    throw new Error(`request must not reach ${href}`)
  }
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const started = await beginMcpOAuth({
    userId,
    serverId: server.id,
    redirectUri: 'http://127.0.0.1:5175/api/mcp/oauth/callback',
    config: { clientId: 'redirect-client', clientSecret: 'redirect-secret' },
    fetchImpl,
    lookup,
  })

  await assert.rejects(
    () => completeMcpOAuth({ state: started.state, code: 'redirect-code', fetchImpl, lookup }),
    (error) => error?.code === 'OUTBOUND_REDIRECT_CROSS_ORIGIN',
  )
  const tokenRequest = requests.find(({ url }) => url === 'https://redirect-auth.example.test/token')
  assert.match(tokenRequest.options.headers.Authorization, /^Basic /)
  assert.equal(new URLSearchParams(tokenRequest.options.body).get('code'), 'redirect-code')
  assert.equal(requests.some(({ url }) => url.includes('credential-thief.example.test')), false)
})

test('OAuth token redirects re-check DNS and stop rebinding before a second fetch', async () => {
  const userId = 'oauth-dns-rebinding'
  createUser({ id: userId, email: `${userId}@example.com` })
  const server = upsertServer({
    userId,
    name: 'Rebinding policy MCP',
    transport: 'http',
    url: 'https://rebind-policy.example.test/mcp',
    headers: {},
    enabled: true,
    autoApprove: [],
  })
  let tokenFetches = 0
  let tokenLookups = 0
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href === 'https://rebind-policy.example.test/.well-known/oauth-protected-resource/mcp') {
      return jsonResponse({
        resource: server.url,
        authorization_endpoint: 'https://auth.example.test/authorize',
        token_endpoint: 'https://rebind-auth.example.test/token',
      })
    }
    if (href === 'https://rebind-auth.example.test/token') {
      tokenFetches += 1
      return new Response(null, { status: 307, headers: { location: '/token-next' } })
    }
    throw new Error(`request must not reach ${href}`)
  }
  const lookup = async (hostname) => {
    if (hostname === 'rebind-auth.example.test') {
      tokenLookups += 1
      return [{
        address: tokenLookups === 1 ? '93.184.216.34' : '169.254.169.254',
        family: 4,
      }]
    }
    return [{ address: '93.184.216.34', family: 4 }]
  }
  const started = await beginMcpOAuth({
    userId,
    serverId: server.id,
    redirectUri: 'http://127.0.0.1:5175/api/mcp/oauth/callback',
    config: { clientId: 'rebind-client', clientSecret: 'rebind-secret' },
    fetchImpl,
    lookup,
  })

  await assert.rejects(
    () => completeMcpOAuth({ state: started.state, code: 'rebind-code', fetchImpl, lookup }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(tokenLookups, 2)
  assert.equal(tokenFetches, 1)
})
