import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-config-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
fs.writeFileSync(path.join(tempDir, '.env'), '', 'utf8')

const { closeDb, getDb } = await import('../server/db.js')
const { handleEvolutionRequest } = await import('../server/routes/evolutionRoutes.js')
const {
  applyEvolutionConfigCandidate,
  buildEvolutionConfigApplyReview,
  buildEvolutionConfigApprovalReview,
  decideEvolutionConfigApproval,
  getEvolutionConfigChange,
  reverseEvolutionConfigChange,
} = await import('../server/services/evolutionConfigChangeService.js')
const {
  canonicalEvolutionConfigPatch,
  configSha256,
  normalizeEvolutionConfigPatch,
} = await import('../server/services/evolutionConfigPolicy.js')
const {
  atomicWriteEvolutionRuntimeConfig,
} = await import('../server/services/evolutionConfigRuntime.js')
const {
  evaluateEvolutionConfigReplay,
  runEvolutionConfigReplay,
} = await import('../server/services/evolutionConfigReplayService.js')
const {
  evolutionConfigJournalPath,
  reconcileEvolutionConfigJournal,
} = await import('../server/services/evolutionConfigJournalService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
const configPath = path.join(tempDir, 'runtime.json')
const runtimeOptions = { cwd: tempDir, env: { APP_DATA_DIR: tempDir }, hostEnv: {} }
let sequence = 0

function seedCandidate(userId, {
  patch = { schemaVersion: 1, mode: 'patch', env: { MODEL_TEMPERATURE: '0.2' } },
  permissionsRequested = [],
} = {}) {
  sequence += 1
  const id = `config-candidate-${sequence}`
  const content = canonicalEvolutionConfigPatch(patch)
  getDb().prepare(`
    INSERT INTO evolution_candidates (
      id, user_id, kind, target, title, summary, content,
      assumptions_json, expected_impact_json, permissions_requested_json,
      dataset_fingerprint, curation_version, source_record_ids_json, source_evidence_ids_json,
      generator_model, generator_mode, content_sha256, created_at
    ) VALUES (?, ?, 'config', 'config:runtime', 'Runtime config', 'Bounded config patch', ?,
      '[]', '[]', ?, ?, 'curation-v1', '[]', '[]',
      'generator-model', 'background_model_no_tools', ?, ?)
  `).run(
    id,
    userId,
    content,
    JSON.stringify(permissionsRequested),
    configSha256(`dataset-${sequence}`),
    configSha256(content),
    sequence,
  )
  return id
}

function writeBaseline(temperature = '0.7') {
  fs.writeFileSync(configPath, `${JSON.stringify({
    env: { MODEL_TEMPERATURE: temperature },
    onboarding: { completedAt: 123 },
  }, null, 2)}\n`, 'utf8')
  return fs.readFileSync(configPath, 'utf8')
}

function approveCandidate(userId, candidateId) {
  const replay = runEvolutionConfigReplay({ userId, candidateId, ...runtimeOptions })
  const evaluation = evaluateEvolutionConfigReplay({ userId, replayId: replay.id })
  const review = buildEvolutionConfigApprovalReview({ userId, evaluationId: evaluation.id })
  const approval = decideEvolutionConfigApproval({
    userId,
    evaluationId: evaluation.id,
    decision: 'approved',
    reason: 'Reviewed deterministic config report',
    confirmations: review.confirmations,
  })
  return { replay, evaluation, review, approval }
}

function crashAt(expectedStage) {
  return (stage) => {
    if (stage === expectedStage) {
      throw Object.assign(new Error(`simulated crash at ${stage}`), { code: 'SIMULATED_CRASH' })
    }
  }
}

function prepareApprovedChange(owner, temperature = '0.7') {
  const baseline = writeBaseline(temperature)
  const candidateId = seedCandidate(owner.userId)
  const { approval } = approveCandidate(owner.userId, candidateId)
  const review = buildEvolutionConfigApplyReview({
    userId: owner.userId,
    approvalId: approval.id,
    ...runtimeOptions,
  })
  return { baseline, approval, review }
}

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('config candidate policy canonicalizes safe values and rejects secrets, capabilities, and prototype pollution', () => {
  assert.equal(
    canonicalEvolutionConfigPatch({
      mode: 'patch',
      env: { MODEL_TEMPERATURE: 0.2, AGENT_INJECT_ENABLED: false },
      schemaVersion: 1,
    }),
    '{"env":{"AGENT_INJECT_ENABLED":"0","MODEL_TEMPERATURE":"0.2"},"mode":"patch","schemaVersion":1}',
  )
  assert.throws(
    () => normalizeEvolutionConfigPatch({
      schemaVersion: 1,
      mode: 'patch',
      env: { MODEL_API_KEY: 'secret' },
    }),
    { code: 'EVOLUTION_CONFIG_KEY_NOT_ALLOWED' },
  )
  assert.throws(
    () => normalizeEvolutionConfigPatch({
      schemaVersion: 1,
      mode: 'patch',
      env: { WORKSPACE_SHELL_ENABLED: '1' },
    }),
    { code: 'EVOLUTION_CONFIG_KEY_NOT_ALLOWED' },
  )
  assert.throws(
    () => normalizeEvolutionConfigPatch({
      schemaVersion: 1,
      mode: 'patch',
      env: { JOB_MAX_COST_USD: '1' },
    }),
    (error) => {
      assert.equal(error.code, 'EVOLUTION_CONFIG_KEY_NOT_ALLOWED')
      assert.match(error.message, /JOB_MAX_COST_USD/u)
      return true
    },
  )
  assert.throws(
    () => normalizeEvolutionConfigPatch(
      '{"schemaVersion":1,"mode":"patch","env":{"MODEL_TEMPERATURE":"0.2"},"__proto__":{}}',
    ),
    { code: 'EVOLUTION_CONFIG_FORBIDDEN_KEY' },
  )
})

test('config replay is deterministic and read-only, then independent evaluation passes', () => {
  const owner = issueTestSession({ email: 'config-replay-owner@example.com' })
  const baseline = writeBaseline()
  const candidateId = seedCandidate(owner.userId)
  const first = runEvolutionConfigReplay({ userId: owner.userId, candidateId, ...runtimeOptions, now: 10 })
  const second = runEvolutionConfigReplay({ userId: owner.userId, candidateId, ...runtimeOptions, now: 11 })
  assert.equal(first.runFingerprint, second.runFingerprint)
  assert.equal(first.report.policyVersion, 'runtime-config-policy-v2')
  assert.equal(first.isolationMode, 'config_parse_no_side_effects')
  assert.deepEqual(first.report.sideEffects, { fileWrites: 0, pluginCalls: 0, modelCalls: 0 })
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  const evaluation = evaluateEvolutionConfigReplay({ userId: owner.userId, replayId: first.id, now: 12 })
  assert.equal(evaluation.verdict, 'pass')
  assert.equal(evaluation.evaluator.independent, true)
})

test('config replay rejects the retired dollar-gate key without applying any part of the patch', () => {
  const owner = issueTestSession({ email: 'config-retired-dollar-gate-owner@example.com' })
  const baseline = writeBaseline()
  const candidateId = seedCandidate(owner.userId)
  const storedContent = JSON.stringify({
    schemaVersion: 1,
    mode: 'patch',
    env: { MODEL_TEMPERATURE: '0.2', JOB_MAX_COST_USD: '1' },
  })
  getDb().prepare(`
    UPDATE evolution_candidates
    SET content = ?, content_sha256 = ?
    WHERE id = ? AND user_id = ?
  `).run(storedContent, configSha256(storedContent), candidateId, owner.userId)

  assert.throws(
    () => runEvolutionConfigReplay({ userId: owner.userId, candidateId, ...runtimeOptions }),
    { code: 'EVOLUTION_CONFIG_KEY_NOT_ALLOWED' },
  )
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_replays WHERE candidate_id = ?
  `).get(candidateId).count, 0)
})

test('config replay preserves an inert retired key as user data while evolving an allowed key', () => {
  const owner = issueTestSession({ email: 'config-inert-retired-key-owner@example.com' })
  fs.writeFileSync(configPath, `${JSON.stringify({
    env: { MODEL_TEMPERATURE: '0.7', JOB_MAX_COST_USD: '0.05' },
    onboarding: { completedAt: 123 },
  }, null, 2)}\n`, 'utf8')
  const baseline = fs.readFileSync(configPath, 'utf8')
  const candidateId = seedCandidate(owner.userId)

  const replay = runEvolutionConfigReplay({
    userId: owner.userId,
    candidateId,
    ...runtimeOptions,
  })
  const proposed = JSON.parse(getDb().prepare(`
    SELECT proposed_document_json FROM evolution_config_replays WHERE id = ?
  `).get(replay.id).proposed_document_json)

  assert.deepEqual(replay.report.touchedKeys, ['MODEL_TEMPERATURE'])
  assert.equal(proposed.env.MODEL_TEMPERATURE, '0.2')
  assert.equal(proposed.env.JOB_MAX_COST_USD, '0.05')
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
})

test('a stored approval cannot bypass the current policy to apply a retired dollar-gate patch', () => {
  const owner = issueTestSession({ email: 'config-stored-retired-gate-owner@example.com' })
  const baseline = writeBaseline()
  const candidateId = seedCandidate(owner.userId)
  const { approval } = approveCandidate(owner.userId, candidateId)
  const storedContent = JSON.stringify({
    schemaVersion: 1,
    mode: 'patch',
    env: { JOB_MAX_COST_USD: '1' },
  })
  const storedSha256 = configSha256(storedContent)
  getDb().transaction(() => {
    getDb().prepare(`
      UPDATE evolution_candidates SET content = ?, content_sha256 = ?
      WHERE id = ? AND user_id = ?
    `).run(storedContent, storedSha256, candidateId, owner.userId)
    getDb().prepare(`
      UPDATE evolution_config_approval_decisions SET candidate_sha256 = ?
      WHERE id = ? AND user_id = ?
    `).run(storedSha256, approval.id, owner.userId)
  })()

  assert.throws(() => applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Must be rejected by the current policy',
    confirmationSha256: '0'.repeat(64),
    ...runtimeOptions,
    activate() {},
  }), { code: 'EVOLUTION_CONFIG_KEY_NOT_ALLOWED' })
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 0)
})

test('permission requests and higher-layer locks fail closed for config evaluation and approval', () => {
  const owner = issueTestSession({ email: 'config-policy-owner@example.com' })
  writeBaseline()
  const permissioned = seedCandidate(owner.userId, { permissionsRequested: ['tool:write_file'] })
  const permissionReplay = runEvolutionConfigReplay({
    userId: owner.userId,
    candidateId: permissioned,
    ...runtimeOptions,
  })
  const permissionEvaluation = evaluateEvolutionConfigReplay({
    userId: owner.userId,
    replayId: permissionReplay.id,
  })
  assert.equal(permissionEvaluation.verdict, 'fail')
  const permissionReview = buildEvolutionConfigApprovalReview({
    userId: owner.userId,
    evaluationId: permissionEvaluation.id,
  })
  assert.equal(permissionReview.eligibility.canApprove, false)
  assert.throws(() => decideEvolutionConfigApproval({
    userId: owner.userId,
    evaluationId: permissionEvaluation.id,
    decision: 'approved',
    reason: 'should fail',
    confirmations: permissionReview.confirmations,
  }), { code: 'EVOLUTION_APPROVAL_PERMISSION_CHANGE_UNSUPPORTED' })

  const locked = seedCandidate(owner.userId)
  const lockedReplay = runEvolutionConfigReplay({
    userId: owner.userId,
    candidateId: locked,
    ...runtimeOptions,
    hostEnv: { MODEL_TEMPERATURE: '1' },
  })
  assert.deepEqual(lockedReplay.report.locked, [{ key: 'MODEL_TEMPERATURE', source: 'environment' }])
  assert.equal(evaluateEvolutionConfigReplay({
    userId: owner.userId,
    replayId: lockedReplay.id,
  }).verdict, 'fail')
})

test('config apply requires exact second confirmation and rollback uses CAS without overwriting manual edits', () => {
  const owner = issueTestSession({ email: 'config-apply-owner@example.com' })
  const baseline = writeBaseline()
  const candidateId = seedCandidate(owner.userId)
  const { approval } = approveCandidate(owner.userId, candidateId)
  const applyReview = buildEvolutionConfigApplyReview({
    userId: owner.userId,
    approvalId: approval.id,
    ...runtimeOptions,
  })
  assert.equal(applyReview.eligibility.canApply, true)
  assert.throws(() => applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Apply reviewed config',
    confirmationSha256: '0'.repeat(64),
    ...runtimeOptions,
    activate() {},
  }), { code: 'EVOLUTION_CONFIG_CONFIRMATION_MISMATCH' })
  const apply = applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Apply reviewed config',
    confirmationSha256: applyReview.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
  })
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).env.MODEL_TEMPERATURE, '0.2')
  assert.equal(apply.state, 'active')

  fs.writeFileSync(configPath, `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.3' } }, null, 2)}\n`)
  assert.throws(() => reverseEvolutionConfigChange({
    userId: owner.userId,
    applyId: apply.id,
    operation: 'rollback',
    reason: 'Rollback after review',
    confirmationSha256: apply.rollbackConfirmationSha256,
    ...runtimeOptions,
    activate() {},
  }), { code: 'EVOLUTION_CONFIG_CAS_MISMATCH' })
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).env.MODEL_TEMPERATURE, '0.3')

  fs.writeFileSync(configPath, apply.reviewSnapshot || getDb().prepare(
    'SELECT after_document_json FROM evolution_config_change_events WHERE id = ?',
  ).get(apply.id).after_document_json)
  const rollback = reverseEvolutionConfigChange({
    userId: owner.userId,
    applyId: apply.id,
    operation: 'rollback',
    reason: 'Rollback after review',
    confirmationSha256: apply.rollbackConfirmationSha256,
    ...runtimeOptions,
    activate() {},
  })
  assert.equal(rollback.operation, 'rollback')
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(getEvolutionConfigChange({ userId: owner.userId, id: apply.id }).state, 'reversed')
})

