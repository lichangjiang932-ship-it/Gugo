import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-session-sync-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, getDb } = await import('../server/db.js')
const { handleSessionRequest } = await import('../server/routes/sessionRoutes.js')
const {
  deleteSession,
  getSession,
  getSessionSnapshot,
  listMessages,
  replaceSessionMessages,
  SessionRevisionConflictError,
  upsertMessage,
  upsertSession,
} = await import('../server/services/sessionStore.js')
const { appendTurnEvent } = await import('../server/services/turnEventStore.js')
const {
  buildAssistantModelContext,
  expandStoredMessages,
  extractVerifiedLocalFiles,
  materializeManagedAttachmentMessages,
  selectAttachmentIdsForModelRequest,
  selectStoredMessagesAfterCompaction,
  TURN_TOOL_CONTEXT_LIMITS,
} = await import('../server/services/turnMessageContext.js')
const { normalizeSessionMessagesForServer } = await import('../src/lib/sessionClient.js')
const { normalizeServerSessionSnapshot } = await import('../src/lib/turnClient.js')
const { createTurnEvent } = await import('../shared/turnEvents.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function makeRequest({ method = 'GET', url, token, body = null }) {
  const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = token ? { authorization: `Bearer ${token}` } : {}
  if (body !== null) req.headers['content-type'] = 'application/json'
  return req
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(chunk = '') {
      if (chunk) this.chunks.push(Buffer.from(String(chunk)))
    },
    json() {
      return JSON.parse(Buffer.concat(this.chunks).toString('utf8'))
    },
  }
}

async function invokeRoute(options, engine = { hasActiveSession: () => false }) {
  const res = makeResponse()
  await handleSessionRequest(makeRequest(options), res, engine)
  return res
}

test('session snapshots paginate complete histories without changing revision', { concurrency: false }, async () => {
  const { token, userId } = issueTestSession({ email: 'session-pages@example.com' })
  const sessionId = 'session-pages'
  upsertSession({ id: sessionId, userId, title: 'Paged history', createdAt: 1, updatedAt: 1 })
  const db = getDb()
  const insert = db.prepare(`
    INSERT INTO messages
      (id, session_id, user_id, role, content, session_title, model_context_json, created_at, updated_at)
    VALUES (?, ?, ?, 'user', ?, 'Paged history', '{}', ?, ?)
  `)
  db.transaction(() => {
    for (let index = 0; index < 2005; index += 1) {
      insert.run(`page-message-${index}`, sessionId, userId, `message ${index}`, index + 1, index + 1)
    }
  })()

  const first = await invokeRoute({
    url: `/api/sessions/${sessionId}/snapshot?limit=2000&offset=0`,
    token,
  })
  assert.equal(first.statusCode, 200)
  const firstSnapshot = first.json().snapshot
  assert.equal(firstSnapshot.messages.length, 2000)
  assert.equal(firstSnapshot.totalMessages, 2005)
  assert.equal(firstSnapshot.complete, false)
  assert.equal(firstSnapshot.nextOffset, 2000)

  const second = await invokeRoute({
    url: `/api/sessions/${sessionId}/snapshot?limit=2000&offset=${firstSnapshot.nextOffset}`,
    token,
  })
  assert.equal(second.statusCode, 200)
  const secondSnapshot = second.json().snapshot
  assert.equal(secondSnapshot.messages.length, 5)
  assert.equal(secondSnapshot.messages[0].id, 'page-message-2000')
  assert.equal(secondSnapshot.complete, true)
  assert.equal(secondSnapshot.nextOffset, null)
  assert.equal(secondSnapshot.revision, firstSnapshot.revision)
})

test('CAS replacement preserves stored model context and rejects a stale revision', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-cas@example.com' })
  const sessionId = 'session-cas'
  upsertSession({ id: sessionId, userId, title: 'CAS history', createdAt: 1, updatedAt: 1 })
  upsertMessage({
    id: 'cas-assistant',
    userId,
    sessionId,
    role: 'assistant',
    content: 'old',
    modelContext: {
      version: 1,
      toolTrace: [{ role: 'tool', tool_call_id: 'call-1', name: 'grep', content: 'result' }],
    },
    createdAt: 2,
    updatedAt: 2,
  })
  const before = getSessionSnapshot({ userId, sessionId })
  const result = replaceSessionMessages({
    userId,
    sessionId,
    expectedRevision: before.revision,
    now: 10,
    messages: [
      { id: 'cas-assistant', role: 'assistant', content: 'updated', createdAt: 2, updatedAt: 10 },
      { id: 'cas-user', role: 'user', content: 'next', createdAt: 3, updatedAt: 10 },
    ],
  })
  assert.ok(result.revision > before.revision)
  const stored = listMessages({ userId, sessionId })
  assert.equal(stored[0].content, 'updated')
  assert.equal(stored[0].modelContext.toolTrace[0].tool_call_id, 'call-1')
  assert.throws(
    () => replaceSessionMessages({
      userId,
      sessionId,
      expectedRevision: before.revision,
      messages: [],
    }),
    (error) => error instanceof SessionRevisionConflictError && error.currentRevision === result.revision,
  )
})

