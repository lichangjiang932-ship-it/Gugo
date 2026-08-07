import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-qq-mail-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { closeDb, createUser } = await import('../server/db.js')
const {
  getIntegrationByProvider,
  getIntegrationCredentialsById,
  listProviderRegistry,
  testIntegration,
  upsertIntegration,
} = await import('../server/services/integrationsStore.js')
const {
  listQqMailMessages,
  readQqMailMessage,
  sendQqMailMessage,
} = await import('../server/services/connectorService.js')
const {
  _mailInternals,
  probeSmtp,
  resolveQqMailSettings,
  sendSmtpMessage,
  testQqMailCredentials,
} = await import('../server/services/mailProtocolClient.js')
const { handleConnectorRequest } = await import('../server/routes/connectorRoutes.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const userId = 'u-qq-mail'
createUser({ id: userId, email: 'qq-mail-owner@example.com' })

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('QQ Mail settings use secure QQ defaults and support legacy SMTP aliases', () => {
  const settings = resolveQqMailSettings({
    allowEnvCredentials: true,
    env: {
      MAIL_SERVER: 'smtp.qq.com',
      MAIL_USERNAME: '123456@qq.com',
      MAIL_PASSWORD: 'qq-authorization-code',
      MAIL_DEFAULT_SENDER: '123456@qq.com',
    },
  })
  assert.equal(settings.smtpHost, 'smtp.qq.com')
  assert.equal(settings.smtpPort, 465)
  assert.equal(settings.smtpSecure, true)
  assert.equal(settings.imapHost, 'imap.qq.com')
  assert.equal(settings.imapPort, 993)
  assert.equal(settings.imapSecure, true)
})

test('QQ Mail user connectors never inherit process credentials or connect to custom hosts', () => {
  assert.throws(
    () => resolveQqMailSettings({
      config: {
        user: 'victim@qq.com',
        smtpHost: 'mail.attacker.example',
        imapHost: 'mail.attacker.example',
      },
      secret: {},
      env: {
        MAIL_USER: 'global@qq.com',
        MAIL_PASSWORD: 'global-authorization-code',
      },
    }),
    /MAIL_PASSWORD is required/,
  )

  assert.throws(
    () => resolveQqMailSettings({
      config: { user: 'victim@qq.com', smtpHost: 'mail.attacker.example' },
      secret: { password: 'user-authorization-code' },
      env: {},
    }),
    /SMTP host must be smtp\.qq\.com/,
  )
})

test('mail protocol rejects private SMTP targets before opening a socket', async () => {
  let connected = false
  await assert.rejects(
    probeSmtp({
      smtpHost: '127.0.0.1', smtpPort: 465, smtpSecure: true,
      timeoutMs: 100, user: 'user@example.com', password: 'secret',
    }, {
      tlsConnect: () => { connected = true; throw new Error('must not connect') },
    }),
    /private|loopback/i,
  )
  assert.equal(connected, false)
})

test('local auth QQ Mail connectors inherit MAIL_* settings for tests and operations', async () => {
  const localUserId = 'u-qq-mail-local-env'
  createUser({ id: localUserId, email: 'qq-mail-local-env@example.com' })
  const integration = upsertIntegration({
    userId: localUserId,
    provider: 'qq_mail',
    enabled: true,
    config: {},
    secret: {},
  })
  const env = {
    AUTH_MODE: 'local',
    MAIL_HOST: 'smtp.qq.com',
    MAIL_PORT: '587',
    MAIL_IMAP_HOST: 'imap.qq.com',
    MAIL_IMAP_PORT: '993',
    MAIL_USER: '778899@qq.com',
    MAIL_PASSWORD: 'local-env-authorization-code',
    MAIL_FROM: '778899@qq.com',
  }
  const observed = []
  const mailClient = {
    listMessages: async (settings) => {
      observed.push(['list', settings])
      return { messages: [] }
    },
    probeSmtp: async (settings) => { observed.push(['smtp', settings]) },
    probeImap: async (settings) => { observed.push(['imap', settings]) },
  }

  await listQqMailMessages({ userId: localUserId, env, mailClient })
  const tested = await testIntegration({ userId: localUserId, id: integration.id, env, mailClient })
  assert.equal(tested.ok, true)
  assert.deepEqual(observed.map(([kind]) => kind), ['list', 'smtp', 'imap'])
  for (const [, settings] of observed) {
    assert.equal(settings.user, '778899@qq.com')
    assert.equal(settings.password, 'local-env-authorization-code')
    assert.equal(settings.smtpPort, 587)
    assert.equal(settings.smtpStartTls, true)
    assert.equal(settings.imapPort, 993)
  }
})

test('multi_user QQ Mail connectors never inherit global MAIL_* credentials', async () => {
  const multiUserId = 'u-qq-mail-multi-env'
  createUser({ id: multiUserId, email: 'qq-mail-multi-env@example.com' })
  const integration = upsertIntegration({
    userId: multiUserId,
    provider: 'qq_mail',
    enabled: true,
    config: { user: '112233@qq.com' },
    secret: {},
  })
  const env = {
    AUTH_MODE: 'multi_user',
    MAIL_USER: 'global@qq.com',
    MAIL_PASSWORD: 'global-must-not-be-used',
    MAIL_PORT: '587',
  }
  let called = false
  const mailClient = {
    listMessages: async () => { called = true; return { messages: [] } },
    probeSmtp: async () => { called = true },
    probeImap: async () => { called = true },
  }

  await assert.rejects(
    listQqMailMessages({ userId: multiUserId, env, mailClient }),
    /MAIL_PASSWORD is required/,
  )
  const tested = await testIntegration({ userId: multiUserId, id: integration.id, env, mailClient })
  assert.equal(tested.ok, false)
  assert.equal(tested.message.includes('global-must-not-be-used'), false)
  assert.equal(called, false)
})

test('QQ Mail only allows official TLS endpoints', () => {
  const startTls = resolveQqMailSettings({
    config: { user: '123456@qq.com', smtpPort: 587 },
    secret: { password: 'authorization-code' },
    env: {},
  })
  assert.equal(startTls.smtpHost, 'smtp.qq.com')
  assert.equal(startTls.smtpSecure, false)
  assert.equal(startTls.smtpStartTls, true)
  assert.throws(
    () => resolveQqMailSettings({
      config: { user: '123456@qq.com', imapPort: 143 },
      secret: { password: 'authorization-code' },
      env: {},
    }),
    /IMAP port must be 993/,
  )
})

test('QQ Mail rejects control characters, oversized addresses, and unverified senders', async () => {
  const settings = resolveQqMailSettings({
    config: { user: '123456@qq.com' },
    secret: { password: 'authorization-code' },
    env: {},
  })
  assert.equal(settings.from, settings.user)
  assert.throws(
    () => resolveQqMailSettings({
      config: { user: '123456@qq.com', from: 'alias@qq.com' },
      secret: { password: 'authorization-code' },
      env: {},
    }),
    /MAIL_FROM must match MAIL_USER/,
  )
  assert.throws(
    () => resolveQqMailSettings({
      config: { user: '123456@qq.com' },
      secret: { password: 'authorization\u0001code' },
      env: {},
    }),
    /MAIL_PASSWORD is invalid/,
  )
  await assert.rejects(
    sendSmtpMessage(settings, { to: 'bad\u0000@example.com', subject: 'Status', text: 'Done' }),
    /recipient is invalid/,
  )
  await assert.rejects(
    sendSmtpMessage(settings, { to: `${'a'.repeat(65)}@example.com`, subject: 'Status', text: 'Done' }),
    /recipient is invalid/,
  )
  await assert.rejects(
    sendSmtpMessage(settings, { to: 'valid@example.com', subject: 'bad\u0000subject', text: 'Done' }),
    /subject is invalid/,
  )
  await assert.rejects(
    sendSmtpMessage(settings, {
      from: 'alias@qq.com', to: 'valid@example.com', subject: 'Status', text: 'Done',
    }),
    /sender must match the authenticated QQ Mail account/,
  )
})

test('QQ Mail integration never exposes its authorization code', async () => {
  const authorizationCode = 'qq-auth-code-private'
  const integration = upsertIntegration({
    userId,
    provider: 'qq_mail',
    enabled: true,
    config: { user: '123456@qq.com' },
    secret: { password: authorizationCode },
  })
  assert.deepEqual(integration.secret.password, { present: true })
  assert.equal(JSON.stringify(integration).includes(authorizationCode), false)
  assert.equal(listProviderRegistry().find((provider) => provider.provider === 'qq_mail')?.capabilityLevel, 'native_api')

  const probes = []
  const tested = await testIntegration({
    userId,
    id: integration.id,
    env: {},
    mailClient: {
      probeSmtp: async (settings) => { probes.push(['smtp', settings.user]) },
      probeImap: async (settings) => { probes.push(['imap', settings.user]) },
    },
  })
  assert.equal(tested.ok, true)
  assert.deepEqual(probes, [['smtp', '123456@qq.com'], ['imap', '123456@qq.com']])
  assert.equal(JSON.stringify(getIntegrationByProvider({ userId, provider: 'qq_mail' })).includes(authorizationCode), false)
})

test('integration credential lookup requires the owning user', () => {
  const ownerId = 'u-qq-mail-isolation-owner'
  const otherId = 'u-qq-mail-isolation-other'
  createUser({ id: ownerId, email: 'mail-isolation-owner@example.com' })
  createUser({ id: otherId, email: 'mail-isolation-other@example.com' })
  const integration = upsertIntegration({
    userId: ownerId,
    provider: 'qq_mail',
    enabled: true,
    config: { user: '112233@qq.com' },
    secret: { password: 'owner-only-code' },
  })
  assert.equal(getIntegrationCredentialsById({ userId: otherId, id: integration.id }), null)
  assert.equal(getIntegrationCredentialsById({ id: integration.id }), null)
  assert.equal(
    getIntegrationCredentialsById({ userId: ownerId, id: integration.id })?.secret?.password,
    'owner-only-code',
  )
})

test('QQ Mail probe redacts secrets from transport errors', async () => {
  const authorizationCode = 'must-never-leak'
  const result = await testQqMailCredentials({
    config: { user: '123456@qq.com' },
    secret: { password: authorizationCode },
    env: {},
    mailClient: {
      probeSmtp: async () => { throw new Error(`authentication rejected: ${authorizationCode}`) },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.message.includes(authorizationCode), false)
  assert.match(result.message, /\[redacted\]/)
})

test('QQ Mail connector lists, reads, and sends through the enabled user-scoped account', async () => {
  const calls = []
  const mailClient = {
    listMessages: async (settings, input) => {
      calls.push(['list', settings.user, input.limit])
      return { messages: [{ uid: '9', subject: 'Status' }] }
    },
    readMessage: async (settings, input) => {
      calls.push(['read', settings.user, input.uid])
      return { uid: input.uid, text: 'Ready' }
    },
    sendMessage: async (settings, input) => {
      calls.push(['send', settings.user, input.to])
      return { sent: true, to: [input.to] }
    },
  }
  const listed = await listQqMailMessages({ userId, limit: 5, env: {}, mailClient })
  const read = await readQqMailMessage({ userId, uid: '9', env: {}, mailClient })
  const sent = await sendQqMailMessage({
    userId,
    to: 'recipient@example.com',
    subject: 'Status',
    text: 'Ready',
    env: {},
    mailClient,
  })
  assert.equal(listed.messages[0].uid, '9')
  assert.equal(read.text, 'Ready')
  assert.equal(sent.sent, true)
  assert.deepEqual(calls, [
    ['list', '123456@qq.com', 5],
    ['read', '123456@qq.com', '9'],
    ['send', '123456@qq.com', 'recipient@example.com'],
  ])
})

test('mail MIME helpers decode encoded headers and quoted-printable text', () => {
  assert.equal(_mailInternals.decodeHeader('=?UTF-8?B?5bel5L2c5rGH5oql?='), '工作汇报')
  const decoded = _mailInternals.decodeMimeEntity([
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=E4=BB=BB=E5=8A=A1=E5=AE=8C=E6=88=90',
  ].join('\r\n'))
  assert.equal(decoded.text, '任务完成')
})

test('mail protocol readers destroy sockets on timeout or oversized responses', async () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super()
      this.destroyed = false
    }

    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('close')
    }
  }

  const oversizedSocket = new FakeSocket()
  const oversizedReader = _mailInternals.createResponseReader(oversizedSocket, { timeoutMs: 100, maxBytes: 4 })
  const oversizedRead = oversizedReader.read(() => -1)
  oversizedSocket.emit('data', Buffer.from('12345'))
  await assert.rejects(oversizedRead, (error) => error?.code === 'MAIL_RESPONSE_TOO_LARGE')
  assert.equal(oversizedSocket.destroyed, true)
  oversizedReader.close()

  const timeoutSocket = new FakeSocket()
  const timeoutReader = _mailInternals.createResponseReader(timeoutSocket, { timeoutMs: 10, maxBytes: 32 })
  await assert.rejects(timeoutReader.read(() => -1), (error) => error?.code === 'MAIL_TIMEOUT')
  assert.equal(timeoutSocket.destroyed, true)
  timeoutReader.close()
})

