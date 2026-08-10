import assert from 'node:assert/strict'
import test from 'node:test'

import { authorizeChatDirectoryRequest } from '../src/lib/chatDirectoryRequest.js'

test('chat directory authorization binds the grant to the exact paused event', async () => {
  const calls = []
  const result = await authorizeChatDirectoryRequest({
    sessionId: 'session-1',
    turnId: 'turn-1',
    pausedSequence: 7,
    path: 'D:\\output',
    accessMode: 'read_write',
    purpose: 'Create the requested files',
  }, {
    grantPath: async (input) => {
      calls.push(input)
      return { grant: { path: 'D:\\output', accessMode: 'read_write' } }
    },
  })

  assert.deepEqual(calls, [{ path: 'D:\\output', accessMode: 'read_write' }])
  assert.deepEqual(result.resolution, {
    type: 'directory_authorization',
    approved: true,
    path: 'D:\\output',
    access_mode: 'read_write',
    paused_sequence: 7,
    purpose: 'Create the requested files',
  })
})

test('chat directory authorization rejects a decision without a paused sequence', async () => {
  await assert.rejects(authorizeChatDirectoryRequest({
    sessionId: 'session-1',
    turnId: 'turn-1',
    path: 'D:\\output',
  }, {
    grantPath: async () => ({ grant: { path: 'D:\\output', accessMode: 'read_only' } }),
  }), /pausedSequence is required/)
})