test('imported tool results survive snapshot editing and full-session replacement', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-imported-tools@example.com' })
  const sessionId = 'session-imported-tools'
  upsertSession({ id: sessionId, userId, title: 'Imported tools', createdAt: 1, updatedAt: 1 })
  upsertMessage({
    id: 'unrelated-user', userId, sessionId, role: 'user', content: 'delete me', createdAt: 1,
  })
  upsertMessage({
    id: 'imported-assistant',
    userId,
    sessionId,
    role: 'assistant',
    content: 'I read the file.',
    modelContext: {
      toolCalls: [{
        id: 'imported-read-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }],
    },
    createdAt: 2,
  })
  upsertMessage({
    id: 'imported-tool-result',
    userId,
    sessionId,
    role: 'tool',
    content: '{"ok":true,"content":"README contents"}',
    modelContext: { toolCallId: 'imported-read-1', name: 'read_file' },
    createdAt: 3,
  })
  upsertMessage({
    id: 'keep-user', userId, sessionId, role: 'user', content: 'keep me', createdAt: 4,
  })

  const before = getSessionSnapshot({ userId, sessionId })
  const browserSnapshot = normalizeServerSessionSnapshot({ ...before, complete: true })
  const assistant = browserSnapshot.messages.find((message) => message.id === 'imported-assistant')
  assert.equal(assistant.meta.toolTrace[1].tool_call_id, 'imported-read-1')
  assert.match(assistant.meta.toolTrace[1].content, /README contents/)

  const editedMessages = browserSnapshot.messages.filter((message) => message.id !== 'unrelated-user')
  replaceSessionMessages({
    userId,
    sessionId,
    expectedRevision: before.revision,
    now: 10,
    messages: normalizeSessionMessagesForServer(editedMessages),
  })

  const stored = listMessages({ userId, sessionId })
  assert.deepEqual(stored.map((message) => message.id), ['imported-assistant', 'keep-user'])
  assert.equal(stored[0].modelContext.toolCalls, undefined)
  assert.equal(stored[0].modelContext.toolTrace[1].tool_call_id, 'imported-read-1')

  const expanded = expandStoredMessages(stored)
  const calls = expanded.filter((message) => message.role === 'assistant' && message.tool_calls)
  const results = expanded.filter((message) => message.role === 'tool')
  assert.equal(calls.length, 1)
  assert.equal(results.length, 1)
  assert.equal(calls[0].tool_calls[0].id, 'imported-read-1')
  assert.equal(results[0].tool_call_id, 'imported-read-1')
  assert.match(results[0].content, /README contents/)
})

test('stored system rows are not replayed beside freshly compiled system blocks', () => {
  const expanded = expandStoredMessages([
    {
      id: 'stale-system',
      role: 'system',
      content: 'STALE_IDENTITY_AND_UI_STATE_MUST_NOT_REPLAY',
      modelContext: { uiState: { spinner: true } },
    },
    { id: 'user-fact', role: 'user', content: 'Keep this user request.' },
    { id: 'assistant-fact', role: 'assistant', content: 'Keep this answer.' },
  ])

  assert.deepEqual(expanded.map((message) => message.role), ['user', 'assistant'])
  assert.doesNotMatch(JSON.stringify(expanded), /STALE_IDENTITY_AND_UI_STATE_MUST_NOT_REPLAY|spinner/)
  assert.match(JSON.stringify(expanded), /Keep this user request/)
})

test('successful artifact calls retain a lightweight reference instead of 70k HTML source', () => {
  const tailMarker = '<!-- REVISION_SOURCE_TAIL: keep this exact footer -->'
  const html = `<!doctype html><html><body>${'x'.repeat(70_000)}${tailMarker}</body></html>`
  const argumentsText = JSON.stringify({ title: 'Large page', html })
  assert.ok(argumentsText.length > TURN_TOOL_CONTEXT_LIMITS.maxArgumentChars)

  const modelContext = buildAssistantModelContext({
    turnId: 'large-html-turn',
    checkpointMessages: [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'large-html-call',
        type: 'function',
        function: { name: 'create_html_app', arguments: argumentsText },
      }],
    }, {
      role: 'tool',
      tool_call_id: 'large-html-call',
      name: 'create_html_app',
      content: JSON.stringify({
        ok: true,
        artifactId: 'large-html-artifact',
        filename: 'large-page.html',
      }),
    }],
    baselineToolCallIds: new Set(),
    artifactIds: ['large-html-artifact'],
  })

  const retainedArguments = modelContext.toolTrace[0].tool_calls[0].function.arguments
  const reference = JSON.parse(retainedArguments)
  assert.deepEqual(reference, {
    __artifactReference: true,
    artifactId: 'large-html-artifact',
    filename: 'large-page.html',
    type: 'html',
    title: 'Large page',
    source: {
      omittedFromHistory: true,
      readTool: 'read_artifact_source',
      artifact_id: 'large-html-artifact',
      instruction: 'Call read_artifact_source from offset 0 through complete=true before revising this artifact.',
    },
  })
  assert.equal(JSON.stringify(modelContext.toolTrace).includes(tailMarker), false)
  assert.ok(JSON.stringify(modelContext.toolTrace).length < 2_000)

  const expanded = expandStoredMessages([{
    id: 'large-html-assistant',
    role: 'assistant',
    content: '网页已生成。',
    modelContext,
  }])
  const expandedCall = expanded.find((message) => message.tool_calls)?.tool_calls[0]
  assert.deepEqual(JSON.parse(expandedCall.function.arguments), reference)
})

