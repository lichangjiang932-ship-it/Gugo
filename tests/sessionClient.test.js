import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deleteSessionRemote,
  importAllLegacySessionsRemote,
  listAllSessionsRemote,
  listSessionCatalogRemote,
  listSessionsRemote,
  normalizeSessionMessagesForServer,
  pinSessionRemote,
  replaceSessionMessagesRemote,
  selectLegacySessionImportCandidates,
  setSessionWorkspaceRemote,
  unpinSessionRemote,
} from '../src/lib/sessionClient.js'

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('replaceSessionMessagesRemote sends the expected revision and exact messages', async () => {
  let request = null
  const messages = [{ id: 'm1', role: 'user', content: 'keep this exact message' }]
  const result = await replaceSessionMessagesRemote('session/one', {
    expectedRevision: 41,
    messages,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return response({ ok: true, revision: 42 })
    },
  })

  assert.equal(request.url, '/api/sessions/session%2Fone/messages')
  assert.equal(request.options.method, 'PUT')
  assert.equal(request.options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(request.options.body), { expectedRevision: 41, messages })
  assert.equal(result.revision, 42)
})

test('deleteSessionRemote includes the expected revision in its request body', async () => {
  let request = null
  await deleteSessionRemote('session/one', {
    expectedRevision: 9,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return response({ ok: true })
    },
  })

  assert.equal(request.url, '/api/sessions/session%2Fone')
  assert.equal(request.options.method, 'DELETE')
  assert.deepEqual(JSON.parse(request.options.body), { expectedRevision: 9 })
})

test('session pin clients use encoded user-scoped endpoints', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    return response({ ok: true, session: { id: 'session/one' } })
  }

  await pinSessionRemote('session/one', { fetchImpl })
  await unpinSessionRemote('session/one', { fetchImpl })

  assert.deepEqual(requests.map(({ url }) => url), [
    '/api/sessions/session%2Fone/pin',
    '/api/sessions/session%2Fone/unpin',
  ])
  assert.ok(requests.every(({ options }) => options.method === 'POST'))
})

test('session mutation clients preserve structured conflict errors', async () => {
  await assert.rejects(
    replaceSessionMessagesRemote('s-conflict', {
      expectedRevision: 1,
      messages: [],
      fetchImpl: async () => response({
        error: {
          code: 'SESSION_REVISION_CONFLICT',
          message: 'session changed',
          currentRevision: 2,
        },
      }, 409),
    }),
    (error) => {
      assert.equal(error.name, 'SessionRequestError')
      assert.equal(error.code, 'SESSION_REVISION_CONFLICT')
      assert.equal(error.status, 409)
      assert.equal(error.details.currentRevision, 2)
      return true
    },
  )
})

test('session workspace client persists canonical selections and explicit clears', async () => {
  const requests = []
  const fetchImpl = async (url, options) => {
    const workspacePath = JSON.parse(options.body).workspacePath
    requests.push({ url, options, workspacePath })
    return response({
      ok: true,
      session: { id: 'session/one', revision: 4, workspacePath },
    })
  }

  await setSessionWorkspaceRemote('session/one', '  C:\\Project  ', { fetchImpl })
  await setSessionWorkspaceRemote('session/one', '', { fetchImpl })

  assert.deepEqual(requests.map(({ url, workspacePath }) => ({ url, workspacePath })), [
    { url: '/api/sessions/session%2Fone/workspace', workspacePath: 'C:\\Project' },
    { url: '/api/sessions/session%2Fone/workspace', workspacePath: null },
  ])
  assert.ok(requests.every(({ options }) => (
    options.method === 'PUT' && options.headers['Content-Type'] === 'application/json'
  )))
})

test('session catalog client requests every user-scoped metadata page', async () => {
  const requests = []
  const firstPage = Array.from({ length: 2 }, (_, index) => ({
    id: `session-${index + 1}`,
    revision: index + 1,
  }))
  const sessions = await listAllSessionsRemote({
    pageSize: 2,
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return response({
        sessions: requests.length === 1
          ? firstPage
          : [{ id: 'session-3', revision: 3 }],
      })
    },
  })

  assert.deepEqual(requests.map(({ url }) => url), [
    '/api/sessions?archived=all&limit=2&offset=0',
    '/api/sessions?archived=all&limit=2&offset=2',
  ])
  assert.ok(requests.every(({ options }) => options.signal === undefined))
  assert.deepEqual(sessions.map(({ id }) => id), ['session-1', 'session-2', 'session-3'])
})

test('session catalog exposes one stable backend and normalized workspace source across pages', async () => {
  const source = {
    version: 1,
    backendInstanceId: 'sqlite:0123456789abcdef',
    workspaceScope: {
      key: 'workspace:fedcba9876543210',
      path: 'D:\\work\\project',
    },
  }
  let requests = 0
  const catalog = await listSessionCatalogRemote({
    pageSize: 1,
    fetchImpl: async () => {
      requests += 1
      return response({
        sessions: requests === 1 ? [{ id: 'one', revision: 1 }] : [],
        source,
      })
    },
  })

  assert.deepEqual(catalog, {
    sessions: [{ id: 'one', revision: 1 }],
    source,
  })
})

