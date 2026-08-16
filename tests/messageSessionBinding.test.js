import assert from 'node:assert/strict'
import test from 'node:test'
import { reduceMessageState } from '../src/store/reducers/messageReducer.js'

test('INSERT_STEERING_MESSAGE stays with its turn, precedes the streaming assistant, and is idempotent', () => {
  const state = {
    activeSessionId: 'other',
    sessions: [{
      id: 'origin',
      messages: [{ id: 'turn-1:user', role: 'user', content: 'Build the page.' }, {
        id: 'turn-1:assistant',
        role: 'assistant',
        content: 'Working',
        meta: { streaming: true, serverTurnId: 'turn-1' },
      }],
    }, { id: 'other', messages: [] }],
  }
  const inserted = reduceMessageState(state, {
    type: 'INSERT_STEERING_MESSAGE',
    payload: {
      id: 'steering-message-1',
      sessionId: 'origin',
      turnId: 'turn-1',
      beforeMessageId: 'turn-1:assistant',
      clientRequestId: 'steer-request-1',
      content: 'Keep going and add tests.',
      createdAt: 42,
    },
  })

  assert.deepEqual(inserted.sessions[0].messages.map((message) => message.id), [
    'turn-1:user',
    'steering-message-1',
    'turn-1:assistant',
  ])
  assert.equal(inserted.sessions[0].messages[1].meta.steering, true)
  assert.equal(inserted.sessions[0].messages[1].meta.steeringClientRequestId, 'steer-request-1')
  assert.deepEqual(inserted.sessions[1].messages, [])

  const repeated = reduceMessageState(inserted, {
    type: 'INSERT_STEERING_MESSAGE',
    payload: {
      id: 'different-server-id',
      sessionId: 'origin',
      turnId: 'turn-1',
      clientRequestId: 'steer-request-1',
      content: 'Keep going and add tests.',
      createdAt: 43,
    },
  })
  assert.deepEqual(repeated.sessions[0].messages.map((message) => message.id), [
    'turn-1:user',
    'steering-message-1',
    'turn-1:assistant',
  ])
})

test('SEND_MESSAGE remains bound to its originating session when active navigation changes', () => {
  const state = {
    activeSessionId: 'other',
    sessions: [
      { id: 'origin', messages: [] },
      { id: 'other', messages: [] },
    ],
  }
  const next = reduceMessageState(state, {
    type: 'SEND_MESSAGE',
    payload: { id: 'turn:user', sessionId: 'origin', content: 'hello' },
  })
  assert.deepEqual(next.sessions[0].messages.map((message) => message.id), ['turn:user'])
  assert.deepEqual(next.sessions[1].messages, [])
  assert.equal(next.sessions[0].messages[0].meta.pendingServerSync, true)
})

test('the same turn failure marker is appended only once', () => {
  const state = {
    activeSessionId: 'origin',
    sessions: [{
      id: 'origin',
      messages: [{ id: 'turn-1:assistant', role: 'assistant', content: 'Partial result', meta: {} }],
    }],
  }
  const action = {
    type: 'APPEND_TO_LAST_MESSAGE',
    payload: '\n\nModel call failed: missing image',
    meta: { serverFailureDisplayKey: 'turn-1:ARTIFACT_NOT_CREATED' },
    sessionId: 'origin',
    messageId: 'turn-1:assistant',
  }
  const appended = reduceMessageState(state, action)
  const repeated = reduceMessageState(appended, action)

  assert.equal(repeated.sessions[0].messages[0].content, 'Partial result\n\nModel call failed: missing image')
  assert.equal(repeated.sessions[0].messages[0].meta.serverFailureDisplayKey, 'turn-1:ARTIFACT_NOT_CREATED')
})

test('SEND_MESSAGE keeps attachment metadata separate from visible message content', () => {
  const state = { activeSessionId: 'origin', sessions: [{ id: 'origin', messages: [] }] }
  const next = reduceMessageState(state, {
    type: 'SEND_MESSAGE',
    payload: {
      sessionId: 'origin',
      content: '请分析这份文件',
      attachments: [{
        id: 'attachment-1',
        name: 'D:\\private\\report.pdf',
        mimeType: 'application/pdf',
        size: 8,
        sha256: 'hash',
        downloadUrl: '/api/attachments/attachment-1/content',
        dataUrl: 'data:application/pdf;base64,AAAA',
        text: 'private body',
      }],
    },
  })
  const [message] = next.sessions[0].messages
  assert.equal(message.content, '请分析这份文件')
  assert.deepEqual(message.attachments, [{
    id: 'attachment-1',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    size: 8,
    sha256: 'hash',
    downloadUrl: '/api/attachments/attachment-1/content',
  }])
  assert.doesNotMatch(JSON.stringify(message), /private body|data:application|D:\\\\private/)
})