test('config revoke restores the exact reviewed baseline bytes without canonicalizing user formatting', () => {
  const owner = issueTestSession({ email: 'config-byte-exact-revoke@example.com' })
  const baseline = '{  "onboarding" : { "completedAt" : 123 },\r\n"env" : { "MODEL_TEMPERATURE" : "0.7", "AGENT_INJECT_ENABLED" : "0" } }'
  fs.writeFileSync(configPath, baseline, 'utf8')
  const candidateId = seedCandidate(owner.userId)
  const { approval } = approveCandidate(owner.userId, candidateId)
  const review = buildEvolutionConfigApplyReview({
    userId: owner.userId,
    approvalId: approval.id,
    ...runtimeOptions,
  })
  const apply = applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Apply before exact-byte revoke',
    confirmationSha256: review.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
  })
  assert.notEqual(fs.readFileSync(configPath, 'utf8'), baseline)

  const revoke = reverseEvolutionConfigChange({
    userId: owner.userId,
    applyId: apply.id,
    operation: 'revoke',
    reason: 'Restore the exact reviewed baseline bytes',
    confirmationSha256: apply.revokeConfirmationSha256,
    ...runtimeOptions,
    activate() {},
  })
  assert.equal(revoke.operation, 'revoke')
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(getDb().prepare(`
    SELECT before_document_json FROM evolution_config_change_events WHERE id = ?
  `).get(apply.id).before_document_json, baseline)
  assert.equal(getDb().prepare(`
    SELECT after_document_json FROM evolution_config_change_events WHERE id = ?
  `).get(revoke.id).after_document_json, baseline)
})

