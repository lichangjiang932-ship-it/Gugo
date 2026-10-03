import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, createUser, getDb } from '../../server/db.js'
import { resolveLocalRuntimeIdentity, resolveLocalUserId } from '../../bin/cli/localIdentity.js'

function fixture(t, config) {
  closeDb()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-local-identity-'))
  const env = { APP_DATA_DIR: path.join(directory, 'data'), APP_DB_PATH: path.join(directory, 'data', 'app.db'),
    ARTIFACT_DIR: path.join(directory, 'artifacts'), GUGO_LOAD_DOTENV: '0' }
  const saved = Object.fromEntries(['APP_DATA_DIR', 'APP_DB_PATH', 'ARTIFACT_DIR'].map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  fs.mkdirSync(path.join(directory, '.gugo'))
  fs.writeFileSync(path.join(directory, '.gugo', 'runtime.json'), JSON.stringify(config))
  t.after(() => {
    closeDb()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  })
  return { cwd: directory, env, quietMissingDotEnv: true }
}

test('local CLI identity does not ignore a multi-user policy from runtime configuration', async (t) => {
  const options = fixture(t, { AUTH_MODE: 'multi_user' })
  await assert.rejects(resolveLocalUserId(options), { code: 'AUTH_REQUIRED' })
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
  assert.equal(getDb().prepare('SELECT value FROM meta WHERE key=?').get('local_auth_owner_user_id'), undefined)
})

test('configured local identity and downstream consumers share the same resolved environment snapshot', async (t) => {
  const options = fixture(t, { AUTH_MODE: 'local', LOCAL_USER_ID: 'chosen-owner', MEMORY_EMBEDDINGS_ENABLED: '1' })
  createUser({ id: 'first-owner', email: 'first-owner@example.invalid' })
  createUser({ id: 'chosen-owner', email: 'chosen-owner@example.invalid' })
  const identity = await resolveLocalRuntimeIdentity(options)
  assert.equal(identity.userId, 'chosen-owner')
  assert.equal(identity.runtimeEnv.LOCAL_USER_ID, 'chosen-owner')
  assert.equal(identity.runtimeEnv.MEMORY_EMBEDDINGS_ENABLED, '1')
  assert.equal(Object.isFrozen(identity), true)
  assert.equal(Object.isFrozen(identity.runtimeEnv), true)
  assert.equal(options.env.LOCAL_USER_ID, undefined, 'caller environment is not mutated')
  assert.equal(await resolveLocalUserId(options), identity.userId)
})