test('stream recovery resets only its target assistant and rejects replayed event sequences', () => {
  const state = {
    activeSessionId: 'other',
    sessions: [
      {
        id: 'origin',
        messages: [{
          id: 'assistant-1',
          role: 'assistant',
          content: 'confirmed stale suffix',
          meta: {
            serverTurnId: 'turn-1',
            serverLastSequence: 5,
            reasoning: 'checked stale thought',
            toolCalls: [{ id: 'tool-1', status: 'success' }],
            serverArtifacts: [{ id: 'artifact-1' }],
          },
        }],
      },
      { id: 'other', messages: [{ id: 'assistant-2', role: 'assistant', content: 'untouched' }] },
    ],
  }
  const reset = reduceMessageState(state, {
    type: 'RESET_LAST_MESSAGE_STREAM',
    payload: { content: 'confirmed', reasoning: 'checked' },
    sessionId: 'origin',
    messageId: 'assistant-1',
    serverTurnId: 'turn-1',
    serverSequence: 6,
  })
  const recovered = reset.sessions[0].messages[0]
  assert.equal(recovered.content, 'confirmed')
  assert.equal(recovered.meta.reasoning, 'checked')
  assert.equal(recovered.meta.serverLastSequence, 6)
  assert.deepEqual(recovered.meta.toolCalls, [{ id: 'tool-1', status: 'success' }])
  assert.deepEqual(recovered.meta.serverArtifacts, [{ id: 'artifact-1' }])
  assert.equal(reset.sessions[1].messages[0].content, 'untouched')

  const appended = reduceMessageState(reset, {
    type: 'APPEND_TO_LAST_MESSAGE',
    payload: ' fresh',
    meta: { modelActivity: { kind: 'responding' } },
    sessionId: 'origin',
    messageId: 'assistant-1',
    serverTurnId: 'turn-1',
    serverSequence: 7,
  })
  const replayed = reduceMessageState(appended, {
    type: 'APPEND_TO_LAST_MESSAGE',
    payload: ' fresh',
    sessionId: 'origin',
    messageId: 'assistant-1',
    serverTurnId: 'turn-1',
    serverSequence: 7,
  })
  assert.equal(replayed.sessions[0].messages[0].content, 'confirmed fresh')
  assert.equal(replayed.sessions[0].messages[0].meta.serverLastSequence, 7)
  assert.deepEqual(replayed.sessions[0].messages[0].meta.modelActivity, { kind: 'responding' })

  const reasoning = reduceMessageState(replayed, {
    type: 'APPEND_REASONING_TO_LAST_MESSAGE',
    payload: ' once',
    sessionId: 'origin',
    messageId: 'assistant-1',
    serverTurnId: 'turn-1',
    serverSequence: 8,
  })
  const reasoningReplay = reduceMessageState(reasoning, {
    type: 'APPEND_REASONING_TO_LAST_MESSAGE',
    payload: ' once',
    sessionId: 'origin',
    messageId: 'assistant-1',
    serverTurnId: 'turn-1',
    serverSequence: 8,
  })
  assert.equal(reasoningReplay.sessions[0].messages[0].meta.reasoning, 'checked once')

  const progress = reduceMessageState(reasoningReplay, {
    type: 'UPDATE_LAST_MESSAGE_META',
    payload: { progress: { completed: 2, total: 4 } },
    sessionId: 'origin',
    messageId: 'assistant-1',
    serverTurnId: 'turn-1',
    serverSequence: 9,
  })
  const progressReplay = reduceMessageState(progress, {
    type: 'UPDATE_LAST_MESSAGE_META',
    payload: { progress: { completed: 1, total: 4 } },
    sessionId: 'origin',
    messageId: 'assistant-1',
    serverTurnId: 'turn-1',
    serverSequence: 9,
  })
  assert.deepEqual(progressReplay.sessions[0].messages[0].meta.progress, { completed: 2, total: 4 })
  assert.equal(progressReplay.sessions[0].messages[0].meta.serverLastSequence, 9)

  const wrongTurn = reduceMessageState(progressReplay, {
    type: 'APPEND_TO_LAST_MESSAGE',
    payload: ' wrong turn',
    sessionId: 'origin',
    messageId: 'assistant-1',
    serverTurnId: 'turn-2',
    serverSequence: 10,
  })
  assert.equal(wrongTurn.sessions[0].messages[0].content, 'confirmed fresh')
  assert.equal(wrongTurn.sessions[0].messages[0].meta.serverLastSequence, 9)
})