test('activation failure restores the previous runtime config and leaves no apply audit', () => {
  const owner = issueTestSession({ email: 'config-activation-owner@example.com' })
  const baseline = writeBaseline('0.8')
  const candidateId = seedCandidate(owner.userId)
  const { approval } = approveCandidate(owner.userId, candidateId)
  const review = buildEvolutionConfigApplyReview({
    userId: owner.userId,
    approvalId: approval.id,
    ...runtimeOptions,
  })
  assert.throws(() => applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Activation must fail',
    confirmationSha256: review.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() { throw new Error('reload failed') },
  }), /reload failed/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 0)
})

test('config publish preserves an external edit made after expected-sha validation', () => {
  const baseline = writeBaseline('0.81')
  const proposed = `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.2' } }, null, 2)}\n`
  const external = `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.91' } }, null, 2)}\n`

  assert.throws(() => atomicWriteEvolutionRuntimeConfig({
    filePath: configPath,
    content: proposed,
    expectedSha256: configSha256(baseline),
    hooks: {
      afterExpectedShaVerified() {
        fs.writeFileSync(configPath, external, 'utf8')
      },
    },
    activate() {},
  }), { code: 'EVOLUTION_CONFIG_CAS_MISMATCH' })

  assert.equal(fs.readFileSync(configPath, 'utf8'), external)
  assert.equal(fs.existsSync(`${configPath}.evolution.lock`), false)
})

