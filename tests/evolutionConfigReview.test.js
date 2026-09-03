import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-config-review-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
fs.writeFileSync(path.join(tempDir, '.env'), '', 'utf8')

const { closeDb, getDb } = await import('../server/db.js')
const { handleEvolutionRequest } = await import('../server/routes/evolutionRoutes.js')
const {
  canonicalEvolutionConfigPatch,
  configSha256,
} = await import('../server/services/evolutionConfigPolicy.js')
const {
  reviewEvolutionConfigCandidate,
} = await import('../server/services/evolutionConfigReviewService.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
const configPath = path.join(tempDir, 'runtime.json')
const runtimeOptions = { cwd: tempDir, env: { APP_DATA_DIR: tempDir }, hostEnv: {} }
let sequence = 0

function seedCandidate(userId, { permissionsRequested = [] } = {}) {
  sequence += 1
  const id = `automatic-config-review-${sequence}`
  const content = canonicalEvolutionConfigPatch({
    schemaVersion: 1,
    mode: 'patch',
    env: { MODEL_TEMPERATURE: '0.2' },
  })
  getDb().prepare(`
    INSERT INTO evolution_candidates (
      id, user_id, kind, target, title, summary, content,
      assumptions_json, expected_impact_json, permissions_requested_json,
      dataset_fingerprint, curation_version, source_record_ids_json, source_evidence_ids_json,
      generator_model, generator_mode, content_sha256, created_at
    ) VALUES (?, ?, 'config', 'config:runtime', 'Runtime config review',
      'Automatically audit a bounded runtime config patch', ?, '[]', '[]', ?, ?,
      'curation-v1', '[]', '[]', 'generator-model', 'background_model_no_tools', ?, ?)
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

function writeBaseline(value = '0.7') {
  fs.writeFileSync(configPath, `${JSON.stringify({ env: { MODEL_TEMPERATURE: value } }, null, 2)}\n`)
  return fs.readFileSync(configPath, 'utf8')
}

function count(table, candidateId) {
  return getDb().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE candidate_id = ?`)
    .get(candidateId).count
}

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('automatic runtime config review stops at explicit approval without applying or canarying', () => {
  const owner = issueTestSession({ email: 'automatic-config-review@example.com' })
  const baseline = writeBaseline()
  const candidateId = seedCandidate(owner.userId)
  const result = reviewEvolutionConfigCandidate({
    userId: owner.userId,
    candidateId,
    ...runtimeOptions,
    now: 100,
  })

  assert.equal(result.mode, 'automatic_deterministic_audit')
  assert.equal(result.state, 'awaiting_explicit_approval')
  assert.equal(result.nextAction, 'request_explicit_approval')
  assert.equal(result.evaluation.verdict, 'pass')
  assert.equal(result.approvalReview.eligibility.canApprove, true)
  assert.deepEqual(result.replay.report.sideEffects, {
    fileWrites: 0,
    pluginCalls: 0,
    modelCalls: 0,
  })
  assert.deepEqual(result.controls, {
    approvalRequired: true,
    applyConfirmationRequired: true,
    automaticApproval: false,
    automaticApply: false,
    permissionExpansionAllowed: false,
    canaryAllowed: false,
    rollbackAvailableAfterExplicitApply: true,
  })
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(count('evolution_config_replays', candidateId), 1)
  assert.equal(count('evolution_config_evaluations', candidateId), 1)
  assert.equal(count('evolution_config_approval_decisions', candidateId), 0)
  assert.equal(count('evolution_config_change_events', candidateId), 0)
  assert.equal(count('evolution_canary_releases', candidateId), 0)
})

test('automatic runtime config review keeps permission-expanding candidates ineligible', () => {
  const owner = issueTestSession({ email: 'automatic-config-review-permission@example.com' })
  const baseline = writeBaseline('0.8')
  const candidateId = seedCandidate(owner.userId, { permissionsRequested: ['tool:write_file'] })
  const result = reviewEvolutionConfigCandidate({
    userId: owner.userId,
    candidateId,
    ...runtimeOptions,
  })

  assert.equal(result.state, 'not_eligible')
  assert.equal(result.nextAction, 'revise_candidate')
  assert.equal(result.evaluation.verdict, 'fail')
  assert.equal(result.approvalReview.eligibility.canApprove, false)
  assert.ok(result.approvalReview.eligibility.issues.includes('permission_change_unsupported'))
  assert.equal(fs.readFileSync(configPath, 'utf8'), baseline)
  assert.equal(count('evolution_config_approval_decisions', candidateId), 0)
  assert.equal(count('evolution_config_change_events', candidateId), 0)
})

test('automatic config review API is no-store and restricted to the loopback local owner', async () => {
  const owner = issueTestSession({ email: 'automatic-config-review-route@example.com' })
  const other = issueTestSession({ email: 'automatic-config-review-other@example.com' })
  writeBaseline('0.9')
  const candidateId = seedCandidate(owner.userId)
  const routeEnv = {
    APP_DATA_DIR: tempDir,
    AUTH_MODE: 'local',
    LOCAL_USER_ID: owner.userId,
  }
  const server = http.createServer((req, res) => handleEvolutionRequest(req, res, {
    cwd: tempDir,
    env: routeEnv,
    hostEnv: {},
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    const forbidden = await fetch(`${origin}/api/evolution/config-reviews`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${other.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ candidateId }),
    })
    assert.equal(forbidden.status, 403)
    assert.equal((await forbidden.json()).error.code, 'LOCAL_OWNER_ONLY')

    const response = await fetch(`${origin}/api/evolution/config-reviews`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ candidateId }),
    })
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const review = (await response.json()).review
    assert.equal(review.state, 'awaiting_explicit_approval')
    assert.equal(review.controls.automaticApproval, false)
    assert.equal(review.controls.automaticApply, false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
