import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startRuntimeServer } from '../server/services/runtimeServerStartup.js'

test('shared runtime startup does not read dotenv when explicitly disabled', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-runtime-startup-env-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  fs.writeFileSync(
    path.join(cwd, '.env'),
    'GUGO_TURN_PERSISTENCE_MODULE=must-not-load.mjs\n',
    'utf8',
  )
  const turnPersistenceAdapter = Object.freeze({ id: 'test.persistence' })
  let selectedEnv

  await startRuntimeServer({ cwd, env: { GUGO_LOAD_DOTENV: '0' } }, {
    resolveBuiltinSqliteTurnPersistenceBootstrap: async ({ env }) => {
      selectedEnv = env
      return Object.freeze({ adapter: turnPersistenceAdapter })
    },
    runRuntimeConfigStartupPreflight: () => ({ runtimeEnv: {} }),
    startAppServer: () => Object.freeze({ kind: 'application' }),
  })

  assert.deepEqual(selectedEnv, { GUGO_LOAD_DOTENV: '0' })
})

test('shared runtime startup reuses the exact preflight environment', async () => {
  const events = []
  const runtimeEnv = Object.freeze({ SERVER_PORT: '5180' })
  const turnPersistenceAdapter = Object.freeze({ id: 'test.persistence' })
  const subagentRunPersistenceAdapter = Object.freeze({ id: 'test.subagent-persistence' })
  const server = Object.freeze({ kind: 'application' })
  const result = await startRuntimeServer({ cwd: 'runtime-root', env: { SOURCE: 'test' } }, {
    persistenceBootstrapEnv: Object.freeze({ SOURCE: 'bootstrap-test' }),
    resolveBuiltinSqliteTurnPersistenceBootstrap: async (options) => {
      events.push(['persistence', options])
      return Object.freeze({ adapter: turnPersistenceAdapter })
    },
    subagentRunPersistenceAdapter,
    runRuntimeConfigStartupPreflight: (options) => {
      events.push(['preflight', options])
      return { runtimeEnv }
    },
    startAppServer: (options) => {
      events.push(['application', options])
      return server
    },
  })

  assert.strictEqual(result, server)
  assert.deepEqual(events, [
    ['persistence', {
      cwd: 'runtime-root',
      env: { SOURCE: 'bootstrap-test' },
    }],
    ['preflight', { cwd: 'runtime-root', env: { SOURCE: 'test' } }],
    ['application', {
      cwd: 'runtime-root',
      runtimeEnv,
      turnPersistenceAdapter,
      subagentRunPersistenceAdapter,
    }],
  ])
})

test('shared runtime startup closes SQLite before entering exact recovery mode', async () => {
  const events = []
  const startupError = Object.assign(new Error('invalid runtime config'), {
    code: 'RUNTIME_CONFIG_FILE_INVALID',
  })
  const server = Object.freeze({ kind: 'recovery' })
  const options = { cwd: 'runtime-root', env: { APP_DATA_DIR: 'data' } }
  const result = await startRuntimeServer(options, {
    persistenceBootstrapEnv: Object.freeze({}),
    resolveBuiltinSqliteTurnPersistenceBootstrap: async () => {
      events.push('persistence')
      return { adapter: Object.freeze({ id: 'test.persistence' }) }
    },
    runRuntimeConfigStartupPreflight: () => { events.push('preflight'); throw startupError },
    runtimeConfigRecovery: {
      isRecoverableUserRuntimeConfigError: (input) => {
        events.push('classify')
        assert.deepEqual(input, { error: startupError, ...options })
        return true
      },
      startRuntimeConfigRecoveryServer: async (input) => {
        events.push('recovery')
        assert.deepEqual(input, { startupError, ...options })
        return server
      },
    },
    closeDb: () => { events.push('close-db') },
  })

  assert.strictEqual(result, server)
  assert.deepEqual(events, ['persistence', 'preflight', 'classify', 'close-db', 'recovery'])
})

test('shared runtime startup preserves non-recoverable failures', async () => {
  const startupError = new Error('permission denied')
  let closed = false
  await assert.rejects(startRuntimeServer({}, {
    persistenceBootstrapEnv: Object.freeze({}),
    resolveBuiltinSqliteTurnPersistenceBootstrap: async () => ({
      adapter: Object.freeze({ id: 'test.persistence' }),
    }),
    runRuntimeConfigStartupPreflight: () => { throw startupError },
    runtimeConfigRecovery: {
      isRecoverableUserRuntimeConfigError: () => false,
      startRuntimeConfigRecoveryServer: () => assert.fail('recovery must not start'),
    },
    closeDb: () => { closed = true },
  }), (error) => error === startupError)
  assert.equal(closed, false)
})

test('shared runtime startup fails before preflight when persistence bootstrap fails', async () => {
  const startupError = Object.assign(new Error('untrusted persistence module'), {
    code: 'TURN_PERSISTENCE_BOOTSTRAP_MODULE_OUTSIDE_TRUST_ROOT',
  })
  let preflighted = false
  let started = false
  await assert.rejects(startRuntimeServer({}, {
    persistenceBootstrapEnv: Object.freeze({}),
    resolveBuiltinSqliteTurnPersistenceBootstrap: async () => { throw startupError },
    runRuntimeConfigStartupPreflight: () => {
      preflighted = true
      return { runtimeEnv: {} }
    },
    startAppServer: () => { started = true },
    runtimeConfigRecovery: {
      isRecoverableUserRuntimeConfigError: () => false,
      startRuntimeConfigRecoveryServer: () => assert.fail('recovery must not start'),
    },
  }), (error) => error === startupError)
  assert.equal(preflighted, false)
  assert.equal(started, false)
})
