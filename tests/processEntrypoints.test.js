import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startHubProcess } from '../server/hub/index.js'
import { runSeedSystemSkillsProcess } from '../server/seedSystemSkills.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HUB_ENTRY = path.join(ROOT, 'server', 'hub', 'index.js')
const SEED_ENTRY = path.join(ROOT, 'server', 'seedSystemSkills.js')
const SERVER_APPLICATION_ROOT_MODULE = pathToFileURL(
  path.join(ROOT, 'server', 'utils', 'serverApplicationRoot.js'),
).href
const RUNTIME_ENV_MODULE = pathToFileURL(path.join(ROOT, 'server', 'utils', 'runtimeEnv.js')).href

const SERVER_IDENTITY_PROBE = `
  import path from 'node:path'
  import { SERVER_APPLICATION_ROOT } from ${JSON.stringify(SERVER_APPLICATION_ROOT_MODULE)}
  import { resolveRuntimeConfigPaths } from ${JSON.stringify(RUNTIME_ENV_MODULE)}

  const defaultPaths = resolveRuntimeConfigPaths({ cwd: SERVER_APPLICATION_ROOT, env: {} })
  const relativeOverridePaths = resolveRuntimeConfigPaths({
    cwd: SERVER_APPLICATION_ROOT,
    env: { APP_DATA_DIR: 'custom-data' },
  })
  process.stdout.write(JSON.stringify({
    applicationRoot: SERVER_APPLICATION_ROOT,
    defaultDataDir: path.dirname(defaultPaths.user),
    relativeOverrideDataDir: path.dirname(relativeOverridePaths.user),
  }))
`

function cleanRuntimeIdentity() {
  const env = { ...process.env }
  for (const key of ['APP_CONFIG_PATH', 'APP_DATA_DIR', 'APP_DB_PATH', 'HUB_ENABLED']) {
    delete env[key]
  }
  return env
}

