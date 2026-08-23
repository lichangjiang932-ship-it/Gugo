import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-release-gc-routes-'))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const { bootstrapAuth } = await import('../server/adapters/authAccount.js')
const { closeDb, getDb } = await import('../server/db.js')
const { migrateToV78 } = await import('../server/migrations/v78RuntimePluginReleaseRetention.js')
const { handlePluginRequest } = await import('../server/routes/pluginRoutes.js')
const {
  countRuntimePluginReleases,
  createRuntimePluginRelease,
} = await import('../server/services/runtimePluginStateStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const PLUGIN_ID = 'route-retention-transformer'
const SOURCE = 'function transform(input) { return input }'
const SOURCE_DIGEST = `sha256-${createHash('sha256').update(SOURCE).digest('hex')}`
const GC_PATH = '/api/plugins/runtime/releases/gc'
const DELETE_CONFIRMATION = 'delete_eligible_releases'
const LOCAL_ENV = Object.freeze({ AUTH_MODE: 'local' })
const OWNER = bootstrapAuth({ env: LOCAL_ENV })

function pluginSnapshot() {
  return {
    id: PLUGIN_ID,
    name: 'Route Retention Transformer',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    description: '',
    requires: [],
    contributes: [],
    capabilities: [],
  }
}

function release(releaseId, createdAt) {
  return createRuntimePluginRelease({
    pluginId: PLUGIN_ID,
    releaseId,
    sourceDigest: SOURCE_DIGEST,
    source: SOURCE,
    pluginSnapshotJson: JSON.stringify(pluginSnapshot()),
    validationStatus: 'passed',
    healthStatus: 'passed',
    now: createdAt,
  })
}

function seedReleases() {
  release('route-release-1', 10)
  release('route-release-2', 20)
  release('route-release-3', 30)
}

function gcPolicy(overrides = {}) {
  return {
    keepLatest: 1,
    minAgeMs: 0,
    maxDeletesPerRun: 1,
    maxReleasesScanned: 100,
    maxAuditRuns: 10,
    ...overrides,
  }
}

function createRequest({
  url = GC_PATH,
  method = 'GET',
  token = '',
  remoteAddress = '127.0.0.1',
  body,
} = {}) {
  const payload = body === undefined ? [] : [JSON.stringify(body)]
  const req = Readable.from(payload)
  req.method = method
  req.url = url
  req.headers = token ? { authorization: `Bearer ${token}` } : {}
  req.socket = { remoteAddress }
  return req
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    writeHead(statusCode) { this.statusCode = statusCode },
    end(chunk = '') { this.body += chunk },
  }
}

async function requestGc({ env = LOCAL_ENV, ...request } = {}) {
  const res = createResponse()
  await handlePluginRequest(createRequest(request), res, { env })
  return {
    status: res.statusCode,
    headers: res.headers,
    body: JSON.parse(res.body),
  }
}

async function previewGc(policy = gcPolicy()) {
  return requestGc({
    method: 'POST',
    token: OWNER.token,
    body: { policy },
  })
}

async function executePreview(previewRunId) {
  return requestGc({
    method: 'POST',
    token: OWNER.token,
    body: {
      dryRun: false,
      confirm: DELETE_CONFIRMATION,
      previewRunId,
    },
  })
}

function resetDatabase() {
  const db = getDb()
  db.exec(`
    DROP TRIGGER IF EXISTS reject_route_gc_delete;
    DROP TRIGGER IF EXISTS trg_runtime_plugin_releases_immutable_delete;
    DELETE FROM runtime_plugin_release_gc_delete_guards;
    DELETE FROM runtime_plugin_release_pins;
    DELETE FROM runtime_plugin_release_gc_runs;
    DELETE FROM runtime_plugin_states;
    DELETE FROM turn_execution_leases;
    DELETE FROM job_execution_leases;
    DELETE FROM turn_checkpoints;
    DELETE FROM job_turn_checkpoints;
    DELETE FROM turn_events;
    DELETE FROM runtime_plugin_releases;
  `)
  migrateToV78(db)
}

