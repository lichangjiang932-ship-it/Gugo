import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

import { closeDb } from '../server/db.js'
import { migrateToV79 } from '../server/migrations/v79SideEffectExecutions.js'
import { migrateToV92 } from '../server/migrations/v92HookSideEffectExecutions.js'
import { migrateToV96 } from '../server/migrations/v96SideEffectRecoveryPlans.js'
import {
  canonicalSideEffectArgsDigest,
  createSideEffectScope,
  createSideEffectExecutionLedger,
  getSideEffectExecutionLedger,
  resolveSideEffectExecutionLedger,
  SIDE_EFFECT_LEDGER_CONFLICT,
  SIDE_EFFECT_OUTCOME_UNKNOWN,
  sideEffectRecoveryBlock,
} from '../server/services/sideEffectExecutionLedger.js'
import {
  createSideEffectExecution,
  markSideEffectOutcomeKnownFailed,
} from '../server/services/loop/sideEffectExecution.js'
import {
  encodeSideEffectOutcome,
  sanitizeSideEffectFailure,
  sanitizeSideEffectFailureText,
} from '../server/services/sideEffectExecutionSerialization.js'
import { listUnknownSideEffects } from '../server/services/sideEffectRecoveryService.js'
import {
  getToolMetadata,
  registerDynamicTool,
} from '../server/services/toolRegistry.js'

function fixture() {
  const db = new Database(':memory:')
  migrateToV79(db)
  migrateToV92(db)
  migrateToV96(db)
  let now = 10
  const ledger = createSideEffectExecutionLedger({ db, now: () => now++ })
  const input = {
    scope: {
      ownerId: 'owner-a',
      kind: 'job',
      scopeKey: '["job","job-a","step-a"]',
      sessionId: null,
      turnId: null,
      jobId: 'job-a',
      stepId: 'step-a',
    },
    toolCallId: 'call-a',
    idempotencyKey: 'job:job-a:step:step-a:tool:call-a',
    toolName: 'bash_exec',
    args: { cwd: 'D:\\repo', command: 'git commit -am test' },
  }
  return { db, ledger, input }
}

function ledgerContractStub() {
  return Object.fromEntries([
    'prepare',
    'read',
    'prepareRecovery',
    'readRecovery',
    'claimExecution',
    'markExecuting',
    'markUnknown',
    'finish',
    'parseOutcome',
  ].map((name) => [name, () => null]))
}

function loopExecutionFor(ledger, input, checkpointStatus = 'pending') {
  return createSideEffectExecution({
    ledger,
    durableToolNames: new Set([input.toolName]),
    toolName: input.toolName,
    call: {
      id: input.toolCallId, idempotencyKey: input.idempotencyKey, checkpointStatus,
      checkpointReadOnly: false,
    },
    job: { id: input.scope.jobId, userId: input.scope.ownerId },
    step: { id: input.scope.stepId },
    approvalOrigin: 'job',
    createScope: createSideEffectScope,
    recoveryBlock: sideEffectRecoveryBlock,
    conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
    unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
  })
}

test('durable ledger resolution is explicit and never invents an anonymous owner', () => {
  const ledger = ledgerContractStub()
  assert.equal(resolveSideEffectExecutionLedger({
    usesDefaultExecutor: true,
    getDefaultLedger: () => ledger,
  }), ledger)
  assert.equal(resolveSideEffectExecutionLedger({ usesDefaultExecutor: false }), null)
  assert.equal(resolveSideEffectExecutionLedger({
    configuredLedger: null,
    usesDefaultExecutor: true,
    getDefaultLedger: () => { throw new Error('must not resolve default') },
  }), null)
  assert.equal(resolveSideEffectExecutionLedger({ configuredLedger: ledger }), ledger)
  assert.throws(
    () => resolveSideEffectExecutionLedger({ configuredLedger: false }),
    /durable side-effect ledger contract/,
  )
  assert.throws(
    () => createSideEffectScope({
      job: { id: 'anonymous-job', userId: null },
      step: { id: 'anonymous-step' },
    }),
    /ownerId is required/,
  )
  assert.throws(
    () => createSideEffectScope({
      job: { id: 'chat-job', userId: 'owner-a', origin: 'chat' },
      step: { id: 'chat-step' },
      approvalOrigin: 'chat',
    }),
    /sessionId is required/,
  )
  assert.deepEqual(createSideEffectScope({
    job: { id: 'low-level-chat-job', userId: 'owner-a', origin: 'chat' },
    step: { id: 'low-level-chat-step' },
  }), {
    ownerId: 'owner-a',
    kind: 'job',
    scopeKey: JSON.stringify(['job', 'low-level-chat-job', 'low-level-chat-step']),
    sessionId: null,
    turnId: null,
    jobId: 'low-level-chat-job',
    stepId: 'low-level-chat-step',
  })
})