test('activation failure refuses to restore over a newer external config', () => {
  const baseline = writeBaseline('0.82')
  const proposed = `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.2' } }, null, 2)}\n`
  const external = `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.92' } }, null, 2)}\n`
  let conflict

  assert.throws(() => atomicWriteEvolutionRuntimeConfig({
    filePath: configPath,
    content: proposed,
    expectedSha256: configSha256(baseline),
    activate() {
      fs.writeFileSync(configPath, external, 'utf8')
      throw new Error('reload failed after external edit')
    },
  }), (error) => {
    conflict = error
    assert.equal(error.code, 'EVOLUTION_CONFIG_RESTORE_CONFLICT')
    assert.equal(error.restoreConflict, true)
    assert.match(error.cause?.message || '', /reload failed after external edit/u)
    return true
  })

  assert.equal(fs.readFileSync(configPath, 'utf8'), external)
  assert.equal(fs.readFileSync(conflict.recoveryPath, 'utf8'), baseline)
  assert.equal(fs.existsSync(`${configPath}.evolution.lock`), false)
  fs.unlinkSync(conflict.recoveryPath)
})

test('rollback CAS preserves both external generations when the target changes after validation', () => {
  const baseline = writeBaseline('0.84')
  const proposed = `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.2' } }, null, 2)}\n`
  const firstExternal = `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.93' } }, null, 2)}\n`
  const secondExternal = `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.94' } }, null, 2)}\n`
  let conflict

  assert.throws(() => atomicWriteEvolutionRuntimeConfig({
    filePath: configPath,
    content: proposed,
    expectedSha256: configSha256(baseline),
    activate() { throw new Error('reload failed before rollback race') },
    hooks: {
      afterRollbackShaVerified() {
        fs.writeFileSync(configPath, firstExternal, 'utf8')
      },
      afterRollbackTargetClaimed() {
        fs.writeFileSync(configPath, secondExternal, 'utf8')
      },
    },
  }), (error) => {
    conflict = error
    assert.equal(error.code, 'EVOLUTION_CONFIG_RESTORE_CONFLICT')
    assert.equal(error.restoreConflict, true)
    assert.ok(error.recoveryPath)
    assert.ok(error.displacedRecoveryPath)
    return true
  })

  assert.equal(fs.readFileSync(configPath, 'utf8'), secondExternal)
  assert.equal(fs.readFileSync(conflict.displacedRecoveryPath, 'utf8'), firstExternal)
  assert.equal(fs.readFileSync(conflict.recoveryPath, 'utf8'), baseline)
  fs.unlinkSync(conflict.displacedRecoveryPath)
  fs.unlinkSync(conflict.recoveryPath)
})