test('successful create_html_app local delivery becomes a verified file linked to its artifact', () => {
  const outputPath = path.join(tempDir, 'gallery-output.html')
  fs.writeFileSync(outputPath, '<!doctype html><html><body>gallery</body></html>')
  const checkpointMessages = [{
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'verified-html-delivery',
      function: {
        name: 'create_html_app',
        arguments: JSON.stringify({ title: 'Gallery', html: '<!doctype html><html></html>' }),
      },
    }],
  }, {
    role: 'tool',
    tool_call_id: 'verified-html-delivery',
    name: 'create_html_app',
    content: JSON.stringify({
      ok: true,
      artifactId: 'verified-html-artifact',
      filename: 'gallery.html',
      path: outputPath,
      localPath: outputPath,
      outputPath,
    }),
  }]

  const receipts = extractVerifiedLocalFiles(checkpointMessages, {
    baselineToolCallIds: new Set(),
    resolvePath: ({ rawPath }) => ({ fullPath: rawPath }),
  })

  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].path, outputPath)
  assert.deepEqual(receipts[0].relatedArtifactIds, ['verified-html-artifact'])
})

test('artifact source page contents are omitted from persisted tool trace', () => {
  const sourceMarker = 'SOURCE_PAGE_MUST_NOT_PERSIST'
  const modelContext = buildAssistantModelContext({
    turnId: 'artifact-source-read-turn',
    checkpointMessages: [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'read-source-call',
        type: 'function',
        function: {
          name: 'read_artifact_source',
          arguments: JSON.stringify({ artifact_id: 'artifact-1', offset: 0, limit: 16000 }),
        },
      }],
    }, {
      role: 'tool',
      tool_call_id: 'read-source-call',
      name: 'read_artifact_source',
      content: JSON.stringify({
        ok: true,
        artifactId: 'artifact-1',
        filename: 'page.html',
        sourceFormat: 'artifact_tool_arguments_json',
        offset: 0,
        returnedChars: 16000,
        totalChars: 70000,
        complete: false,
        nextOffset: 16000,
        content: sourceMarker.repeat(500),
      }),
    }],
    baselineToolCallIds: new Set(),
  })

  const retainedResult = JSON.parse(modelContext.toolTrace[1].content)
  assert.equal(retainedResult.sourceOmittedFromHistory, true)
  assert.equal(Object.hasOwn(retainedResult, 'content'), false)
  assert.equal(JSON.stringify(modelContext.toolTrace).includes(sourceMarker), false)
})

