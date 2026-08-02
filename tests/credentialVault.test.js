import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-credential-vault-'))
process.env.APP_DATA_DIR = dir
process.env.APP_DB_PATH = path.join(dir, 'app.db')
process.env.CREDENTIAL_KEY_PATH = path.join(dir, '.credentials.key')
delete process.env.CREDENTIAL_ENCRYPTION_KEY

const {
  credentialKeyPath,
  isCredentialEnvelope,
  openCredentialObject,
  sealCredentialObject,
} = await import('../server/utils/credentialVault.js')
const { closeDb, createUser, getDb } = await import('../server/db.js')
const {
  getEnabledIntegrationCredentials,
  upsertIntegration,
} = await import('../server/services/integrationsStore.js')
const {
  buildUserModelEnv,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')
const {
  getServer,
  upsertServer,
} = await import('../server/mcp/mcpStore.js')
const {
  getHook,
  upsertHook,
} = await import('../server/services/hooksService.js')

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('AES-GCM envelope round-trips and rejects tampering or purpose swapping', () => {
  const key = Buffer.alloc(32, 7)
  const sealed = sealCredentialObject({ token: 'vault-secret' }, {
    purpose: 'test-secret',
    key,
  })
  assert.equal(isCredentialEnvelope(sealed), true)
  assert.equal(sealed.includes('vault-secret'), false)
  assert.deepEqual(openCredentialObject(sealed, {
    purpose: 'test-secret',
    key,
  }), {
    value: { token: 'vault-secret' },
    legacy: false,
  })
  assert.throws(
    () => openCredentialObject(sealed, { purpose: 'different-purpose', key }),
    (error) => error.code === 'CREDENTIAL_VAULT_ENVELOPE_INVALID',
  )

  const tampered = JSON.parse(sealed)
  tampered.data = `${tampered.data[0] === 'A' ? 'B' : 'A'}${tampered.data.slice(1)}`
  assert.throws(
    () => openCredentialObject(JSON.stringify(tampered), { purpose: 'test-secret', key }),
    (error) => error.code === 'CREDENTIAL_VAULT_DECRYPT_FAILED',
  )
})

test('integration tokens and model provider secrets are encrypted at rest', () => {
  createUser({ id: 'u-vault', email: 'vault@example.com' })
  const integration = upsertIntegration({
    userId: 'u-vault',
    provider: 'github',
    name: 'GitHub',
    enabled: true,
    config: {},
    secret: { token: 'github-at-rest-secret' },
  })
  const provider = upsertModelProvider({
    userId: 'u-vault',
    provider: {
      key: 'vault-model',
      label: 'Vault Model',
      baseUrl: 'https://models.example.com/v1',
      apiKey: 'model-at-rest-secret',
      headers: { Authorization: 'header-at-rest-secret' },
      models: ['vault-1'],
      defaultModel: 'vault-1',
    },
  })

  const integrationRow = getDb().prepare('SELECT secret_json FROM integrations WHERE id = ?').get(integration.id)
  const providerRow = getDb().prepare(
    'SELECT secret_json, headers_json FROM model_providers WHERE id = ?',
  ).get(provider.id)
  for (const raw of [integrationRow.secret_json, providerRow.secret_json, providerRow.headers_json]) {
    assert.equal(isCredentialEnvelope(raw), true)
    assert.equal(raw.includes('at-rest-secret'), false)
  }
  assert.equal(
    getEnabledIntegrationCredentials({ userId: 'u-vault', provider: 'github' }).secret.token,
    'github-at-rest-secret',
  )
  const env = buildUserModelEnv({ userId: 'u-vault', env: {} })
  assert.equal(env.MODEL_PROVIDER_VAULT_MODEL_API_KEY, 'model-at-rest-secret')
  assert.equal(JSON.parse(env.MODEL_PROVIDER_VAULT_MODEL_HEADERS).Authorization, 'header-at-rest-secret')

  const keyPath = credentialKeyPath(process.env)
  assert.equal(fs.existsSync(keyPath), true)
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600)
})

test('legacy integration JSON and model-provider base64 migrate on first read', () => {
  createUser({ id: 'u-vault-legacy', email: 'vault-legacy@example.com' })
  const integration = upsertIntegration({
    userId: 'u-vault-legacy',
    provider: 'notion',
    name: 'Notion',
    enabled: true,
    config: {},
    secret: { token: 'new-token' },
  })
  const provider = upsertModelProvider({
    userId: 'u-vault-legacy',
    provider: {
      key: 'legacy-model',
      label: 'Legacy Model',
      baseUrl: 'https://legacy.example.com/v1',
      models: ['legacy-1'],
      defaultModel: 'legacy-1',
    },
  })
  const legacySecret = Buffer.from(JSON.stringify({ apiKey: 'legacy-api-key' }), 'utf8').toString('base64')
  const legacyHeaders = Buffer.from(JSON.stringify({ 'X-Legacy': 'legacy-header' }), 'utf8').toString('base64')
  getDb().prepare('UPDATE integrations SET secret_json = ? WHERE id = ?')
    .run(JSON.stringify({ token: 'legacy-integration-token' }), integration.id)
  getDb().prepare('UPDATE model_providers SET secret_json = ?, headers_json = ? WHERE id = ?')
    .run(legacySecret, legacyHeaders, provider.id)

  assert.equal(
    getEnabledIntegrationCredentials({ userId: 'u-vault-legacy', provider: 'notion' }).secret.token,
    'legacy-integration-token',
  )
  const env = buildUserModelEnv({ userId: 'u-vault-legacy', env: {} })
  assert.equal(env.MODEL_PROVIDER_LEGACY_MODEL_API_KEY, 'legacy-api-key')
  assert.equal(JSON.parse(env.MODEL_PROVIDER_LEGACY_MODEL_HEADERS)['X-Legacy'], 'legacy-header')

  const integrationRow = getDb().prepare('SELECT secret_json FROM integrations WHERE id = ?').get(integration.id)
  const providerRow = getDb().prepare(
    'SELECT secret_json, headers_json FROM model_providers WHERE id = ?',
  ).get(provider.id)
  assert.equal(isCredentialEnvelope(integrationRow.secret_json), true)
  assert.equal(isCredentialEnvelope(providerRow.secret_json), true)
  assert.equal(isCredentialEnvelope(providerRow.headers_json), true)
})