test('a loop contender that loses the execution claim cannot execute or mutate the winner', () => {
  const ledger = ledgerContractStub()
  let markedUnknown = false
  ledger.claimExecution = () => ({
    claimed: false,
    record: { status: 'executing', ownerId: 'owner-a' },
  })
  ledger.markUnknown = () => {
    markedUnknown = true
    throw new Error('must not be called by a losing contender')
  }
  const execution = createSideEffectExecution({
    ledger,
    durableToolNames: new Set(['bash_exec']),
    toolName: 'bash_exec',
    call: { id: 'call-a', idempotencyKey: 'key-a' },
    job: { id: 'job-a', userId: 'owner-a' },
    step: { id: 'step-a' },
    approvalOrigin: 'job',
    createScope: createSideEffectScope,
    recoveryBlock: sideEffectRecoveryBlock,
    conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
    unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
  })

  assert.throws(
    () => execution.markExecuting({}),
    (error) => error?.code === SIDE_EFFECT_OUTCOME_UNKNOWN
      && error?.unsafeToReplay === true,
  )
  assert.equal(markedUnknown, false)
})

test('durable coverage follows canonical per-call risk metadata instead of a fixed name list', () => {
  const ledger = ledgerContractStub()
  const dynamicNames = {
    read: `test_dynamic_read_${Date.now()}`,
    write: `test_dynamic_write_${Date.now()}`,
  }
  const registrations = [
    registerDynamicTool({
      name: dynamicNames.read,
      origin: 'mcp',
      spec: {
        type: 'function',
        function: { name: dynamicNames.read, parameters: { type: 'object' } },
      },
      metadata: { category: 'read', isReadOnly: true },
    }),
    registerDynamicTool({
      name: dynamicNames.write,
      origin: 'plugin',
      spec: {
        type: 'function',
        function: { name: dynamicNames.write, parameters: { type: 'object' } },
      },
      metadata: { category: 'external', isReadOnly: false },
    }),
  ]

  const enabledFor = (toolName) => createSideEffectExecution({
    ledger,
    isDurableSideEffect: (args) => getToolMetadata(toolName, {
      args,
      userId: 'owner-a',
    }).isReadOnly !== true,
    toolName,
    call: { id: `call-${toolName}`, idempotencyKey: `key-${toolName}` },
    job: { id: 'job-a', userId: 'owner-a' },
    step: { id: 'step-a' },
    approvalOrigin: 'job',
    createScope: createSideEffectScope,
    recoveryBlock: sideEffectRecoveryBlock,
    conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
    unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
  }).enabledFor

  try {
    assert.equal(enabledFor('list_directory')({ path: '.' }), false)
    assert.equal(enabledFor('run_project_check')({ command: 'npm test' }), true)
    assert.equal(enabledFor('create_pdf')({ output: 'report.pdf' }), true)
    assert.equal(enabledFor('bash_exec')({ command: 'git status --short' }), false)
    assert.equal(enabledFor('bash_exec')({ command: 'git commit -am test' }), true)
    assert.equal(enabledFor(dynamicNames.read)({}), false)
    assert.equal(enabledFor(dynamicNames.write)({}), true)
  } finally {
    for (const dispose of registrations.reverse()) dispose()
  }
})

test('side-effect args digest is canonical and identity drift fails closed', () => {
  const { db, ledger, input } = fixture()
  try {
    assert.equal(
      canonicalSideEffectArgsDigest({ command: 'x', cwd: 'y' }),
      canonicalSideEffectArgsDigest({ cwd: 'y', command: 'x' }),
    )
    ledger.prepare(input)
    assert.throws(
      () => ledger.read({ ...input, args: { ...input.args, command: 'git push' } }),
      (error) => error?.code === 'SIDE_EFFECT_LEDGER_CONFLICT' && error?.unsafeToReplay === true,
    )
  } finally {
    db.close()
  }
})

test('recovery plans are canonical, immutable, and idempotent while executing', () => {
  const { db, ledger, input } = fixture()
  try {
    ledger.prepare(input)
    ledger.claimExecution(input)
    const plan = {
      verifier: 'write_file_content_v1',
      expected: { sha256: 'a'.repeat(64), path: 'output.txt' },
    }
    assert.deepEqual(ledger.prepareRecovery(input, plan), plan)
    assert.deepEqual(ledger.readRecovery(input), plan)
    assert.deepEqual(ledger.read(input).recovery, plan)
    assert.equal(
      db.prepare('SELECT recovery_json FROM side_effect_executions').get().recovery_json,
      JSON.stringify({
        expected: { path: 'output.txt', sha256: 'a'.repeat(64) },
        verifier: 'write_file_content_v1',
      }),
    )

    assert.deepEqual(ledger.prepareRecovery(input, {
      expected: { path: 'output.txt', sha256: 'a'.repeat(64) },
      verifier: 'write_file_content_v1',
    }), plan)
    assert.throws(
      () => ledger.prepareRecovery(input, {
        ...plan,
        expected: { ...plan.expected, sha256: 'b'.repeat(64) },
      }),
      (error) => error?.code === SIDE_EFFECT_LEDGER_CONFLICT
        && error?.unsafeToReplay === true,
    )
    assert.deepEqual(ledger.readRecovery(input), plan)
  } finally {
    db.close()
  }
})