test('managed attachments stay lightweight in history and materialize only for a model request', async () => {
  const stored = [{
    id: 'attachment-user',
    role: 'user',
    content: '/vision Summarize the diagram.',
    modelContext: {
      modelContent: 'Summarize the diagram.',
      attachments: [{
        id: 'attachment-1',
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 12,
        sha256: 'abc123',
        uri: 'attachment://attachment-1',
        downloadUrl: '/api/attachments/attachment-1/content',
        fullPath: 'must-not-leak',
      }],
    },
  }]

  const history = expandStoredMessages(stored)
  assert.equal(history[0].content, 'Summarize the diagram.')
  assert.deepEqual(history[0].managedAttachments, [{
    id: 'attachment-1',
    name: 'diagram.png',
    mimeType: 'image/png',
    size: 12,
    sha256: 'abc123',
    uri: 'attachment://attachment-1',
    downloadUrl: '/api/attachments/attachment-1/content',
  }])
  assert.doesNotMatch(JSON.stringify(history), /fullPath|base64,/)

  const preparedCalls = []
  const providerMessages = await materializeManagedAttachmentMessages(history, {
    userId: 'user-1',
    sessionId: 'session-1',
    prepareAttachments: async (input) => {
      preparedCalls.push(input)
      return {
        content: [
          { type: 'text', text: input.text },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
        ],
      }
    },
  })

  assert.deepEqual(preparedCalls, [{
    userId: 'user-1',
    sessionId: 'session-1',
    attachmentIds: ['attachment-1'],
    text: 'Summarize the diagram.',
  }])
  assert.match(JSON.stringify(providerMessages), /base64,/)
  assert.equal('managedAttachments' in providerMessages[0], false)
  assert.doesNotMatch(JSON.stringify(history), /base64,/)
})

test('managed attachments stay as references when a provider request does not need binary media', async () => {
  const history = expandStoredMessages([{
    id: 'prior-attachment-user',
    role: 'user',
    content: 'Summarize the diagram.',
    modelContext: {
      modelContent: 'Summarize the diagram.',
      attachments: [{
        id: 'attachment-reference-only',
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 12,
        sha256: 'abc123',
        uri: 'attachment://attachment-reference-only',
      }],
    },
  }])
  let prepared = 0
  const providerMessages = await materializeManagedAttachmentMessages(history, {
    userId: 'user-1',
    sessionId: 'session-1',
    inlineAttachmentIds: [],
    prepareAttachments: async () => {
      prepared += 1
      throw new Error('reference-only requests must not read attachment bytes')
    },
  })

  assert.equal(prepared, 0)
  assert.doesNotMatch(JSON.stringify(providerMessages), /base64,/)
  assert.match(String(providerMessages[0].content), /attachment:\/\/attachment-reference-only/)
  assert.equal('managedAttachments' in providerMessages[0], false)

  assert.deepEqual(selectAttachmentIdsForModelRequest(history, {
    prompt: 'Now explain the implementation choices.',
  }), [])
  assert.deepEqual(selectAttachmentIdsForModelRequest(history, {
    prompt: 'What is shown in the same image?',
  }), ['attachment-reference-only'])
  assert.deepEqual(selectAttachmentIdsForModelRequest(history, {
    currentAttachmentIds: ['new-upload'],
    prompt: 'Analyze this upload.',
  }), ['new-upload'])
})

test('server snapshots restore user attachments from persisted model context', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'attachment-user',
      role: 'user',
      content: 'Read this file.',
      createdAt: 1,
      modelContext: {
        attachments: [{
          id: 'attachment-2',
          name: 'folder\\report.pdf',
          mimeType: 'application/pdf',
          size: 2048,
          sha256: 'pdf-hash',
          downloadUrl: '/api/attachments/attachment-2/content',
        }],
      },
    }],
  })

  assert.deepEqual(snapshot.messages[0].attachments, [{
    id: 'attachment-2',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    sha256: 'pdf-hash',
    downloadUrl: '/api/attachments/attachment-2/content',
  }])
})

test('compaction boundary selects only the retained canonical tail', () => {
  const stored = [
    { id: 'archived-user', role: 'user', content: 'old request' },
    { id: 'archived-assistant', role: 'assistant', content: 'old reply' },
    { id: 'retained-user', role: 'user', content: 'current retained objective' },
    { id: 'retained-assistant', role: 'assistant', content: 'current reply' },
  ]

  assert.deepEqual(
    selectStoredMessagesAfterCompaction(stored, { firstKeptMessageId: 'retained-user' })
      .map((message) => message.id),
    ['retained-user', 'retained-assistant'],
  )
  assert.deepEqual(
    selectStoredMessagesAfterCompaction(stored, { lastCompactedMessageId: 'archived-assistant' })
      .map((message) => message.id),
    ['retained-user', 'retained-assistant'],
  )
  assert.equal(stored.length, 4, 'canonical UI/audit history must remain intact')
})