test.beforeEach(resetDatabase)

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('Release GC operations require the loopback local owner', async () => {
  const unauthenticated = await requestGc()
  assert.equal(unauthenticated.status, 401)
  assert.equal(unauthenticated.body.error.code, 'UNAUTHORIZED')

  const multiUser = issueTestSession({ email: 'gc-route-multi@example.com' })
  const forbiddenUser = await requestGc({
    token: multiUser.token,
    env: { AUTH_MODE: 'multi_user' },
  })
  assert.equal(forbiddenUser.status, 403)
  assert.equal(forbiddenUser.body.error.code, 'LOCAL_OWNER_ONLY')

  const remoteOwner = await requestGc({
    token: OWNER.token,
    remoteAddress: '192.0.2.10',
  })
  assert.equal(remoteOwner.status, 403)
  assert.equal(remoteOwner.body.error.code, 'LOCAL_OWNER_ONLY')
})

test('GET Release GC returns bounded local audit metadata without caching', async () => {
  const response = await requestGc({ token: OWNER.token })
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.body.ok, true)
  assert.equal(response.body.schemaVersion, 1)
  assert.equal(response.body.dryRunDefault, true)
  assert.equal(response.body.previewTtlMs, 300_000)
  assert.equal(response.body.executionConfirmation, DELETE_CONFIRMATION)
  assert.equal(response.body.policy.enabled, true)
  assert.deepEqual(response.body.audits, [])

  const invalidLimit = await requestGc({
    url: `${GC_PATH}?limit=101`,
    token: OWNER.token,
  })
  assert.equal(invalidLimit.status, 400)
  assert.equal(invalidLimit.body.error.code, 'PLUGIN_RELEASE_GC_QUERY_INVALID')

  const duplicateLimit = await requestGc({
    url: `${GC_PATH}?limit=1&limit=2`,
    token: OWNER.token,
  })
  assert.equal(duplicateLimit.status, 400)
  assert.equal(duplicateLimit.body.error.code, 'PLUGIN_RELEASE_GC_QUERY_INVALID')
})

test('Release GC rejects ambiguous or out-of-bounds mutation parameters', async () => {
  seedReleases()
  const invalidRequests = [
    { dryRun: 'false', policy: gcPolicy() },
    { dryRun: true, policy: gcPolicy({ keepLatest: '1' }) },
    { dryRun: true, policy: gcPolicy({ maxDeletesPerRun: 101 }) },
    { dryRun: true, policy: { ...gcPolicy(), typoLimit: 1 } },
    { dryRun: true, unexpected: true, policy: gcPolicy() },
  ]
  for (const body of invalidRequests) {
    const response = await requestGc({
      method: 'POST',
      token: OWNER.token,
      body,
    })
    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'PLUGIN_RELEASE_GC_POLICY_INVALID')
  }

  const preview = await previewGc()
  const missingConfirmation = await requestGc({
    method: 'POST',
    token: OWNER.token,
    body: { dryRun: false, previewRunId: preview.body.audit.runId },
  })
  assert.equal(missingConfirmation.status, 400)
  assert.equal(missingConfirmation.body.error.code, 'PLUGIN_RELEASE_GC_CONFIRMATION_REQUIRED')
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 3)
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM runtime_plugin_release_gc_runs').get().count,
    1,
  )
})

test('Release GC defaults to dry-run and reports candidates and retained Releases', async () => {
  seedReleases()
  const response = await requestGc({
    method: 'POST',
    token: OWNER.token,
    body: { policy: gcPolicy() },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.dryRun, true)
  assert.equal(response.body.audit.status, 'completed')
  assert.equal(response.body.audit.policy.dryRun, true)
  assert.equal(response.body.audit.result.mode, 'dry_run')
  assert.equal(response.body.audit.result.candidateCount, 1)
  assert.deepEqual(
    response.body.audit.result.candidates.map((entry) => entry.releaseId),
    ['route-release-1'],
  )
  assert.equal(response.body.audit.result.retainedCount, 2)
  assert.equal(response.body.audit.result.remainingCount, 3)
  assert.equal(response.body.audit.result.deletedCount, 0)
  assert.deepEqual(response.body.audit.result.failures, [])
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 3)
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM runtime_plugin_release_gc_delete_guards').get().count,
    0,
  )
})

