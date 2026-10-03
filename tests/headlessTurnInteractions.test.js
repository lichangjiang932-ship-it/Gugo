import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import { createRunRecoveryPrompts } from '../bin/cli/runRecoveryPrompts.js'
import { createHeadlessTurnInteractions } from '../server/services/headlessTurnInteractions.js'

const scope = { userId: 'interaction-user', sessionId: 'interaction-session', turnId: 'interaction-turn' }
const directory = path.resolve('directory-interaction-fixture')
const pause = () => ({ ...scope, id: 'pause-event', sequence: 4, type: 'turn.paused', payload: {
  clarification: { request_type: 'directory', suggested_path: directory, access_mode: 'read_only', purpose: 'Inspect the requested folder' },
} })
const blocked = () => ({ ...scope, id: 'blocked-event', sequence: 5, type: 'turn.blocked', payload: {
  code: 'SIDE_EFFECT_OUTCOME_UNKNOWN', recoveryKind: 'side_effect_outcome_unknown', requiresUserVerification: true, toolCallId: 'write-once',
} })
const pendingRecord = () => ({ scopeKind: 'turn', scopeKey: JSON.stringify(['turn', scope.sessionId, scope.turnId]),
  sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: 'write-once', toolName: 'write_file', status: 'unknown',
  argsDigest: 'a'.repeat(64), evidence: { targetSummary: [directory] },
})
const directoryGrant = () => ({ id: 'session:directory', path: directory, resourceType: 'directory', scope: 'session', accessMode: 'read_only' })

function controller(input = {}, ports = {}) {
  return createHeadlessTurnInteractions({ input: { interactive: true, ...input }, scope, ports, workspace: path.dirname(directory) })
}

function promptHarness(answers) {
  let output = ''
  const diagnostics = { write: (text) => { output += text } }
  const prompts = createRunRecoveryPrompts({}, diagnostics, { createInterfaceImpl: () => {
    const rl = new EventEmitter()
    rl.closed = false
    rl.close = () => { if (!rl.closed) { rl.closed = true; rl.emit('close') } }
    rl.question = (question, callback) => {
      diagnostics.write(question)
      queueMicrotask(() => {
        const answer = answers.shift()
        if (answer == null) rl.close()
        else callback(answer)
      })
    }
    return rl
  } })
  return { prompts, output: () => output }
}

