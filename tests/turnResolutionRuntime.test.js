import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTurnResolutionRuntime,
  filterAuthorizedDirectoryResolutions,
  MAX_DIRECTORY_AUTHORIZATION_RESOLUTIONS,
  normalizeDirectoryAuthorizationResolutions,
  TurnEngineError,
} from '../server/services/turnResolutionRuntime.js'

function createRuntime() {
  return createTurnResolutionRuntime({
    normalizePath: (value) => String(value || '')
      .replace(/[\\/]+$/g, '')
      .replaceAll('\\', '/')
      .toLowerCase(),
  })
}

test('resolution runtime normalizes clarification and directory payload aliases', () => {
  const runtime = createRuntime()

  assert.deepEqual(runtime.normalizeResolution({
    answer: ' 继续 ',
    pausedSequence: '4',
  }), {
    type: 'clarification_response',
    response: '继续',
    paused_sequence: 4,
  })

  assert.deepEqual(runtime.normalizeResolution({
    type: 'directory_authorization',
    approved: true,
    path: 'C:\\Workspace',
    accessMode: 'read_write',
    authorizationScope: 'persistent',
    grantId: 'grant-1',
    purpose: ' 生成报告 ',
    pausedSequence: 7,
  }), {
    type: 'directory_authorization',
    approved: true,
    path: 'C:\\Workspace',
    access_mode: 'read_write',
    authorization_scope: 'persistent',
    grant_id: 'grant-1',
    resource_type: 'directory',
    paused_sequence: 7,
    purpose: '生成报告',
  })

  assert.throws(
    () => runtime.normalizeResolution({ response: 'missing sequence' }),
    (error) => error instanceof TurnEngineError
      && error.code === 'TURN_RESOLUTION_SEQUENCE_REQUIRED'
      && error.status === 400,
  )
})

test('resolution runtime rejects stale or incompatible pause responses', () => {
  const runtime = createRuntime()
  const pausedEvent = {
    sequence: 7,
    payload: {
      clarification: {
        request_type: 'directory',
        access_mode: 'read_write',
      },
    },
  }
  const resolution = runtime.normalizeResolution({
    type: 'directory_authorization',
    approved: true,
    path: '/workspace',
    access_mode: 'read_write',
    authorization_scope: 'session',
    grant_id: 'grant-1',
    paused_sequence: 7,
  })

  assert.doesNotThrow(() => runtime.validateForPause(resolution, pausedEvent))
  assert.throws(
    () => runtime.validateForPause({ ...resolution, paused_sequence: 6 }, pausedEvent),
    (error) => error.code === 'TURN_RESOLUTION_STALE' && error.status === 409,
  )
  assert.throws(
    () => runtime.validateForPause({ ...resolution, access_mode: 'read_only' }, pausedEvent),
    (error) => error.code === 'TURN_RESOLUTION_ACCESS_MODE_MISMATCH',
  )
  assert.throws(
    () => runtime.validateForPause({
      type: 'clarification_response',
      response: 'yes',
      paused_sequence: 7,
    }, pausedEvent),
    (error) => error.code === 'TURN_RESOLUTION_TYPE_MISMATCH',
  )
})

test('directory grant matching uses injected path identity and enforces write access', () => {
  const normalizedPaths = []
  const runtime = createTurnResolutionRuntime({
    normalizePath: (value) => {
      normalizedPaths.push(value)
      return String(value).replace(/[\\/]+$/g, '').replaceAll('\\', '/').toLowerCase()
    },
  })
  const grants = [{
    id: 'grant-1',
    resourceType: 'directory',
    scope: 'persistent',
    path: 'C:\\WORKSPACE\\',
    accessMode: 'read_only',
    available: true,
  }]
  const resolution = {
    grant_id: 'grant-1',
    authorization_scope: 'persistent',
    path: 'c:/workspace',
    access_mode: 'read_only',
  }

  assert.equal(runtime.hasSufficientDirectoryGrant(grants, resolution), true)
  assert.deepEqual(normalizedPaths, ['c:/workspace', 'C:\\WORKSPACE\\'])
  assert.equal(runtime.hasSufficientDirectoryGrant(grants, {
    ...resolution,
    access_mode: 'read_write',
  }), false)
})

test('checkpoint resolution projection is immutable and idempotent', () => {
  const runtime = createRuntime()
  const state = {
    messages: [{ role: 'assistant', content: 'waiting' }],
    final: { paused: true, text: 'waiting' },
    iterations: 3,
  }
  const resumeContext = {
    resolution: {
      type: 'clarification_response',
      response: 'PDF',
    },
    pausedSequence: 9,
  }

  const first = runtime.applyToCheckpoint(state, resumeContext)
  const second = runtime.applyToCheckpoint(first, resumeContext)

  assert.notStrictEqual(first, state)
  assert.deepEqual(state.final, { paused: true, text: 'waiting' })
  assert.equal(Object.hasOwn(first, 'final'), false)
  assert.equal(first.messages.at(-1).role, 'user')
  assert.match(first.messages.at(-1).content, /\[TURN_RESOLUTION:9\]/)
  assert.equal(second.messages.length, first.messages.length)
  assert.notStrictEqual(second.messages[0], first.messages[0])
})