test('Release GC removes expired execution leases but remains blocked by a live lease', async () => {
  seedReleases()
  const now = Date.now()
  const insertLease = getDb().prepare(`
    INSERT INTO turn_execution_leases (
      user_id, session_id, turn_id, owner_id, acquired_at, expires_at
    ) VALUES (?, ?, ?, 'route-gc-lease-owner', ?, ?)
  `)
  insertLease.run(OWNER.user.id, OWNER.token, 'expired-route-gc-turn', now - 2, now - 1)

  const expired = await previewGc()
  assert.equal(expired.status, 200)
  assert.equal(expired.body.audit.status, 'completed')
  assert.equal(expired.body.audit.result.candidateCount, 1)
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM turn_execution_leases').get().count,
    0,
  )

  insertLease.run(OWNER.user.id, OWNER.token, 'live-route-gc-turn', now, now + 60_000)
  const live = await previewGc()
  assert.equal(live.status, 200)
  assert.equal(live.body.audit.status, 'skipped')
  assert.equal(live.body.audit.result.reason, 'execution_in_progress')
  assert.equal(live.body.audit.result.deletedCount, 0)
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 3)
})

test('Release GC deletes only the bounded candidate after explicit confirmation', async () => {
  seedReleases()
  const preview = await previewGc()
  const response = await executePreview(preview.body.audit.runId)
  assert.equal(response.status, 200)
  assert.equal(response.body.audit.status, 'completed')
  assert.equal(response.body.audit.result.mode, 'delete')
  assert.deepEqual(response.body.audit.result.deleted, [{
    pluginId: PLUGIN_ID,
    releaseId: 'route-release-1',
  }])
  assert.equal(response.body.audit.result.deletedCount, 1)
  assert.equal(response.body.audit.result.retainedCount, 2)
  assert.equal(response.body.audit.result.remainingCount, 2)
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
})

test('Release GC rolls back its preview claim with a failed delete and permits a safe retry', async () => {
  seedReleases()
  const preview = await previewGc()
  getDb().exec(`
    CREATE TRIGGER reject_route_gc_delete
      BEFORE DELETE ON runtime_plugin_releases
      WHEN OLD.release_id = 'route-release-1'
      BEGIN
        SELECT RAISE(ABORT, 'injected route GC failure');
      END;
  `)
  const response = await executePreview(preview.body.audit.runId)
  assert.equal(response.status, 500)
  assert.equal(response.body.ok, false)
  assert.equal(response.body.audit.status, 'failed')
  assert.equal(response.body.audit.result.failureCount, 1)
  assert.deepEqual(
    response.body.audit.result.candidates.map((entry) => entry.releaseId),
    ['route-release-1'],
  )
  assert.match(response.body.audit.result.failures[0].message, /injected route GC failure/u)
  assert.equal(response.body.audit.result.failures[0].releaseId, 'route-release-1')
  assert.equal(response.body.audit.result.remainingCount, 3)
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 3)
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM runtime_plugin_release_gc_delete_guards').get().count,
    0,
  )

  const previewResult = JSON.parse(getDb().prepare(`
    SELECT result_json FROM runtime_plugin_release_gc_runs WHERE run_id = ?
  `).get(preview.body.audit.runId).result_json)
  assert.equal(previewResult.preview.consumedAt, null)
  assert.equal(previewResult.preview.consumedByRunId, null)

  getDb().exec('DROP TRIGGER reject_route_gc_delete')
  const retry = await executePreview(preview.body.audit.runId)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.audit.status, 'completed')
  assert.equal(retry.body.audit.result.deletedCount, 1)
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
})

test('a preview runId can be claimed by only one concurrent delete request', async () => {
  seedReleases()
  const preview = await previewGc()
  const responses = await Promise.all([
    executePreview(preview.body.audit.runId),
    executePreview(preview.body.audit.runId),
  ])
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409])
  assert.equal(countRuntimePluginReleases(PLUGIN_ID), 2)
})