test('session catalog never combines pages from different backend data sources', async () => {
  let requests = 0
  await assert.rejects(
    listSessionCatalogRemote({
      pageSize: 1,
      fetchImpl: async () => {
        requests += 1
        return response({
          sessions: requests === 1 ? [{ id: 'one', revision: 1 }] : [],
          source: {
            version: 1,
            backendInstanceId: `sqlite:${requests}`,
            workspaceScope: { key: 'workspace:one', path: 'D:\\work\\project' },
          },
        })
      },
    }),
    (error) => error?.code === 'SESSION_CATALOG_SOURCE_CHANGED',
  )
})

test('legacy catalog responses remain compatible without source metadata', async () => {
  const catalog = await listSessionCatalogRemote({
    fetchImpl: async () => response({ sessions: [{ id: 'legacy', revision: 1 }] }),
  })
  assert.deepEqual(catalog, {
    sessions: [{ id: 'legacy', revision: 1 }],
    source: null,
  })
})

test('session catalog client rejects malformed server results', async () => {
  await assert.rejects(
    listSessionsRemote({ fetchImpl: async () => response({ sessions: null }) }),
    (error) => error?.code === 'INVALID_SESSION_CATALOG',
  )
})

test('legacy import candidates include every local session and omit transient messages', () => {
  const sessions = [
    {
      id: 'legacy-history',
      title: 'Legacy',
      createdAt: 10,
      updatedAt: 20,
      messages: [
        { id: 'stable', role: 'user', content: 'keep', timestamp: 11 },
        { id: 'streaming', role: 'assistant', content: 'partial', meta: { streaming: true } },
        { id: 'pending', role: 'assistant', content: 'pending', meta: { pendingServerSync: true } },
      ],
    },
    { id: 'local-empty', messages: [] },
    { id: 'server-backed', serverRevision: 0, messages: [{ id: 'server', role: 'user', content: 'skip' }] },
  ]
  const original = structuredClone(sessions)

  const candidates = selectLegacySessionImportCandidates(sessions)

  assert.deepEqual(candidates.map(({ id }) => id), ['legacy-history', 'local-empty'])
  assert.deepEqual(candidates[0].messages, [{
    id: 'stable',
    role: 'user',
    content: 'keep',
    createdAt: 11,
  }])
  assert.deepEqual(candidates[1].messages, [])
  assert.deepEqual(sessions, original)
})

test('legacy import client batches requests and leaves caller-owned sessions untouched on failure', async () => {
  const sessions = Array.from({ length: 45 }, (_, index) => ({
    id: `legacy-${index}`,
    title: `Legacy ${index}`,
    messages: [{ id: `message-${index}`, role: 'user', content: 'history' }],
  }))
  const original = structuredClone(sessions)
  const batchSizes = []
  const result = await importAllLegacySessionsRemote(sessions, {
    fetchImpl: async (url, options) => {
      assert.equal(url, '/api/sessions/import')
      assert.equal(options.method, 'POST')
      const body = JSON.parse(options.body)
      batchSizes.push(body.sessions.length)
      return response({
        results: body.sessions.map((session) => ({
          id: session.id,
          status: 'imported',
          session: { id: session.id, revision: 1 },
        })),
        importedCount: body.sessions.length,
        serverAuthoritativeCount: 0,
      })
    },
  })

  assert.deepEqual(batchSizes, [20, 20, 5])
  assert.equal(result.importedCount, 45)
  assert.deepEqual(sessions, original)

  let calls = 0
  await assert.rejects(
    importAllLegacySessionsRemote(sessions, {
      fetchImpl: async () => {
        calls += 1
        if (calls === 2) return response({ error: { code: 'IMPORT_FAILED', message: 'failed' } }, 500)
        return response({
          results: Array.from({ length: 20 }, (_, index) => ({
            id: `legacy-${index}`,
            status: 'imported',
            session: { id: `legacy-${index}`, revision: 1 },
          })),
          importedCount: 20,
          serverAuthoritativeCount: 0,
        })
      },
    }),
    (error) => error?.code === 'IMPORT_FAILED',
  )
  assert.equal(calls, 2)
  assert.deepEqual(sessions, original)
})

test('session message DTO keeps timestamps and restores UI tool context', () => {
  const [message] = normalizeSessionMessagesForServer([{
    id: 'assistant-1',
    role: 'assistant',
    content: 'done',
    timestamp: 100,
    updatedAt: 120,
    attachments: [{ name: 'local-only.png' }],
    meta: {
      serverTurnId: 'turn-1',
      toolCalls: [{
        id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
        result: '{"ok":true,"content":"hello"}',
      }],
    },
  }])

  assert.deepEqual(Object.keys(message).sort(), [
    'content', 'createdAt', 'id', 'modelContext', 'role', 'updatedAt',
  ])
  assert.equal(message.createdAt, 100)
  assert.equal(message.updatedAt, 120)
  assert.equal(message.modelContext.turnId, 'turn-1')
  assert.equal(message.modelContext.toolTrace[0].tool_calls[0].function.name, 'read_file')
  assert.equal(message.modelContext.toolTrace[1].tool_call_id, 'call-1')
  assert.equal(message.modelContext.toolTrace[1].content, '{"ok":true,"content":"hello"}')
})

test('session message DTO preserves an explicit archived tool trace', () => {
  const toolTrace = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'archived-call' }] },
    { role: 'tool', tool_call_id: 'archived-call', content: 'archived result' },
  ]
  const [message] = normalizeSessionMessagesForServer([{
    id: 'restored-message',
    role: 'assistant',
    content: 'restored',
    meta: { toolTrace, toolCalls: [{ id: 'different', name: 'ignored' }] },
  }])
  assert.deepEqual(message.modelContext.toolTrace, toolTrace)
})