test('checkpoint resolution projection preserves structured directory authorization', () => {
  const runtime = createRuntime()
  const state = {
    messages: [{ role: 'assistant', content: 'waiting' }],
    final: { paused: true, text: 'waiting' },
  }
  const resolution = {
    type: 'directory_authorization',
    approved: true,
    path: 'C:\\Workspace',
    access_mode: 'read_write',
    authorization_scope: 'persistent',
    grant_id: 'grant-1',
    resource_type: 'directory',
    paused_sequence: 7,
  }
  const resumeContext = { resolution, pausedSequence: 7 }

  const first = runtime.applyToCheckpoint(state, resumeContext)
  const second = runtime.applyToCheckpoint(first, resumeContext)

  assert.deepEqual(first.directoryAuthorizationResolution, [resolution])
  assert.notStrictEqual(first.directoryAuthorizationResolution[0], resolution)
  assert.deepEqual(second.directoryAuthorizationResolution, [resolution])
  assert.notStrictEqual(
    second.directoryAuthorizationResolution[0],
    first.directoryAuthorizationResolution[0],
  )
  assert.equal(first.messages.at(-1).role, 'system')
  assert.match(first.messages.at(-1).content, /\[TURN_RESOLUTION:7\]/)
  assert.equal(second.messages.length, first.messages.length)
  assert.equal(Object.hasOwn(state, 'directoryAuthorizationResolution'), false)
})

test('directory authorization checkpoints retain bounded distinct roots and accept legacy single values', () => {
  const runtime = createRuntime()
  const resolution = (index) => ({
    type: 'directory_authorization',
    approved: true,
    path: `C:\\Workspace-${index}`,
    access_mode: 'read_write',
    authorization_scope: 'persistent',
    grant_id: `grant-${index}`,
    resource_type: 'directory',
    paused_sequence: index,
  })
  const legacy = resolution(0)
  assert.deepEqual(normalizeDirectoryAuthorizationResolutions(legacy), [legacy])

  let state = { messages: [], final: { paused: true } }
  state = runtime.applyToCheckpoint(state, { resolution: legacy, pausedSequence: 0 })
  state = runtime.applyToCheckpoint(state, { resolution: resolution(1), pausedSequence: 1 })
  assert.deepEqual(
    state.directoryAuthorizationResolution.map(({ grant_id: grantId }) => grantId),
    ['grant-0', 'grant-1'],
  )

  const bounded = normalizeDirectoryAuthorizationResolutions(
    Array.from({ length: MAX_DIRECTORY_AUTHORIZATION_RESOLUTIONS + 2 }, (_, index) => resolution(index)),
  )
  assert.equal(bounded.length, MAX_DIRECTORY_AUTHORIZATION_RESOLUTIONS)
  assert.deepEqual(
    bounded.map(({ grant_id: grantId }) => grantId),
    Array.from(
      { length: MAX_DIRECTORY_AUTHORIZATION_RESOLUTIONS },
      (_, index) => `grant-${index + 2}`,
    ),
  )

  const replacement = { ...resolution(10), path: resolution(9).path }
  const deduplicated = normalizeDirectoryAuthorizationResolutions([...bounded, replacement])
  assert.equal(deduplicated.length, MAX_DIRECTORY_AUTHORIZATION_RESOLUTIONS)
  assert.equal(deduplicated.at(-1).grant_id, 'grant-10')
  assert.equal(deduplicated.at(-1).path, resolution(9).path)
})

test('revoked directory grants are removed before checkpoint roots can be restored', () => {
  const first = {
    type: 'directory_authorization',
    approved: true,
    path: 'C:\\Workspace-A',
    access_mode: 'read_write',
    authorization_scope: 'persistent',
    grant_id: 'grant-a',
  }
  const second = {
    ...first,
    path: 'C:\\Workspace-B',
    grant_id: 'grant-b',
  }
  const grants = [{
    id: 'grant-b',
    path: 'c:\\workspace-b\\',
    accessMode: 'read_write',
    resourceType: 'directory',
    scope: 'persistent',
    available: true,
  }]

  assert.deepEqual(filterAuthorizedDirectoryResolutions([first, second], grants), [second])
  assert.deepEqual(filterAuthorizedDirectoryResolutions([first, second], null), [])
})

test('pause and public status projections preserve durable event precedence', () => {
  const runtime = createRuntime()
  const paused = { type: 'turn.paused', sequence: 2 }
  const resumed = { type: 'turn.resumed', sequence: 3 }

  assert.deepEqual(runtime.pauseState([paused]), {
    paused,
    resumed: null,
    pending: true,
  })
  assert.deepEqual(runtime.pauseState([paused, resumed]), {
    paused,
    resumed,
    pending: false,
  })
  assert.equal(runtime.publicStatus(null), 'not_found')
  assert.equal(runtime.publicStatus(paused, true), 'paused')
  assert.equal(runtime.publicStatus({ type: 'turn.blocked' }, true), 'blocked')
  assert.equal(runtime.publicStatus({ type: 'turn.started' }, true), 'running')
  assert.equal(runtime.publicStatus({ type: 'turn.completed' }), 'completed')
  assert.equal(runtime.publicStatus({ type: 'approval.required' }), 'awaiting_approval')
})