test('runtime config filesystem lock excludes a second publishing process', () => {
  const baseline = writeBaseline('0.83')
  const lockPath = `${configPath}.evolution.lock`
  fs.mkdirSync(lockPath)
  try {
    assert.throws(() => atomicWriteEvolutionRuntimeConfig({
      filePath: configPath,
      content: `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.2' } }, null, 2)}\n`,
      expectedSha256: configSha256(baseline),
      activate() {},
    }), { code: 'EVOLUTION_CONFIG_LOCKED' })
    assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  } finally {
    fs.rmdirSync(lockPath)
  }
})

test('pending journal aborts an apply that crashed before replacing runtime config', () => {
  const owner = issueTestSession({ email: 'config-crash-before-write@example.com' })
  const { baseline, approval, review } = prepareApprovedChange(owner, '0.61')
  const journalPath = evolutionConfigJournalPath(runtimeOptions)
  assert.throws(() => applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Crash before config replacement',
    confirmationSha256: review.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
    crashInjector: crashAt('after_journal_persisted'),
  }), { code: 'SIMULATED_CRASH' })
  assert.equal(fs.existsSync(journalPath), true)
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 0)

  const recovered = reconcileEvolutionConfigJournal({
    userId: owner.userId,
    ...runtimeOptions,
    activate() {},
  })
  assert.equal(recovered.status, 'aborted')
  assert.equal(fs.existsSync(journalPath), false)
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
})