test('recovery plans fail closed on identity drift and after terminal completion', () => {
  const { db, ledger, input } = fixture()
  try {
    ledger.prepare(input)
    ledger.claimExecution(input)
    ledger.finish(input, { status: 'committed', outcome: { ok: true } })
    assert.equal(ledger.readRecovery(input), null)
    assert.throws(
      () => ledger.prepareRecovery(input, { verifier: 'write_file_content_v1' }),
      (error) => error?.code === SIDE_EFFECT_LEDGER_CONFLICT
        && error?.sideEffectExecution?.status === 'committed',
    )
    assert.throws(
      () => ledger.readRecovery({
        ...input,
        args: { ...input.args, command: 'git push' },
      }),
      (error) => error?.code === SIDE_EFFECT_LEDGER_CONFLICT
        && error?.unsafeToReplay === true,
    )
    assert.equal(
      db.prepare('SELECT recovery_json FROM side_effect_executions').get().recovery_json,
      null,
    )
  } finally {
    db.close()
  }
})

test('an unreadable persisted recovery plan fails closed instead of appearing absent', () => {
  const { db, ledger, input } = fixture()
  try {
    ledger.prepare(input)
    ledger.claimExecution(input)
    db.prepare('UPDATE side_effect_executions SET recovery_json = ?').run('{not-json')
    assert.throws(
      () => ledger.readRecovery(input),
      (error) => error?.code === SIDE_EFFECT_LEDGER_CONFLICT
        && error?.unsafeToReplay === true,
    )
    assert.throws(
      () => ledger.prepareRecovery(input, { verifier: 'write_file_content_v1' }),
      (error) => error?.code === SIDE_EFFECT_LEDGER_CONFLICT
        && error?.unsafeToReplay === true,
    )
  } finally {
    db.close()
  }
})

