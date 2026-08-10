import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildServerTurnResumeMeta,
  isResumeNudge,
  resolvePendingDirectorySend,
} from '../src/pages/ChatSplit/pausedTurnResume.js'

function directoryMessage(meta = {}) {
  return {
    id: 'turn-directory:assistant',
    role: 'assistant',
    content: 'Please authorize a directory.',
    meta: {
      paused: true,
      serverConnectionState: 'paused',
      serverTurnId: 'turn-directory',
      serverLastSequence: 7,
      serverClarification: {
        request_type: 'directory',
        access_mode: 'read_write',
        suggested_path: 'D:\\destok',
      },
      ...meta,
    },
  }
}

test('a send while directory authorization is pending stays bound to the paused message', () => {
  const message = directoryMessage()
  const result = resolvePendingDirectorySend([
    { id: 'user', role: 'user', content: 'continue' },
    message,
  ])

  assert.equal(result?.message, message)
  assert.equal(result?.message.meta.serverTurnId, 'turn-directory')
  assert.equal(result?.state, 'authorization_required')
})

test('the pending directory state reports that the original turn is already resuming', () => {
  const resolution = { type: 'directory_authorization', paused_sequence: 7 }
  const result = resolvePendingDirectorySend([
    directoryMessage({
      paused: false,
      serverConnectionState: 'reconnecting',
      directoryAuthorizationPending: true,
      serverResumeResolution: resolution,
    }),
  ])

  assert.equal(result?.state, 'resuming')
  assert.equal(result?.message.meta.serverResumeResolution, resolution)
})

test('completed and unrelated messages do not block a new turn', () => {
  assert.equal(resolvePendingDirectorySend([
    directoryMessage({
      paused: false,
      serverConnectionState: null,
      serverClarification: null,
    }),
  ]), null)
  const unrelated = directoryMessage()
  unrelated.meta.serverClarification = { request_type: 'question' }
  assert.equal(resolvePendingDirectorySend([unrelated]), null)
})

test('common continue prompts are recognized without treating arbitrary instructions as continue', () => {
  for (const value of ['继续', '继续执行。', '接着做！', 'continue', 'Go on']) {
    assert.equal(isResumeNudge(value), true, value)
  }
  assert.equal(isResumeNudge('请改成另一个目录'), false)
})

test('directory authorization queues a resume without replacing the original turn metadata', () => {
  const resolution = {
    type: 'directory_authorization',
    approved: true,
    path: 'D:\\destok',
    access_mode: 'read_write',
    paused_sequence: 7,
  }
  assert.deepEqual(buildServerTurnResumeMeta(resolution), {
    streaming: true,
    paused: false,
    failed: false,
    serverConnectionState: 'reconnecting',
    directoryAuthorizationPending: true,
    directoryAuthorizationError: null,
    serverResumeResolution: resolution,
  })
})
