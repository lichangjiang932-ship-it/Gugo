import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deleteSessionRemote,
  normalizeSessionMessagesForServer,
  replaceSessionMessagesRemote,
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