test('the default ledger follows the current database after close and reopen', () => {
  const previousPath = process.env.APP_DB_PATH
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-side-effect-ledger-'))
  const input = {
    scope: {
      ownerId: 'reopen-owner',
      kind: 'job',
      scopeKey: '["job","reopen-job","reopen-step"]',
      sessionId: null,
      turnId: null,
      jobId: 'reopen-job',
      stepId: 'reopen-step',
    },
    toolCallId: 'reopen-call',
    idempotencyKey: 'job:reopen-job:step:reopen-step:tool:reopen-call',
    toolName: 'write_file',
    args: { path: 'reopen.txt', content: 'durable' },
  }
  try {
    closeDb()
    process.env.APP_DB_PATH = path.join(directory, 'first.db')
    const first = getSideEffectExecutionLedger()
    assert.equal(first.prepare(input).status, 'prepared')

    closeDb()
    process.env.APP_DB_PATH = path.join(directory, 'second.db')
    const second = getSideEffectExecutionLedger()
    assert.notEqual(second, first)
    assert.equal(second.read(input), null)
    assert.equal(second.prepare(input).status, 'prepared')
  } finally {
    closeDb()
    if (previousPath === undefined) delete process.env.APP_DB_PATH
    else process.env.APP_DB_PATH = previousPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an execution error after the side-effect boundary becomes unknown, never failed', () => {
  const { db, ledger, input } = fixture()
  try {
    assert.equal(ledger.prepare(input).status, 'prepared')
    assert.equal(ledger.markExecuting(input).status, 'executing')
    assert.equal(ledger.markUnknown(input).status, 'unknown')
    assert.equal(ledger.prepare(input).status, 'unknown')
  } finally {
    db.close()
  }
})

test('only an in-process proof can record a rolled-back execution as known failed', () => {
  const createExecution = (ledger) => createSideEffectExecution({
    ledger,
    durableToolNames: new Set(['bash_exec']),
    toolName: 'bash_exec',
    call: { id: 'call-a', idempotencyKey: 'job:job-a:step:step-a:tool:call-a' },
    job: { id: 'job-a', userId: 'owner-a' },
    step: { id: 'step-a' },
    approvalOrigin: 'job',
    createScope: createSideEffectScope,
    recoveryBlock: sideEffectRecoveryBlock,
    conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
    unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
  })

  const proven = fixture()
  try {
    const execution = createExecution(proven.ledger)
    const prepared = execution.prepare(proven.input.args)
    execution.markExecuting(prepared.input)
    const sourceError = markSideEffectOutcomeKnownFailed(
      new Error('transaction rolled back'),
      { code: 'ARTIFACT_TRANSACTION_ROLLED_BACK', retryable: true },
    )
    assert.throws(
      () => execution.rethrowExecutionError({
        error: sourceError,
        input: prepared.input,
        started: true,
        returned: false,
        result: null,
        checkpointFlushErrorCode: 'CHECKPOINT_FLUSH_FAILED',
      }),
      (error) => error === sourceError,
    )
    const failed = proven.ledger.read(proven.input)
    assert.equal(failed.status, 'failed')
    assert.deepEqual(proven.ledger.parseOutcome(failed), {
      ok: false,
      code: 'ARTIFACT_TRANSACTION_ROLLED_BACK',
      error: 'The tool failed without leaving an unverified side effect.',
      retryable: true,
      sideEffectLedgerReplay: true,
    })
  } finally {
    proven.db.close()
  }

  const spoofed = fixture()
  try {
    const execution = createExecution(spoofed.ledger)
    const prepared = execution.prepare(spoofed.input.args)
    execution.markExecuting(prepared.input)
    const sourceError = Object.assign(new Error('plugin-controlled failure'), {
      sideEffectOutcomeKnownFailed: true,
      code: 'FAKE_ROLLBACK_PROOF',
      retryable: true,
    })
    assert.throws(
      () => execution.rethrowExecutionError({
        error: sourceError,
        input: prepared.input,
        started: true,
        returned: false,
        result: null,
        checkpointFlushErrorCode: 'CHECKPOINT_FLUSH_FAILED',
      }),
      (error) => error?.code === SIDE_EFFECT_OUTCOME_UNKNOWN
        && error?.unsafeToReplay === true,
    )
    assert.equal(spoofed.ledger.read(spoofed.input).status, 'unknown')
  } finally {
    spoofed.db.close()
  }
})

test('only one caller can claim a prepared side-effect execution', () => {
  const { db, ledger, input } = fixture()
  try {
    assert.equal(ledger.prepare(input).status, 'prepared')

    const winner = ledger.claimExecution(input)
    assert.equal(winner.claimed, true)
    assert.equal(winner.record.status, 'executing')

    const contender = ledger.claimExecution(input)
    assert.equal(contender.claimed, false)
    assert.equal(contender.record.status, 'executing')
    assert.equal(ledger.read(input).status, 'executing')
    assert.throws(
      () => ledger.markExecuting(input),
      (error) => error?.code === 'SIDE_EFFECT_OUTCOME_UNKNOWN'
        && error?.unsafeToReplay === true
        && error?.sideEffectExecution?.status === 'executing',
    )

    assert.equal(ledger.markUnknown(input).status, 'unknown')
    const unknown = ledger.claimExecution(input)
    assert.equal(unknown.claimed, false)
    assert.equal(unknown.record.status, 'unknown')
  } finally {
    db.close()
  }
})

test('committed and failed outcomes are durable and isolated by owner/scope', () => {
  const { db, ledger, input } = fixture()
  try {
    ledger.prepare(input)
    ledger.markExecuting(input)
    const committed = ledger.finish(input, { status: 'committed', outcome: { ok: true, stdout: 'done' } })
    assert.equal(committed.status, 'committed')
    assert.deepEqual(ledger.parseOutcome(committed), { ok: true, stdout: 'done', sideEffectLedgerReplay: true })

    const otherScope = {
      ...input,
      scope: { ...input.scope, ownerId: 'owner-b' },
    }
    assert.equal(ledger.read(otherScope), null)
    assert.equal(ledger.prepare(otherScope).status, 'prepared')
  } finally {
    db.close()
  }
})

test('explicitly uncertain connector results remain recoverable and are never replayed', () => {
  const isSuccessful = (result) => result?.ok === true
  const createExecution = (ledger, input) => createSideEffectExecution({
    ledger,
    durableToolNames: new Set([input.toolName]),
    toolName: input.toolName,
    call: { id: input.toolCallId, idempotencyKey: input.idempotencyKey },
    job: { id: input.scope.jobId, userId: input.scope.ownerId },
    step: { id: input.scope.stepId },
    approvalOrigin: 'job',
    createScope: createSideEffectScope,
    recoveryBlock: sideEffectRecoveryBlock,
    conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
    unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
  })

  const uncertain = fixture()
  try {
    uncertain.input.toolName = 'github_create_issue'
    const execution = createExecution(uncertain.ledger, uncertain.input)
    const prepared = execution.prepare(uncertain.input.args)
    execution.markExecuting(prepared.input)
    const result = {
      ok: false,
      code: 'connector_write_in_progress',
      error: 'Verify the provider state before retrying.',
      retryable: false,
      requiresUserVerification: true,
    }

    const record = execution.finish(prepared.input, result, isSuccessful)
    assert.equal(record.status, 'unknown')
    assert.deepEqual(uncertain.ledger.parseOutcome(record), {
      ...result,
      sideEffectLedgerReplay: true,
    })
    assert.deepEqual(
      listUnknownSideEffects({ userId: uncertain.input.scope.ownerId, db: uncertain.db }).records
        .map((entry) => entry.toolCallId),
      [uncertain.input.toolCallId],
    )
    assert.throws(
      () => execution.prepare(uncertain.input.args),
      (error) => error?.code === SIDE_EFFECT_OUTCOME_UNKNOWN
        && error?.unsafeToReplay === true
        && error?.sideEffectExecution?.status === 'unknown',
    )
  } finally {
    uncertain.db.close()
  }

  for (const [result, expectedStatus] of [
    [{ ok: false, code: 'connector_validation_failed', retryable: false }, 'failed'],
    [{ ok: true, issue: { number: 9 } }, 'committed'],
  ]) {
    const certain = fixture()
    try {
      certain.input.toolName = 'github_create_issue'
      const execution = createExecution(certain.ledger, certain.input)
      const prepared = execution.prepare(certain.input.args)
      execution.markExecuting(prepared.input)
      assert.equal(execution.finish(prepared.input, result, isSuccessful).status, expectedStatus)
    } finally {
      certain.db.close()
    }
  }
})

test('oversized outcomes retain recovery metadata inside the ledger byte limit', () => {
  const { db, ledger, input } = fixture()
  try {
    const outcome = {
      ok: true,
      stdout: 'x'.repeat(256 * 1024),
      artifactIds: ['artifact-primary', 'artifact-secondary'],
      verifiedOutputs: [{ path: 'D:\\repo\\dist\\report.pdf', sha256: 'a'.repeat(64) }],
      changedPaths: ['dist/report.pdf', 'manifest.json'],
    }
    ledger.prepare(input)
    ledger.claimExecution(input)
    const committed = ledger.finish(input, { status: 'committed', outcome })
    assert.ok(Buffer.byteLength(committed.outcomeJson, 'utf8') <= 128 * 1024)

    const replay = ledger.parseOutcome(committed)
    assert.equal(replay.stdout, undefined)
    assert.equal(replay.ledgerOutcomeTruncated, true)
    assert.match(replay.outcomeDigest, /^[a-f0-9]{64}$/)
    assert.deepEqual(replay.artifactIds, outcome.artifactIds)
    assert.deepEqual(replay.verifiedOutputs, outcome.verifiedOutputs)
    assert.deepEqual(replay.changedPaths, outcome.changedPaths)
  } finally {
    db.close()
  }
})

test('a returned tool result is retained when final ledger persistence becomes unknown', () => {
  const { db, ledger, input } = fixture()
  try {
    ledger.prepare(input)
    ledger.claimExecution(input)
    const execution = createSideEffectExecution({
      ledger,
      durableToolNames: new Set(['bash_exec']),
      toolName: input.toolName,
      call: { id: input.toolCallId, idempotencyKey: input.idempotencyKey },
      job: { id: input.scope.jobId, userId: input.scope.ownerId },
      step: { id: input.scope.stepId },
      approvalOrigin: 'job',
      createScope: createSideEffectScope,
      recoveryBlock: sideEffectRecoveryBlock,
      conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
      unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
    })
    const returned = {
      ok: true,
      artifactIds: ['artifact-after-return'],
      verifiedOutputs: [{ path: 'D:\\repo\\after-return.txt' }],
      changedPaths: ['after-return.txt'],
    }

    assert.throws(
      () => execution.rethrowExecutionError({
        error: new Error('final ledger update failed'),
        input,
        started: true,
        returned: true,
        result: returned,
        checkpointFlushErrorCode: 'CHECKPOINT_FLUSH_FAILED',
      }),
      (error) => error?.code === SIDE_EFFECT_OUTCOME_UNKNOWN
        && error?.unsafeToReplay === true,
    )
    const unknown = ledger.read(input)
    assert.equal(unknown.status, 'unknown')
    assert.deepEqual(ledger.parseOutcome(unknown), {
      ...returned,
      failure: { code: 'TOOL_EXECUTION_FAILED', message: 'final ledger update failed' },
      sideEffectLedgerReplay: true,
    })
  } finally {
    db.close()
  }
})

test('historical ledger state wins when current metadata drifts to read-only', () => {
  const { db, ledger, input } = fixture()
  try {
    ledger.prepare(input)
    ledger.claimExecution(input)
    const execution = createSideEffectExecution({
      ledger,
      isDurableSideEffect: () => false,
      toolName: input.toolName,
      call: {
        id: input.toolCallId,
        idempotencyKey: input.idempotencyKey,
        checkpointStatus: 'executing',
        checkpointReadOnly: false,
      },
      job: { id: input.scope.jobId, userId: input.scope.ownerId },
      step: { id: input.scope.stepId },
      approvalOrigin: 'job',
      createScope: createSideEffectScope,
      recoveryBlock: sideEffectRecoveryBlock,
      conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
      unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
    })
    assert.throws(
      () => execution.recover(input.args),
      (error) => error?.code === SIDE_EFFECT_OUTCOME_UNKNOWN
        && error?.sideEffectExecution?.status === 'unknown',
    )
    assert.equal(ledger.read(input).status, 'unknown')
  } finally {
    db.close()
  }
})

test('only an explicitly read-only historical checkpoint may resume without a ledger row', () => {
  const { db, ledger, input } = fixture()
  try {
    const build = (checkpointReadOnly) => createSideEffectExecution({
      ledger,
      isDurableSideEffect: () => false,
      toolName: input.toolName,
      call: {
        id: input.toolCallId,
        idempotencyKey: input.idempotencyKey,
        checkpointStatus: 'executing',
        ...(checkpointReadOnly === undefined ? {} : { checkpointReadOnly }),
      },
      job: { id: input.scope.jobId, userId: input.scope.ownerId },
      step: { id: input.scope.stepId },
      approvalOrigin: 'job',
      createScope: createSideEffectScope,
      recoveryBlock: sideEffectRecoveryBlock,
      conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
      unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
    })
    assert.deepEqual(build(true).recover(input.args), { resumedPrepared: false, result: null })
    assert.throws(
      () => build(undefined).recover(input.args),
      (error) => error?.code === SIDE_EFFECT_OUTCOME_UNKNOWN && error?.unsafeToReplay === true,
    )
    assert.throws(
      () => build(false).recover(input.args),
      (error) => error?.code === SIDE_EFFECT_OUTCOME_UNKNOWN && error?.unsafeToReplay === true,
    )
  } finally {
    db.close()
  }
})

test('committed history replays safe outcome without local audit after metadata drift', () => {
  const { db, ledger, input } = fixture()
  try {
    ledger.prepare(input)
    ledger.claimExecution(input)
    ledger.finish(input, {
      status: 'committed',
      outcome: { ok: true, changedPaths: ['done.txt'], audit: { confirmedBy: 'owner-a', note: 'private' } },
    })
    const execution = createSideEffectExecution({
      ledger,
      isDurableSideEffect: () => false,
      toolName: input.toolName,
      call: {
        id: input.toolCallId,
        idempotencyKey: input.idempotencyKey,
        checkpointStatus: 'executing',
        checkpointReadOnly: false,
      },
      job: { id: input.scope.jobId, userId: input.scope.ownerId },
      step: { id: input.scope.stepId },
      approvalOrigin: 'job',
      createScope: createSideEffectScope,
      recoveryBlock: sideEffectRecoveryBlock,
      conflictCode: SIDE_EFFECT_LEDGER_CONFLICT,
      unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
    })
    assert.deepEqual(execution.recover(input.args), {
      resumedPrepared: false,
      result: { ok: true, changedPaths: ['done.txt'], sideEffectLedgerReplay: true },
    })
  } finally {
    db.close()
  }
})

test('unknown tool failures persist their safe cause and stay blocked across a cold ledger read', () => {
  const { db, ledger, input } = fixture()
  input.toolName = 'create_pptx'
  try {
    const execution = loopExecutionFor(ledger, input)
    const prepared = execution.prepare(input.args)
    execution.markExecuting(prepared.input)
    const sourceError = Object.assign(new Error('slides[7].bullets or body must contain an item'), {
      code: 'PPTX_CONTENT_INVALID',
      cause: Object.assign(new Error('process layout needs body content'), { code: 'PPTX_LAYOUT_INVALID' }),
      args: { private: 'ARGUMENTS_MUST_NOT_ESCAPE' },
      request: { headers: { Authorization: 'Bearer DO_NOT_EXPOSE_REQUEST' } },
      stack: 'STACK_MUST_NOT_ESCAPE',
      sideEffectOutcomeKnownFailed: true,
    })
    const expectedFailure = {
      code: 'PPTX_CONTENT_INVALID',
      message: 'slides[7].bullets or body must contain an item',
      cause: { code: 'PPTX_LAYOUT_INVALID', message: 'process layout needs body content' },
    }
    assert.throws(() => execution.rethrowExecutionError({
      error: sourceError, input: prepared.input, started: true, returned: false,
      checkpointFlushErrorCode: 'CHECKPOINT_FLUSH_FAILED',
    }), (error) => {
      assert.equal(error.code, SIDE_EFFECT_OUTCOME_UNKNOWN)
      assert.equal(error.unsafeToReplay, true)
      assert.equal(error.requiresUserVerification, true)
      assert.equal(error.retryable, false)
      assert.notEqual(error.cause, sourceError)
      assert.deepEqual(error.cause, expectedFailure)
      assert.match(error.message, /PPTX_CONTENT_INVALID: slides\[7\]\.bullets/)
      return true
    })
    const row = ledger.read(input)
    assert.equal(row.status, 'unknown', 'a validation-looking code is not a rollback proof')
    assert.deepEqual(JSON.parse(row.outcomeJson), {
      ok: false, code: SIDE_EFFECT_OUTCOME_UNKNOWN,
      error: expectedFailure.message, retryable: false, requiresUserVerification: true,
      failure: expectedFailure,
    })
    assert.doesNotMatch(row.outcomeJson, /ARGUMENTS_MUST_NOT_ESCAPE|DO_NOT_EXPOSE_REQUEST|STACK_MUST_NOT_ESCAPE/)
    const coldLedger = createSideEffectExecutionLedger({ db })
    const recovered = loopExecutionFor(coldLedger, input, 'executing')
    for (const resume of [
      () => recovered.recover(input.args),
      () => recovered.prepare(input.args),
    ]) {
      assert.throws(resume, (error) => {
        assert.equal(error.code, SIDE_EFFECT_OUTCOME_UNKNOWN)
        assert.equal(error.unsafeToReplay, true)
        assert.deepEqual(error.cause, expectedFailure)
        return true
      })
    }
    assert.equal(coldLedger.claimExecution(input).claimed, false, 'an unknown operation must never be reclaimed')
    assert.equal(coldLedger.read(input).outcomeJson, row.outcomeJson)
  } finally {
    db.close()
  }
})

test('known-failed proofs may retain explicit actionable diagnostics without trusting raw error fields', () => {
  const { db, ledger, input } = fixture()
  try {
    const execution = loopExecutionFor(ledger, input)
    const prepared = execution.prepare(input.args)
    execution.markExecuting(prepared.input)
    const source = markSideEffectOutcomeKnownFailed(
      Object.assign(new Error('raw args={"secret":"DO_NOT_PUBLISH"}'), { code: 'UNTRUSTED_RAW_CODE' }),
      {
        code: 'PPTX_CONTENT_INVALID',
        message: 'slides[8].bullets or body must contain text when layout is "split"',
        hint: 'Add the missing body. api_key="SYNTHETIC_PRIVATE_VALUE"',
        causeCode: 'PPTX_LAYOUT_INVALID',
      },
    )
    assert.throws(() => execution.rethrowExecutionError({
      error: source, input: prepared.input, started: true, returned: false,
      checkpointFlushErrorCode: 'CHECKPOINT_FLUSH_FAILED',
    }), (error) => error === source)
    const row = ledger.read(input)
    assert.equal(row.status, 'failed')
    const result = ledger.parseOutcome(row)
    assert.equal(result.code, 'PPTX_CONTENT_INVALID')
    assert.equal(result.error, 'slides[8].bullets or body must contain text when layout is "split"')
    assert.match(result.hint, /Add the missing body/)
    assert.deepEqual(result.cause, { code: 'PPTX_LAYOUT_INVALID' })
    assert.doesNotMatch(row.outcomeJson, /SYNTHETIC_PRIVATE_VALUE|DO_NOT_PUBLISH|UNTRUSTED_RAW_CODE/)
    assert.equal(result.sideEffectLedgerReplay, true)
  } finally {
    db.close()
  }
})

test('safe failure diagnostics redact credentials, request bodies and secret-bearing URLs before truncation', () => {
  const cases = [
    ['render rejected Bearer SYNTHETIC_BEARER_VALUE_1234', 'SYNTHETIC_BEARER_VALUE_1234'],
    ['render rejected password="SYNTHETIC PASSWORD VALUE"', 'SYNTHETIC PASSWORD VALUE'],
    ['render rejected MODEL_API_KEY=SYNTHETIC_ENV_CREDENTIAL', 'SYNTHETIC_ENV_CREDENTIAL'],
    ['render rejected https://user:SYNTHETIC_URL_PASSWORD@example.test/path?key=SYNTHETIC_QUERY', 'SYNTHETIC_'],
    ['render rejected https://hooks.slack.com/services/SYNTHETIC_WEBHOOK_SECRET', 'SYNTHETIC_WEBHOOK_SECRET'],
    ['render rejected Cookie: session=SYNTHETIC_SESSION_VALUE', 'SYNTHETIC_SESSION_VALUE'],
    ['render rejected {"args":{"content":"SYNTHETIC_PRIVATE_CONTENT"}}', 'SYNTHETIC_PRIVATE_CONTENT'],
    ['render rejected args: content=SYNTHETIC_RAW_ARGS', 'SYNTHETIC_RAW_ARGS'],
    ['render rejected ["SYNTHETIC_RAW_ARRAY"]', 'SYNTHETIC_RAW_ARRAY'],
    ['render rejected github_pat_SYNTHETIC_GITHUB_PAT_1234567890', 'SYNTHETIC_GITHUB_PAT'],
    ['render rejected sk_test_SYNTHETIC_STRIPE_VALUE_1234567890', 'SYNTHETIC_STRIPE_VALUE'],
    ['render rejected eyJzdWIiOiIxMjM0NTY3ODkwIn0.eyJyb2xlIjoiYWRtaW4ifQ.SYNTHETIC_SIGNATURE', 'SYNTHETIC_SIGNATURE'],
    ['render rejected -----BEGIN PRIVATE KEY----- SYNTHETIC_PRIVATE_KEY -----END PRIVATE KEY-----', 'SYNTHETIC_PRIVATE_KEY'],
    ['x'.repeat(990) + ' password=SYNTHETIC_BOUNDARY_SECRET', 'SYNTHETIC_BOUNDARY_SECRET'.slice(0, 4)],
  ]
  for (const [message, sensitive] of cases) {
    const failure = sanitizeSideEffectFailure({ code: 'PPTX_CONTENT_INVALID', message })
    assert.equal(failure.code, 'PPTX_CONTENT_INVALID')
    assert.equal(JSON.stringify(failure).includes(sensitive), false, message)
    assert.ok(failure.message.length <= 1_000)
  }
  assert.equal(
    sanitizeSideEffectFailureText('slides[7].bullets or body must contain text when layout is "process"'),
    'slides[7].bullets or body must contain text when layout is "process"',
  )
})

test('safe failure cause projection is bounded and does not invoke hostile error getters', () => {
  let getterCalls = 0
  const hostile = Object.create(null, {
    message: { get() { getterCalls += 1; throw new Error('private getter') } },
    code: { get() { getterCalls += 1; throw new Error('private code getter') } },
    cause: { get() { getterCalls += 1; throw new Error('private cause getter') } },
  })
  assert.deepEqual(sanitizeSideEffectFailure(hostile), {
    code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed.',
  })
  assert.equal(getterCalls, 0)
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  assert.doesNotThrow(() => sanitizeSideEffectFailure(revoked.proxy))
  const cyclic = Object.assign(new Error('root'), { code: 'ROOT' })
  cyclic.cause = cyclic
  assert.deepEqual(sanitizeSideEffectFailure(cyclic), { code: 'ROOT', message: 'root' })
  const chain = { code: 'FIRST', message: 'first', cause: {
    code: 'SECOND', message: 'second', cause: {
      code: 'THIRD', message: 'third', cause: { code: 'FOURTH', message: 'omit this' },
    },
  } }
  const failure = sanitizeSideEffectFailure(chain)
  assert.equal(failure.cause.cause.code, 'THIRD')
  assert.equal(failure.cause.cause.cause, undefined)
  assert.equal(sanitizeSideEffectFailure({ message: 'x'.repeat(16_385) }).message, 'Tool execution failed.')
})

test('unknown failure diagnostics remain visible even when marking the ledger unknown fails', () => {
  const { db, ledger, input } = fixture()
  try {
    ledger.prepare(input)
    ledger.claimExecution(input)
    const execution = loopExecutionFor({
      ...ledger,
      markUnknown: () => { throw new Error('ledger temporarily unavailable') },
    }, input)
    assert.throws(() => execution.rethrowExecutionError({
      error: Object.assign(new Error('archive write failed'), { code: 'EIO' }),
      input, started: true, returned: false,
      checkpointFlushErrorCode: 'CHECKPOINT_FLUSH_FAILED',
    }), (error) => error.code === SIDE_EFFECT_OUTCOME_UNKNOWN
      && error.unsafeToReplay === true
      && error.sideEffectExecution === null
      && error.cause?.code === 'EIO'
      && error.cause?.message === 'archive write failed')
    assert.equal(ledger.read(input).status, 'executing')
    assert.equal(ledger.claimExecution(input).claimed, false)
  } finally {
    db.close()
  }
})

test('oversized returned outcomes retain bounded safe failure evidence', () => {
  const failure = {
    code: 'SQLITE_IOERR', message: 'ledger flush failed',
    cause: { code: 'EIO', message: 'disk unavailable', headers: { private: 'HIDDEN_PRIVATE_HEADER' } },
  }
  const encoded = encodeSideEffectOutcome({
    ok: true, stdout: 'x'.repeat(256 * 1024), artifactIds: ['artifact-after-failure'], failure,
  })
  assert.ok(Buffer.byteLength(encoded) <= 128 * 1024)
  const result = JSON.parse(encoded)
  assert.deepEqual(result.failure, {
    code: failure.code, message: failure.message,
    cause: { code: 'EIO', message: 'disk unavailable' },
  })
  assert.deepEqual(result.artifactIds, ['artifact-after-failure'])
  assert.doesNotMatch(encoded, /HIDDEN_PRIVATE_HEADER/)
})