test('pending journal finalization preserves a replacement created before its atomic claim', () => {
  const owner = issueTestSession({ email: 'config-journal-aba@example.com' })
  const { baseline, approval, review } = prepareApprovedChange(owner, '0.615')
  const journalPath = evolutionConfigJournalPath(runtimeOptions)
  assert.throws(() => applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Crash before journal ABA replacement',
    confirmationSha256: review.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
    crashInjector: crashAt('after_journal_persisted'),
  }), { code: 'SIMULATED_CRASH' })

  const pending = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  const replacementPayload = {
    schemaVersion: pending.schemaVersion,
    state: pending.state,
    journalId: `replacement-${pending.journalId}`,
    targetPath: pending.targetPath,
    reviewFingerprint: pending.reviewFingerprint,
    event: pending.event,
  }
  const replacement = {
    ...replacementPayload,
    journalFingerprint: configSha256(replacementPayload),
  }
  const originalRenameSync = fs.renameSync
  let replacedBeforeClaim = false
  fs.renameSync = function replaceBeforeJournalClaim(sourcePath, destinationPath) {
    if (!replacedBeforeClaim
      && path.resolve(sourcePath) === path.resolve(journalPath)
      && String(destinationPath).endsWith('.clearing')) {
      replacedBeforeClaim = true
      fs.writeFileSync(journalPath, `${JSON.stringify(replacement, null, 2)}\n`, 'utf8')
    }
    return originalRenameSync.call(fs, sourcePath, destinationPath)
  }
  try {
    assert.throws(() => reconcileEvolutionConfigJournal({
      userId: owner.userId,
      ...runtimeOptions,
      activate() {},
    }), { code: 'EVOLUTION_CONFIG_JOURNAL_CONFLICT' })
  } finally {
    fs.renameSync = originalRenameSync
  }

  assert.equal(replacedBeforeClaim, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(journalPath, 'utf8')), replacement)
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 0)
  fs.unlinkSync(journalPath)
})

test('pending journal recovers one apply audit after file replacement and remains owner-isolated and idempotent', () => {
  const owner = issueTestSession({ email: 'config-crash-after-write@example.com' })
  const other = issueTestSession({ email: 'config-crash-other-owner@example.com' })
  const { approval, review } = prepareApprovedChange(owner, '0.62')
  const journalPath = evolutionConfigJournalPath(runtimeOptions)
  assert.throws(() => applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Crash after config replacement',
    confirmationSha256: review.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
    crashInjector: crashAt('after_config_replaced'),
  }), { code: 'SIMULATED_CRASH' })
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).env.MODEL_TEMPERATURE, '0.2')
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 0)
  assert.throws(() => reconcileEvolutionConfigJournal({
    userId: other.userId,
    ...runtimeOptions,
    activate() {},
  }), { code: 'EVOLUTION_CONFIG_JOURNAL_OWNER_MISMATCH' })
  assert.equal(fs.existsSync(journalPath), true)

  const recovered = reconcileEvolutionConfigJournal({
    userId: owner.userId,
    ...runtimeOptions,
    activate() {},
  })
  assert.equal(recovered.status, 'recovered')
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 1)
  assert.equal(fs.existsSync(journalPath), false)
  assert.equal(reconcileEvolutionConfigJournal({
    userId: owner.userId,
    ...runtimeOptions,
    activate() {},
  }).status, 'none')
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 1)
})

test('pending journal cleans up without duplicating an audit committed before a crash', () => {
  const owner = issueTestSession({ email: 'config-crash-after-audit@example.com' })
  const { approval, review } = prepareApprovedChange(owner, '0.63')
  const journalPath = evolutionConfigJournalPath(runtimeOptions)
  assert.throws(() => applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Crash after audit commit',
    confirmationSha256: review.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
    crashInjector: crashAt('after_audit_committed'),
  }), { code: 'SIMULATED_CRASH' })
  assert.equal(fs.existsSync(journalPath), true)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 1)

  const recovered = reconcileEvolutionConfigJournal({
    userId: owner.userId,
    ...runtimeOptions,
    activate() {},
  })
  assert.equal(recovered.status, 'committed')
  assert.equal(fs.existsSync(journalPath), false)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 1)
})