test('TTY directory confirmation shows canonical exact path/mode and CLI-run-only lifetime', async () => {
  const harness = promptHarness(['yes'])
  const result = await harness.prompts.onDirectoryRequest({ request: pause().payload.clarification,
    workspace: path.dirname(directory), canonicalizeDirectory: async () => directory,
  })
  assert.deepEqual(result, { approved: true, path: directory, accessMode: 'read_only' })
  assert.ok(harness.output().includes(JSON.stringify(directory)))
  assert.match(harness.output(), /read_only/)
  assert.match(harness.output(), /this CLI run only/)
  assert.doesNotMatch(harness.output(), /#\/settings|\/api\/approvals\/settings/)
})

test('TTY unknown outcome offers verified failed/committed/defer, never ordinary allow', async () => {
  for (const [answers, resolution] of [[['1'], 'failed'], [['2'], 'committed'], [['y'], 'defer'], [[''], 'defer'], [[null], 'defer']]) {
    const harness = promptHarness(answers)
    const record = { ...pendingRecord(), failure: { code: 'FIXTURE_UNKNOWN', message: 'safe failure', stack: 'private-stack' },
      outcome: { apiKey: 'sk-private-fixture' } }
    const result = await harness.prompts.onSideEffectRecovery({ record })
    assert.equal(result.resolution, resolution)
    assert.equal(result.approved, undefined)
    if (resolution !== 'defer') {
      assert.equal(result.verificationConfirmed, true)
      assert.equal(result.confirmToolCallId, record.toolCallId)
    }
    assert.match(harness.output(), /FIXTURE_UNKNOWN/)
    assert.doesNotMatch(harness.output(), /Confirm by typing/)
    assert.doesNotMatch(harness.output(), /private-stack|sk-private-fixture/)
  }
})

test('directory authorization binds immutable boundary, exact readonly mode and session grant', async () => {
  const event = pause()
  let granted
  const interaction = controller({ onDirectoryRequest: async ({ request, event: captured }) => {
    assert.equal(Object.isFrozen(request), true)
    assert.equal(Object.isFrozen(captured), true)
    event.payload.clarification.access_mode = 'read_write'
    return { approved: true, path: directory, accessMode: request.access_mode }
  } }, {
    canonicalizeDirectory: async ({ path: value }) => value,
    grantDirectory: async (value) => { granted = value; return directoryGrant() },
  })
  const result = await interaction.prepareResume(event)
  assert.equal(granted.accessMode, 'read_only')
  assert.equal(granted.scope, 'session')
  assert.deepEqual(granted.boundary, { id: 'pause-event', sequence: 4, type: 'turn.paused' })
  assert.equal(Object.isFrozen(granted.boundary), true)
  assert.equal(result.resolution.access_mode, 'read_only')
  assert.equal(result.resolution.paused_sequence, 4)
  assert.equal(result.resolution.grant_id, 'session:directory')
  assert.equal(await interaction.prepareResume(event), null, 'the same boundary is not prompted twice')
})

test('wrong-root, newly persistent and silently widened grants cannot resume the task', async () => {
  for (const change of [{ path: path.parse(directory).root }, { scope: 'persistent' }, { accessMode: 'read_write' }]) {
    const interaction = controller({ onDirectoryRequest: async () => ({ approved: true, path: directory, accessMode: 'read_only' }) }, {
      canonicalizeDirectory: ({ path: value }) => value,
      grantDirectory: () => ({ ...directoryGrant(), ...change }),
    })
    await assert.rejects(interaction.prepareResume(pause()), (error) => error.code === 'CLI_DIRECTORY_GRANT_INVALID')
  }
})

test('a proven already-persistent permission can be reused without widening the readonly resolution', async () => {
  const prior = { id: 'prior-grant', path: directory, scope: 'persistent', accessMode: 'read_write' }
  const interaction = controller({ onDirectoryRequest: async () => ({ approved: true, path: directory, accessMode: 'read_only' }) }, {
    canonicalizeDirectory: ({ path: value }) => value,
    grantDirectory: () => ({ ...prior, resourceType: 'directory', preexistingPermission: { ...prior } }),
  })
  const result = await interaction.prepareResume(pause())
  assert.equal(result.resolution.access_mode, 'read_only')
  assert.equal(result.resolution.authorization_scope, 'persistent')
})

test('unknown recovery requires matching scopeKey and immutable exact-call verification', async () => {
  const record = pendingRecord()
  let resolved
  const interaction = controller({ onSideEffectRecovery: async ({ record: displayed }) => {
    assert.equal(Object.isFrozen(displayed.evidence.targetSummary), true)
    record.scopeKey = 'other-turn'
    return { resolution: 'committed', verificationConfirmed: true, confirmToolCallId: 'write-once' }
  } }, {
    readUnknownSideEffect: () => record,
    resolveUnknownSideEffect: (value) => {
      resolved = value
      return { record: { ...pendingRecord(), status: 'committed' },
        resume: { kind: 'turn', sessionId: scope.sessionId, turnId: scope.turnId, toolCallId: 'write-once' } }
    },
  })
  assert.deepEqual(await interaction.prepareResume(blocked()), { retryRecovery: true })
  assert.equal(resolved.scopeKey, JSON.stringify(['turn', scope.sessionId, scope.turnId]))
  assert.equal(resolved.argsDigest, 'a'.repeat(64))
  assert.deepEqual(resolved.boundary, { id: 'blocked-event', sequence: 5, type: 'turn.blocked' })
  for (const wrong of [{ scopeKey: 'other-turn' }, { turnId: 'another-turn' }, { toolCallId: 'other-call' }]) {
    let writes = 0
    const bad = controller({ onSideEffectRecovery: async () => ({ resolution: 'committed', verificationConfirmed: true, confirmToolCallId: 'write-once' }) }, {
      readUnknownSideEffect: () => ({ ...pendingRecord(), ...wrong }), resolveUnknownSideEffect: () => { writes += 1 },
    })
    await assert.rejects(bad.prepareResume(blocked()), (error) => error.code === 'CLI_RECOVERY_SCOPE_MISMATCH')
    assert.equal(writes, 0)
  }
})

test('bypass, ordinary yes, noninteractive input and model-unknown do not bypass outcome verification', async () => {
  let writes = 0
  const ports = { readUnknownSideEffect: pendingRecord, resolveUnknownSideEffect: () => { writes += 1 } }
  const bad = controller({ permissionMode: 'bypass', onSideEffectRecovery: async () => ({ approved: true }) }, ports)
  await assert.rejects(bad.prepareResume(blocked()), (error) => error.code === 'CLI_RECOVERY_CONFIRMATION_REQUIRED')
  const headless = controller({ interactive: false, onSideEffectRecovery: async () => assert.fail('must not prompt') }, ports)
  assert.equal(await headless.prepareResume(blocked()), null)
  const model = blocked()
  model.payload.code = 'MODEL_REQUEST_OUTCOME_UNKNOWN'
  assert.equal(await bad.prepareResume(model), null)
  assert.equal(writes, 0)
})

test('missing custom-adapter capabilities stop before prompting or falling back to local stores', async () => {
  let prompts = 0
  const interaction = controller({ onDirectoryRequest: async () => { prompts += 1 } }, null)
  await assert.rejects(interaction.prepareResume(pause()), (error) => error.code === 'CLI_INTERACTIVE_RECOVERY_UNSUPPORTED')
  assert.equal(prompts, 0)
})