test('unmatched compaction boundary keeps messages after the archive reference', () => {
  const stored = [
    { id: 'archived-user', role: 'user', content: 'old request must stay archived' },
    { id: 'archived-assistant', role: 'assistant', content: 'old reply must stay archived' },
    { id: 'archive-reference', role: 'assistant', content: 'archive reference' },
    { id: 'current-turn:user', role: 'user', content: 'current request must survive' },
  ]

  assert.deepEqual(
    selectStoredMessagesAfterCompaction(stored, {
      firstKeptMessageId: 'missing-retained-message',
      lastCompactedMessageId: 'missing-archived-message',
      referenceMessageId: 'archive-reference',
    }).map((message) => message.id),
    ['current-turn:user'],
  )
  assert.deepEqual(
    selectStoredMessagesAfterCompaction(stored, {
      firstKeptMessageId: 'missing-retained-message',
      lastCompactedMessageId: 'missing-archived-message',
    }),
    [],
    'without any trustworthy anchor, archived history must remain excluded',
  )
  assert.equal(stored.length, 4, 'canonical UI/audit history must remain intact')
})

test('assistant model context and server snapshots preserve total turn duration', () => {
  const modelContext = buildAssistantModelContext({
    turnId: 'timed-turn',
    checkpointMessages: [],
    baselineToolCallIds: new Set(),
    turnStartedAt: 1_000,
    turnCompletedAt: 4_250,
  })

  assert.equal(modelContext.turnStartedAt, 1_000)
  assert.equal(modelContext.turnCompletedAt, 4_250)
  assert.equal(modelContext.latency, 3_250)

  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'timed-assistant',
      role: 'assistant',
      content: 'Finished.',
      createdAt: 4_250,
      modelContext: {
        ...modelContext,
        latency: undefined,
      },
    }],
  })

  assert.equal(snapshot.messages[0].meta.turnStartedAt, 1_000)
  assert.equal(snapshot.messages[0].meta.turnCompletedAt, 4_250)
  assert.equal(snapshot.messages[0].meta.latency, 3_250)
})

test('legacy server snapshots derive turn duration from matching user and assistant messages', () => {
  const snapshot = normalizeServerSessionSnapshot({
    complete: true,
    messages: [{
      id: 'legacy-turn:user',
      role: 'user',
      content: 'Start.',
      createdAt: 10_000,
      modelContext: { turnId: 'legacy-turn' },
    }, {
      id: 'legacy-turn:assistant',
      role: 'assistant',
      content: 'Finished.',
      createdAt: 13_750,
      modelContext: { turnId: 'legacy-turn' },
    }],
  })

  assert.equal(snapshot.messages[1].meta.turnStartedAt, 10_000)
  assert.equal(snapshot.messages[1].meta.turnCompletedAt, 13_750)
  assert.equal(snapshot.messages[1].meta.latency, 3_750)
})

test('session mutation routes return 409 for stale revisions and active turns', { concurrency: false }, async () => {
  const { token, userId } = issueTestSession({ email: 'session-route-conflict@example.com' })
  const sessionId = 'session-route-conflict'
  upsertSession({ id: sessionId, userId, title: 'Route conflict' })
  upsertMessage({ id: 'route-message', userId, sessionId, role: 'user', content: 'hello' })
  const current = getSessionSnapshot({ userId, sessionId })

  const stale = await invokeRoute({
    method: 'PUT',
    url: `/api/sessions/${sessionId}/messages`,
    token,
    body: { expectedRevision: current.revision - 1, messages: [] },
  })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error.code, 'SESSION_REVISION_CONFLICT')
  assert.equal(stale.json().error.currentRevision, current.revision)

  const activeEngine = { hasActiveSession: ({ userId: candidate, sessionId: candidateSession }) => (
    candidate === userId && candidateSession === sessionId
  ) }
  for (const [method, suffix, body] of [
    ['PUT', '/messages', { expectedRevision: current.revision, messages: [] }],
    ['DELETE', '', { expectedRevision: current.revision }],
  ]) {
    const response = await invokeRoute({
      method,
      url: `/api/sessions/${sessionId}${suffix}`,
      token,
      body,
    }, activeEngine)
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error.code, 'SESSION_ACTIVE')
  }
  assert.ok(getSession({ userId, sessionId }))
  assert.equal(listMessages({ userId, sessionId }).length, 1)
})