test('mail operations have a hard deadline and list metadata has a cumulative cap', async () => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super()
      this.destroyed = false
    }

    destroy() {
      this.destroyed = true
    }
  }

  const socket = new FakeSocket()
  const reader = _mailInternals.createResponseReader(socket, { timeoutMs: 100, maxBytes: 32 })
  await assert.rejects(
    _mailInternals.runBoundedSessionOperation(
      { socket, reader },
      () => new Promise(() => {}),
      10,
    ),
    (error) => error?.code === 'MAIL_OPERATION_TIMEOUT',
  )
  assert.equal(socket.destroyed, true)
  reader.close()

  const messages = []
  assert.throws(
    () => _mailInternals.appendBoundedListMessage(messages, { subject: 'x'.repeat(300 * 1024) }, 0),
    (error) => error?.code === 'MAIL_RESPONSE_TOO_LARGE',
  )
  assert.equal(messages.length, 0)
})

test('QQ Mail HTTP routes require authentication and expose list, read, and send actions', async () => {
  const session = issueTestSession({ email: 'qq-mail-route@example.com' })
  const authorizationCode = 'route-private-code'
  upsertIntegration({
    userId: session.userId,
    provider: 'qq_mail',
    enabled: true,
    config: { user: '654321@qq.com' },
    secret: { password: authorizationCode },
  })
  const mailClient = {
    listMessages: async (_settings, { limit }) => ({ messages: [{ uid: '7', subject: `Latest ${limit}` }] }),
    readMessage: async (_settings, { uid }) => ({ uid, text: 'Route body' }),
    sendMessage: async (_settings, input) => ({ sent: true, to: [input.to], subject: input.subject }),
  }
  const server = http.createServer((req, res) => handleConnectorRequest(req, res, { env: {}, mailClient }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }
  try {
    const denied = await fetch(`${baseUrl}/api/connectors/qq-mail/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(denied.status, 401)

    const listed = await fetch(`${baseUrl}/api/connectors/qq-mail/messages`, {
      method: 'POST', headers, body: JSON.stringify({ limit: 3 }),
    }).then((response) => response.json())
    const read = await fetch(`${baseUrl}/api/connectors/qq-mail/message`, {
      method: 'POST', headers, body: JSON.stringify({ uid: '7' }),
    }).then((response) => response.json())
    const sent = await fetch(`${baseUrl}/api/connectors/qq-mail/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: 'receiver@example.com', subject: 'Report', text: 'Done' }),
    }).then((response) => response.json())
    assert.equal(listed.result.messages[0].subject, 'Latest 3')
    assert.equal(read.result.text, 'Route body')
    assert.equal(sent.result.sent, true)
    assert.equal(JSON.stringify({ listed, read, sent }).includes(authorizationCode), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
