import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-evolution-auto-routes-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { closeDb, getDb } = await import('../server/db.js')
const { handleEvolutionRequest } = await import('../server/routes/evolutionRoutes.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

getDb()
const routeEnv = { AUTH_MODE: 'local', LOCAL_USER_ID: '' }
const server = http.createServer((req, res) => handleEvolutionRequest(req, res, { env: routeEnv }))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

function request(token, pathname, init = {}) {
  return fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
}

function seedConfig(userId, now) {
  getDb().prepare(`
    INSERT INTO evolution_auto_configs (
      user_id, enabled, target, objective,
      generator_provider_id, generator_model,
      replay_provider_id, replay_model,
      evaluator_provider_id, evaluator_model,
      session_ids_json, minimum_signal_count, maximum_source_records,
      cooldown_ms, traffic_percent, canary_max_outcomes, canary_max_age_ms,
      rollback_policy_json, config_revision, created_at, updated_at
    ) VALUES (?, 1, 'prompt:workspace-instructions', 'Improve verified failures.',
      'generator', 'model-a', 'replay', 'model-b', 'evaluator', 'model-c',
      '["session-1"]', 1, 10, 60000, 5, 20, 604800000,
      '{"windowSize":10}', 1, ?, ?)
  `).run(userId, now, now)
}

test('automatic evolution routes are registered, owner-scoped, and locally gated for writes', async (t) => {
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    closeDb()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
  const owner = issueTestSession({ email: 'evolution-auto-owner@example.com' })
  const other = issueTestSession({ email: 'evolution-auto-other@example.com' })
  routeEnv.LOCAL_USER_ID = owner.userId
  seedConfig(owner.userId, 10)
  getDb().prepare(`
    INSERT INTO evolution_auto_runs (
      id, user_id, config_revision, evidence_fingerprint, dataset_fingerprint,
      source_record_ids_json, source_evidence_ids_json, session_ids_json,
      signal_count, signal_cutoff_at, state, stage, created_at, updated_at
    ) VALUES ('run-owner', ?, 1, ?, ?, '[]', '["feedback:1"]', '["session-1"]',
      1, 10, 'stopped', 'test_seed', 10, 10)
  `).run(owner.userId, 'a'.repeat(64), 'b'.repeat(64))

  const ownerConfig = await request(owner.token, '/api/evolution/auto-config')
  assert.equal(ownerConfig.status, 200)
  assert.equal((await ownerConfig.json()).config.enabled, true)

  const otherConfig = await request(other.token, '/api/evolution/auto-config')
  assert.equal(otherConfig.status, 200)
  assert.equal((await otherConfig.json()).config, null)

  const ownerRuns = await request(owner.token, '/api/evolution/auto-runs?limit=20')
  assert.deepEqual((await ownerRuns.json()).runs.map((run) => run.id), ['run-owner'])
  const otherRuns = await request(other.token, '/api/evolution/auto-runs?limit=20')
  assert.deepEqual((await otherRuns.json()).runs, [])

  const forbidden = await request(other.token, '/api/evolution/auto-config', {
    method: 'PUT', body: JSON.stringify({ enabled: false }),
  })
  assert.equal(forbidden.status, 403)

  const disabled = await request(owner.token, '/api/evolution/auto-config', {
    method: 'PUT', body: JSON.stringify({ enabled: false }),
  })
  assert.equal(disabled.status, 200)
  assert.equal((await disabled.json()).config.enabled, false)
})