test('cross-user session mutations return 404 without changing the owner history', { concurrency: false }, async () => {
  const owner = issueTestSession({ email: 'session-owner@example.com' })
  const intruder = issueTestSession({ email: 'session-intruder@example.com' })
  const sessionId = 'session-owned'
  upsertSession({ id: sessionId, userId: owner.userId, title: 'Owned' })
  upsertMessage({ id: 'owned-message', userId: owner.userId, sessionId, role: 'user', content: 'private' })
  for (const [method, suffix, body] of [
    ['PUT', '/messages', { expectedRevision: 0, messages: [] }],
    ['DELETE', '', { expectedRevision: 0 }],
  ]) {
    const response = await invokeRoute({
      method,
      url: `/api/sessions/${sessionId}${suffix}`,
      token: intruder.token,
      body,
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error.code, 'SESSION_NOT_FOUND')
  }
  assert.equal(listMessages({ userId: owner.userId, sessionId })[0].content, 'private')
})

test('CAS session deletion cascades strong references and clears weak references', { concurrency: false }, () => {
  const { userId } = issueTestSession({ email: 'session-delete@example.com' })
  const sessionId = 'session-delete'
  const db = getDb()
  upsertSession({ id: sessionId, userId, title: 'Delete me' })
  upsertMessage({ id: 'delete-message', userId, sessionId, role: 'user', content: 'bye' })
  appendTurnEvent({
    userId,
    event: createTurnEvent({
      id: 'delete-event',
      sessionId,
      turnId: 'delete-turn',
      sequence: 0,
      type: 'turn.completed',
      payload: {},
      createdAt: 2,
    }),
  })
  db.prepare(`
    INSERT INTO turn_artifacts
      (id, user_id, session_id, turn_id, type, title, url, filename, created_at)
    VALUES ('delete-artifact', ?, ?, 'delete-turn', 'file', 'Delete', '/delete', 'session-delete.txt', 2)
  `).run(userId, sessionId)
  db.prepare(`
    INSERT INTO pending_approvals
      (id, user_id, origin, session_id, tool_name, args_json, risk, status, created_at, updated_at)
    VALUES ('delete-approval', ?, 'chat', ?, 'write_file', '{}', 'medium', 'pending', 2, 2)
  `).run(userId, sessionId)
  db.prepare('INSERT INTO session_meters (session_id, user_id, updated_at) VALUES (?, ?, 2)')
    .run(sessionId, userId)
  db.prepare(`
    INSERT INTO compaction_archive
      (id, user_id, session_id, replaced_message_count, archived_messages_json, summary_text, created_at)
    VALUES ('delete-archive', ?, ?, 1, '[]', 'summary', 2)
  `).run(userId, sessionId)
  db.prepare(`
    INSERT INTO memories
      (id, user_id, type, title, slug, body, frontmatter_json, pinned,
       source_session_id, source_message_id, created_at, updated_at)
    VALUES ('delete-memory', ?, 'project', 'Delete memory', 'delete-memory', 'body', '{}', 0, ?, 'delete-message', 2, 2)
  `).run(userId, sessionId)
  db.prepare(`
    INSERT INTO subagent_runs
      (id, user_id, parent_session_id, parent_message_id, agent_type, prompt, status, created_at)
    VALUES ('delete-subagent', ?, ?, 'delete-message', 'general', 'prompt', 'completed', 2)
  `).run(userId, sessionId)

  const revision = getSessionSnapshot({ userId, sessionId }).revision
  assert.deepEqual(deleteSession({ userId, sessionId, expectedRevision: revision }), {
    deleted: true,
    previousRevision: revision,
  })
  assert.equal(getSession({ userId, sessionId }), null)
  for (const [table, column, value] of [
    ['messages', 'id', 'delete-message'],
    ['turn_events', 'id', 'delete-event'],
    ['turn_artifacts', 'id', 'delete-artifact'],
    ['pending_approvals', 'id', 'delete-approval'],
    ['compaction_archive', 'id', 'delete-archive'],
    ['session_meters', 'session_id', sessionId],
  ]) {
    assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value), undefined, table)
  }
  assert.deepEqual(
    db.prepare('SELECT source_session_id, source_message_id FROM memories WHERE id = ?').get('delete-memory'),
    { source_session_id: null, source_message_id: null },
  )
  assert.deepEqual(
    db.prepare('SELECT parent_session_id, parent_message_id FROM subagent_runs WHERE id = ?').get('delete-subagent'),
    { parent_session_id: null, parent_message_id: null },
  )
})
