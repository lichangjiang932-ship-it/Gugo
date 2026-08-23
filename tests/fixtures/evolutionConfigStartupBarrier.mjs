import fs from 'node:fs'
import path from 'node:path'

const mode = String(process.argv[2] || '').trim()
const dataDir = path.resolve(String(process.env.APP_DATA_DIR || ''))
const dbPath = path.resolve(String(process.env.APP_DB_PATH || ''))

if (!mode || !process.env.APP_DATA_DIR || !process.env.APP_DB_PATH) {
  throw new Error('mode, APP_DATA_DIR, and APP_DB_PATH are required')
}

fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, '.env'), '', { encoding: 'utf8', flag: 'a' })

async function prepareInterruptedApply() {
  const { getDb } = await import('../../server/db.js')
  const { issueTestSession } = await import('../helpers/testAuth.js')
  const {
    applyEvolutionConfigCandidate,
    buildEvolutionConfigApplyReview,
    buildEvolutionConfigApprovalReview,
    decideEvolutionConfigApproval,
  } = await import('../../server/services/evolutionConfigChangeService.js')
  const {
    canonicalEvolutionConfigPatch,
    configSha256,
  } = await import('../../server/services/evolutionConfigPolicy.js')
  const {
    evaluateEvolutionConfigReplay,
    runEvolutionConfigReplay,
  } = await import('../../server/services/evolutionConfigReplayService.js')
  const { evolutionConfigJournalPath } = await import(
    '../../server/services/evolutionConfigJournalService.js'
  )

  const configPath = path.join(dataDir, 'runtime.json')
  fs.writeFileSync(configPath, `${JSON.stringify({
    env: { MODEL_TEMPERATURE: '0.7' },
  }, null, 2)}\n`, 'utf8')

  const owner = issueTestSession({ email: 'startup-config-journal-owner@example.com' })
  const content = canonicalEvolutionConfigPatch({
    schemaVersion: 1,
    mode: 'patch',
    env: { MODEL_TEMPERATURE: '0.2' },
  })
  const candidateId = 'startup-config-journal-candidate'
  getDb().prepare(`
    INSERT INTO evolution_candidates (
      id, user_id, kind, target, title, summary, content,
      assumptions_json, expected_impact_json, permissions_requested_json,
      dataset_fingerprint, curation_version, source_record_ids_json, source_evidence_ids_json,
      generator_model, generator_mode, content_sha256, created_at
    ) VALUES (?, ?, 'config', 'config:runtime', 'Runtime config', 'Startup recovery fixture', ?,
      '[]', '[]', '[]', ?, 'curation-v1', '[]', '[]',
      'fixture-model', 'background_model_no_tools', ?, ?)
  `).run(
    candidateId,
    owner.userId,
    content,
    configSha256('startup-config-journal-dataset'),
    configSha256(content),
    Date.now(),
  )

  const runtimeOptions = {
    cwd: dataDir,
    env: { APP_DATA_DIR: dataDir },
    hostEnv: {},
  }
  const replay = runEvolutionConfigReplay({
    userId: owner.userId,
    candidateId,
    ...runtimeOptions,
  })
  const evaluation = evaluateEvolutionConfigReplay({
    userId: owner.userId,
    replayId: replay.id,
  })
  const approvalReview = buildEvolutionConfigApprovalReview({
    userId: owner.userId,
    evaluationId: evaluation.id,
  })
  const approval = decideEvolutionConfigApproval({
    userId: owner.userId,
    evaluationId: evaluation.id,
    decision: 'approved',
    reason: 'Prepare a real startup recovery fixture',
    confirmations: approvalReview.confirmations,
  })
  const applyReview = buildEvolutionConfigApplyReview({
    userId: owner.userId,
    approvalId: approval.id,
    ...runtimeOptions,
  })

  applyEvolutionConfigCandidate({
    userId: owner.userId,
    approvalId: approval.id,
    reason: 'Interrupt after replacing runtime config',
    confirmationSha256: applyReview.confirmations.applyConfirmationSha256,
    ...runtimeOptions,
    activate() {},
    crashInjector(stage) {
      if (stage === 'after_config_replaced') process.exit(86)
    },
  })

  // The process must never return from the apply call above.
  const journalPath = evolutionConfigJournalPath({
    cwd: dataDir,
    env: { APP_DATA_DIR: dataDir },
  })
  throw new Error(`fixture failed to crash with journal ${journalPath}`)
}

async function startAndInspectRuntime() {
  const { startAppServer } = await import('../../server/appServer.js')
  const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import(
    '../../server/adapters/sqliteTurnPersistenceAdapter.js'
  )
  const { createSqliteSubagentRunPersistenceAdapter } = await import(
    '../../server/adapters/sqliteSubagentRunPersistenceAdapter.js'
  )
  const { getDb } = await import('../../server/db.js')
  const { gracefulShutdown } = await import('../../server/core/lifecycle.js')
  const { runRuntimeConfigStartupPreflight } = await import(
    '../../server/services/runtimeConfigStartupService.js'
  )
  const { evolutionConfigJournalPath } = await import(
    '../../server/services/evolutionConfigJournalService.js'
  )

  const journalPath = evolutionConfigJournalPath({ cwd: dataDir, env: process.env })
  const server = startAppServer({
    cwd: dataDir,
    turnPersistenceAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
    subagentRunPersistenceAdapter: createSqliteSubagentRunPersistenceAdapter({ getDb }),
  })
  if (!server) throw new Error('app server did not start')
  const repeatedPreflight = runRuntimeConfigStartupPreflight({ cwd: dataDir })

  const synchronousBarrier = {
    auditCount: Number(getDb().prepare(`
      SELECT COUNT(*) AS count FROM evolution_config_change_events
    `).get().count),
    journalExists: fs.existsSync(journalPath),
    repeatedRecoveryStatus: repeatedPreflight.recovery.status,
    runtimeTemperature: process.env.MODEL_TEMPERATURE || null,
    runtimeState: server.runtimeReadiness.getState(),
  }

  const startup = await Promise.race([
    server.startupReady,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('runtime startup timed out')), 30_000)
      timer.unref?.()
    }),
  ])
  const readyState = {
    auditCount: Number(getDb().prepare(`
      SELECT COUNT(*) AS count FROM evolution_config_change_events
    `).get().count),
    journalExists: fs.existsSync(journalPath),
    runtimeState: server.runtimeReadiness.getState(),
    startupFailures: startup.failures.length,
  }
  process.stdout.write(`EVOLUTION_CONFIG_STARTUP_RESULT ${JSON.stringify({
    dbPath,
    synchronousBarrier,
    readyState,
  })}\n`)
  const exitCode = await gracefulShutdown(server, {
    exit: false,
    silent: true,
    timeoutMs: 15_000,
  })
  process.exit(exitCode)
}

async function runEmptyStartupPreflight() {
  const { runRuntimeConfigStartupPreflight } = await import(
    '../../server/services/runtimeConfigStartupService.js'
  )

  const beforeDbExists = fs.existsSync(dbPath)
  const result = runRuntimeConfigStartupPreflight({ cwd: dataDir })
  process.stdout.write(`EVOLUTION_CONFIG_PREFLIGHT_RESULT ${JSON.stringify({
    beforeDbExists,
    afterDbExists: fs.existsSync(dbPath),
    recoveryStatus: result.recovery.status,
  })}\n`)
}

if (mode === 'prepare') await prepareInterruptedApply()
else if (mode === 'start') await startAndInspectRuntime()
else if (mode === 'preflight-empty') await runEmptyStartupPreflight()
else throw new Error(`unsupported mode: ${mode}`)
