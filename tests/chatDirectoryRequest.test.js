import assert from 'node:assert/strict'
import test from 'node:test'

import { authorizeChatDirectoryRequest } from '../src/lib/chatDirectoryRequest.js'
import { createTurnResolutionRuntime } from '../server/services/turnResolutionRuntime.js'

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
      return {
        grant: {
          id: 'directory-grant-session',
          path: 'D:\\output',
          accessMode: 'read_write',
          scope: 'session',
        },
      }
    },
  })

  assert.deepEqual(calls, [{ sessionId: 'session-1', turnId: 'turn-1', pausedSequence: 7,
    path: 'D:\\output', accessMode: 'read_write', scope: 'session' }])
  assert.equal(result.scope, 'session')
  assert.deepEqual(result.resolution, {
    type: 'directory_authorization',
    approved: true,
    path: 'D:\\output',
    access_mode: 'read_write',
    authorization_scope: 'session',
    grant_id: 'directory-grant-session',
    paused_sequence: 7,
    purpose: 'Create the requested files',
  })
})

test('chat directory authorization forwards an explicit persistent scope', async () => {
  const calls = []
  const result = await authorizeChatDirectoryRequest({
    sessionId: 'session-2',
    turnId: 'turn-2',
    pausedSequence: 1,
    path: 'D:\\persistent',
    scope: 'persistent',
  }, {
    grantPath: async (input) => {
      calls.push(input)
      return { grant: { id: 'directory-grant-persistent', ...input, resourceType: 'directory' } }
    },
  })
  assert.equal(calls[0].scope, 'persistent')
  assert.equal(result.resolution.authorization_scope, 'persistent')
  assert.equal(result.resolution.grant_id, 'directory-grant-persistent')
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

test('reusing an existing permanent read-write grant preserves the requested read-only resume contract', async () => {
  const result = await authorizeChatDirectoryRequest({
    sessionId: 'read-session', turnId: 'read-turn', pausedSequence: 8,
    path: 'D:\\existing', accessMode: 'read_only',
  }, { grantPath: async () => ({ grant: {
    id: 'existing-permanent', path: 'D:\\existing', resourceType: 'directory',
    scope: 'persistent', accessMode: 'read_write',
  } }) })
  assert.equal(result.resolution.access_mode, 'read_only')
  assert.equal(result.resolution.authorization_scope, 'persistent')
  const runtime = createTurnResolutionRuntime({ normalizePath: value => value })
  assert.doesNotThrow(() => runtime.validateForPause(result.resolution, {
    sequence: 8, payload: { clarification: { request_type: 'directory', access_mode: 'read_only' } },
  }))
})

function directoryRequest() {
  return { sessionId: 'session-http', turnId: 'turn-http', pausedSequence: 5,
    path: 'D:\\chosen', accessMode: 'read_only', scope: 'session' }
}

function directoryReceipt(input) {
  return { ok: true,
    grant: { id: 'grant-http', path: input.path, resourceType: 'directory',
      accessMode: input.accessMode, scope: input.scope },
    interaction: { sessionId: input.sessionId, turnId: input.turnId, pausedSequence: input.pausedSequence,
      requestedPath: input.path, canonicalPath: input.path, accessMode: input.accessMode, scope: input.scope },
    boundary: { id: 'paused-http', type: 'turn.paused', sequence: input.pausedSequence },
  }
}

test('production directory confirmation uses the scoped endpoint and forwards its exact identity and cancellation', async context => {
  const input = directoryRequest()
  const controller = new AbortController()
  const calls = []
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), signal: options.signal })
    return new Response(JSON.stringify(directoryReceipt(input)))
  })
  const result = await authorizeChatDirectoryRequest({ ...input, signal: controller.signal })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/local-files/grants/turn')
  assert.deepEqual(calls[0].body, input)
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.equal(result.resolution.paused_sequence, 5)
})

test('malformed and cross-task directory receipts never provide continuation', async context => {
  const input = directoryRequest()
  let receipt
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(receipt)))
  for (const change of [
    value => { value.interaction.turnId = 'foreign' },
    value => { value.interaction.sessionId = 'foreign' },
    value => { value.interaction.pausedSequence = 6 },
    value => { value.interaction.requestedPath = 'D:\\foreign' },
    value => { value.grant.path = 'D:\\foreign' },
    value => { value.grant.accessMode = 'read_write' },
    value => { value.grant.scope = 'persistent' },
    value => { value.grant.resourceType = 'file' },
    value => { value.boundary.type = 'turn.blocked' },
    value => { value.boundary.sequence = 4 },
    value => { value.grant = { scope: 'persistent' } },
  ]) {
    receipt = directoryReceipt(input)
    change(receipt)
    await assert.rejects(authorizeChatDirectoryRequest(input), { code: 'TURN_DIRECTORY_AUTHORIZATION_RESPONSE_INVALID' })
  }
})

test('a scoped server receipt may reuse a stronger pre-existing permission without widening the resume mode', async context => {
  const input = directoryRequest()
  const receipt = directoryReceipt(input)
  receipt.grant = { ...receipt.grant, scope: 'persistent', accessMode: 'read_write' }
  receipt.preexistingPermission = { id: receipt.grant.id, path: receipt.grant.path,
    scope: 'persistent', accessMode: 'read_write' }
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(receipt)))
  const result = await authorizeChatDirectoryRequest(input)
  assert.equal(result.resolution.access_mode, 'read_only')
  assert.equal(result.resolution.grant_id, receipt.grant.id)
  assert.equal(result.resolution.authorization_scope, 'persistent')
})

test('a lost directory confirmation response is not retried through a global grant endpoint', async context => {
  const calls = []
  context.mock.method(globalThis, 'fetch', async url => {
    calls.push(url)
    throw new Error('connection lost')
  })
  await assert.rejects(authorizeChatDirectoryRequest(directoryRequest()), /connection lost/u)
  assert.deepEqual(calls, ['/api/local-files/grants/turn'])
})

test('aborted directory confirmation ignores even an accepted late response', async () => {
  const controller = new AbortController()
  await assert.rejects(authorizeChatDirectoryRequest({ ...directoryRequest(), signal: controller.signal }, {
    grantPath: async () => {
      controller.abort()
      return directoryReceipt(directoryRequest())
    },
  }), { name: 'AbortError' })
})