test('MCP environment, MCP headers, and hook headers are encrypted at rest', () => {
  createUser({ id: 'u-vault-tools', email: 'vault-tools@example.com' })
  const server = upsertServer({
    userId: 'u-vault-tools',
    name: 'Vault MCP',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { MCP_TOKEN: 'mcp-env-at-rest-secret' },
    headers: { Authorization: 'mcp-header-at-rest-secret' },
    enabled: true,
    autoApprove: [],
  })
  const hook = upsertHook({
    userId: 'u-vault-tools',
    event: 'pre_tool_use',
    toolPattern: '*',
    kind: 'http',
    url: 'https://hooks.example.com/guard',
    headers: { Authorization: 'hook-header-at-rest-secret' },
    enabled: true,
    blocking: true,
    timeoutMs: 1000,
  })

  const serverRow = getDb().prepare(
    'SELECT env_json, headers_json FROM mcp_servers WHERE id = ?',
  ).get(server.id)
  const hookRow = getDb().prepare('SELECT headers_json FROM hooks WHERE id = ?').get(hook.id)
  for (const raw of [serverRow.env_json, serverRow.headers_json, hookRow.headers_json]) {
    assert.equal(isCredentialEnvelope(raw), true)
    assert.equal(raw.includes('at-rest-secret'), false)
  }
  assert.equal(getServer('u-vault-tools', server.id).env.MCP_TOKEN, 'mcp-env-at-rest-secret')
  assert.equal(
    getServer('u-vault-tools', server.id).headers.Authorization,
    'mcp-header-at-rest-secret',
  )
  assert.equal(
    getHook('u-vault-tools', hook.id).headers.Authorization,
    'hook-header-at-rest-secret',
  )
})

test('legacy MCP base64 and hook JSON credentials migrate on first read', () => {
  createUser({ id: 'u-vault-tools-legacy', email: 'vault-tools-legacy@example.com' })
  const server = upsertServer({
    userId: 'u-vault-tools-legacy',
    name: 'Legacy MCP',
    transport: 'stdio',
    command: 'node',
    env: {},
    headers: {},
    enabled: true,
    autoApprove: [],
  })
  const hook = upsertHook({
    userId: 'u-vault-tools-legacy',
    event: 'pre_tool_use',
    toolPattern: '*',
    kind: 'http',
    url: 'https://hooks.example.com/legacy',
    headers: {},
    enabled: true,
    blocking: true,
    timeoutMs: 1000,
  })
  const legacyEnv = Buffer.from(JSON.stringify({ MCP_TOKEN: 'legacy-mcp-env' }), 'utf8').toString('base64')
  const legacyHeaders = Buffer.from(JSON.stringify({ Authorization: 'legacy-mcp-header' }), 'utf8').toString('base64')
  getDb().prepare('UPDATE mcp_servers SET env_json = ?, headers_json = ? WHERE id = ?')
    .run(legacyEnv, legacyHeaders, server.id)
  getDb().prepare('UPDATE hooks SET headers_json = ? WHERE id = ?')
    .run(JSON.stringify({ Authorization: 'legacy-hook-header' }), hook.id)

  const restoredServer = getServer('u-vault-tools-legacy', server.id)
  const restoredHook = getHook('u-vault-tools-legacy', hook.id)
  assert.equal(restoredServer.env.MCP_TOKEN, 'legacy-mcp-env')
  assert.equal(restoredServer.headers.Authorization, 'legacy-mcp-header')
  assert.equal(restoredHook.headers.Authorization, 'legacy-hook-header')

  const serverRow = getDb().prepare(
    'SELECT env_json, headers_json FROM mcp_servers WHERE id = ?',
  ).get(server.id)
  const hookRow = getDb().prepare('SELECT headers_json FROM hooks WHERE id = ?').get(hook.id)
  assert.equal(isCredentialEnvelope(serverRow.env_json), true)
  assert.equal(isCredentialEnvelope(serverRow.headers_json), true)
  assert.equal(isCredentialEnvelope(hookRow.headers_json), true)
})