function probeServerIdentity(cwd) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', SERVER_IDENTITY_PROBE],
    {
      cwd,
      env: cleanRuntimeIdentity(),
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('server entry persistence identity is stable across caller working directories', () => {
  const firstCwd = mkdtempSync(path.join(tmpdir(), 'gugo-server-entry-cwd-a-'))
  const secondCwd = mkdtempSync(path.join(tmpdir(), 'gugo-server-entry-cwd-b-'))
  try {
    const first = probeServerIdentity(firstCwd)
    const second = probeServerIdentity(secondCwd)

    assert.deepEqual(second, first)
    assert.equal(path.resolve(first.applicationRoot), ROOT)
    assert.equal(path.resolve(first.defaultDataDir), path.join(ROOT, 'server-data'))
    assert.equal(path.resolve(first.relativeOverrideDataDir), path.join(ROOT, 'custom-data'))
  } finally {
    rmSync(firstCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(secondCwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('disabled Hub entry exits without importing or opening the runtime database', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'gugo-hub-disabled-'))
  const forbiddenDbPath = path.join(cwd, 'must-not-exist', 'hub.db')
  try {
    const result = spawnSync(process.execPath, [HUB_ENTRY], {
      cwd,
      env: {
        ...cleanRuntimeIdentity(),
        APP_DB_PATH: forbiddenDbPath,
        GUGO_LOAD_DOTENV: '0',
        HUB_ENABLED: '0',
      },
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /HUB_ENABLED!=1/)
    assert.equal(existsSync(forbiddenDbPath), false)
    assert.equal(existsSync(path.join(cwd, 'server-data', 'app.db')), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('enabled Hub preflights before starting the lazy runtime and reuses the snapshot', async () => {
  const events = []
  const runtimeEnv = Object.freeze({ APP_DB_PATH: 'resolved-hub.db', HUB_ENABLED: '1' })
  const runtime = {
    startHub: ({ env }) => {
      events.push('runtime:start')
      assert.strictEqual(env, runtimeEnv)
    },
    shutdownHub: async () => {
      events.push('runtime:stop')
      return 0
    },
  }
  const result = await startHubProcess({
    cwd: 'hub-runtime-root',
    env: { HUB_ENABLED: '1' },
    installSignalHandlers: false,
  }, {
    runRuntimeConfigStartupPreflight: (options) => {
      events.push('preflight')
      assert.equal(options.cwd, 'hub-runtime-root')
      return { runtimeEnv }
    },
    runtime,
  })

  assert.equal(result.started, true)
  assert.deepEqual(events, ['preflight', 'runtime:start'])
  await result.shutdown()
  assert.deepEqual(events, ['preflight', 'runtime:start', 'runtime:stop'])
})

test('concurrent and repeated Hub shutdown calls share one in-flight promise', async () => {
  let shutdownCalls = 0
  let resolveShutdown
  const runtimeShutdown = new Promise((resolve) => {
    resolveShutdown = resolve
  })
  const runtime = {
    startHub: () => {},
    shutdownHub: () => {
      shutdownCalls += 1
      return runtimeShutdown
    },
  }
  const result = await startHubProcess({
    env: { HUB_ENABLED: '1' },
    installSignalHandlers: false,
  }, {
    runRuntimeConfigStartupPreflight: ({ env }) => ({ runtimeEnv: env }),
    runtime,
  })

  const first = result.shutdown()
  const second = result.shutdown()
  assert.strictEqual(second, first)
  await Promise.resolve()
  assert.equal(shutdownCalls, 1)

  resolveShutdown(0)
  assert.deepEqual(await Promise.all([first, second]), [0, 0])
  const repeated = result.shutdown()
  assert.strictEqual(repeated, first)
  assert.equal(await repeated, 0)
  assert.equal(shutdownCalls, 1)
})

test('disabled Hub does not invoke preflight or runtime dependencies', async () => {
  const fail = () => { throw new Error('disabled Hub must stay inert') }
  const result = await startHubProcess({ env: { HUB_ENABLED: '0' } }, {
    runRuntimeConfigStartupPreflight: fail,
    runtime: { startHub: fail, shutdownHub: fail },
  })
  assert.deepEqual(result, { started: false, reason: 'disabled' })
})

test('seed process runs preflight, seeds silently, and closes the database in order', async () => {
  const events = []
  const runtimeEnv = Object.freeze({ APP_DB_PATH: 'resolved-seed.db' })
  const result = await runSeedSystemSkillsProcess({
    cwd: 'seed-runtime-root',
    env: { APP_DB_PATH: 'bootstrap.db' },
  }, {
    runRuntimeConfigStartupPreflight: (options) => {
      events.push('preflight')
      assert.equal(options.cwd, 'seed-runtime-root')
      return { runtimeEnv }
    },
    seedSystemSkills: (options) => {
      events.push('seed')
      assert.deepEqual(options, { silent: true })
      return [{ id: 'seeded', status: 'installed' }]
    },
    closeDb: () => { events.push('close') },
  })

  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.strictEqual(result.runtimeEnv, runtimeEnv)
  assert.deepEqual(events, ['preflight', 'seed', 'close'])
})

test('seed:skills wrapper writes only the preflight-selected database and exits cleanly', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'gugo-seed-entry-'))
  const dataDir = path.join(cwd, 'selected-data')
  const dbPath = path.join(dataDir, 'seed.db')
  try {
    const result = spawnSync(process.execPath, [SEED_ENTRY], {
      cwd,
      env: {
        ...cleanRuntimeIdentity(),
        APP_DATA_DIR: dataDir,
        APP_DB_PATH: dbPath,
        GUGO_LOAD_DOTENV: '0',
      },
      encoding: 'utf8',
      timeout: 60_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).ok, true)
    assert.equal(existsSync(dbPath), true)
    assert.equal(existsSync(path.join(cwd, 'server-data', 'app.db')), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('package scripts point at the safe Hub and seed wrappers', () => {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.hub, 'node server/hub/start.js')
  assert.equal(packageJson.scripts['seed:skills'], 'node server/seedSystemSkills.js')
})