test('pending journal fails closed on external runtime edits without overwriting them', () => {
  const owner = issueTestSession({ email: 'config-crash-external-edit@example.com' })
  const { baseline, approval, review } = prepareApprovedChange(owner, '0.64')
  const journalPath = evolutionConfigJournalPath(runtimeOptions)
  assert.throws(() => applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Crash before external edit',
    confirmationSha256: review.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
    crashInjector: crashAt('after_config_replaced'),
  }), { code: 'SIMULATED_CRASH' })
  const external = `${JSON.stringify({ env: { MODEL_TEMPERATURE: '0.99' } }, null, 2)}\n`
  fs.writeFileSync(configPath, external, 'utf8')
  assert.throws(() => reconcileEvolutionConfigJournal({
    userId: owner.userId,
    ...runtimeOptions,
    activate() {},
  }), { code: 'EVOLUTION_CONFIG_JOURNAL_CONFLICT' })
  assert.equal(fs.readFileSync(configPath, 'utf8'), external)
  assert.equal(fs.existsSync(journalPath), true)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 0)

  fs.writeFileSync(configPath, baseline, 'utf8')
  assert.equal(reconcileEvolutionConfigJournal({
    userId: owner.userId,
    ...runtimeOptions,
    activate() {},
  }).status, 'aborted')
})

test('damaged pending journal blocks recovery and preserves the runtime file', () => {
  const owner = issueTestSession({ email: 'config-crash-damaged-journal@example.com' })
  const { baseline, approval, review } = prepareApprovedChange(owner, '0.65')
  const journalPath = evolutionConfigJournalPath(runtimeOptions)
  assert.throws(() => applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Crash before journal corruption',
    confirmationSha256: review.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
    crashInjector: crashAt('after_journal_persisted'),
  }), { code: 'SIMULATED_CRASH' })
  fs.writeFileSync(journalPath, '{"schemaVersion":1', 'utf8')
  assert.throws(() => reconcileEvolutionConfigJournal({
    userId: owner.userId,
    ...runtimeOptions,
    activate() {},
  }), { code: 'EVOLUTION_CONFIG_JOURNAL_INVALID' })
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(getDb().prepare(`
    SELECT COUNT(*) AS count FROM evolution_config_change_events WHERE approval_id = ?
  `).get(approval.id).count, 0)
  assert.equal(fs.existsSync(journalPath), true)
  fs.unlinkSync(journalPath)
})

test('rollback uses the same pending journal recovery protocol', () => {
  const owner = issueTestSession({ email: 'config-rollback-crash@example.com' })
  const { baseline, approval, review } = prepareApprovedChange(owner, '0.66')
  const apply = applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Apply before rollback crash',
    confirmationSha256: review.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
  })
  assert.throws(() => reverseEvolutionConfigChange({
    userId: owner.userId,
    applyId: apply.id,
    operation: 'rollback',
    reason: 'Crash after rollback file replacement',
    confirmationSha256: apply.rollbackConfirmationSha256,
    ...runtimeOptions,
    activate() {},
    crashInjector: crashAt('after_config_replaced'),
  }), { code: 'SIMULATED_CRASH' })
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(getEvolutionConfigChange({ userId: owner.userId, id: apply.id }).state, 'active')
  assert.equal(reconcileEvolutionConfigJournal({
    userId: owner.userId,
    ...runtimeOptions,
    activate() {},
  }).status, 'recovered')
  assert.equal(getEvolutionConfigChange({ userId: owner.userId, id: apply.id }).state, 'reversed')
})

test('config routes require authentication and the local owner boundary', async () => {
  const remote = issueTestSession({ email: 'config-remote-user@example.com' })
  const server = http.createServer((req, res) => handleEvolutionRequest(req, res, {
    cwd: tempDir,
    env: { AUTH_MODE: 'multi_user', APP_DATA_DIR: tempDir },
    hostEnv: {},
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const unauthorized = await fetch(`${origin}/api/evolution/config-replays`, { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    const forbidden = await fetch(`${origin}/api/evolution/config-replays`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${remote.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ candidateId: 'none' }),
    })
    assert.equal(forbidden.status, 403)
    assert.equal((await forbidden.json()).error.code, 'LOCAL_OWNER_ONLY')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
