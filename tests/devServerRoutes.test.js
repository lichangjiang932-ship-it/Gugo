import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BUILTIN_HTTP_API_PREFIXES } from '../server/core/builtinHttpCapabilities.js'
import {
  developmentHttpCapabilityPlugin,
  runtimeLifecyclePlugin,
  VITE_PROJECT_ROOT,
} from '../vite.config.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VITE_CONFIG_PATH = join(ROOT, 'vite.config.js')
const VITE_CONFIG_URL = pathToFileURL(VITE_CONFIG_PATH).href

test('vite anchors default runtime storage and workspace identity to its project root', () => {
  assert.equal(VITE_PROJECT_ROOT, ROOT)
  const configSource = source()
  assert.match(configSource, /const runtimeCwd = VITE_PROJECT_ROOT/)
  assert.match(configSource, /root: runtimeCwd/)
  assert.doesNotMatch(configSource, /const runtimeCwd = process\.cwd\(\)/)
})

function source() {
  return readFileSync(VITE_CONFIG_PATH, 'utf8').replace(/\r\n/g, '\n')
}

function cleanRuntimeIdentity(env = process.env) {
  const next = { ...env }
  for (const key of ['APP_CONFIG_PATH', 'APP_DATA_DIR', 'APP_DB_PATH']) delete next[key]
  return next
}

function runConfigProbe({ cwd, command, isPreview, env = {} }) {
  const configEnv = {
    command,
    mode: command === 'build' || isPreview ? 'production' : 'development',
    isPreview,
  }
  const probe = [
    `const module = await import(${JSON.stringify(VITE_CONFIG_URL)})`,
    `const config = await module.default(${JSON.stringify(configEnv)})`,
    'process.stdout.write(JSON.stringify(config.plugins.map((plugin) => plugin.name)))',
  ].join('\n')
  return spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd,
    env: { ...cleanRuntimeIdentity(), ...env },
    encoding: 'utf8',
    timeout: 120_000,
  })
}

function assertProbeSucceeded(result) {
  assert.equal(
    result.status,
    0,
    `Vite config probe failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
}

test('vite config has no eager server imports and gates runtime behind non-preview serve', () => {
  const configSource = source()

  assert.doesNotMatch(
    configSource,
    /^import\s+[^\n]+?from\s+['"]\.\/server\//m,
    'vite.config.js 顶层不得静态导入后端运行时',
  )
  assert.match(
    configSource,
    /const runsDevelopmentRuntime = command === ['"]serve['"] && !isPreview/,
  )
  assert.match(
    configSource,
    /await import\(\s*['"]\.\/server\/services\/runtimeConfigStartupService\.js['"]\s*\)/,
  )
  assert.match(
    configSource,
    /runRuntimeConfigStartupPreflight\(\{\s*cwd: runtimeCwd,\s*env: startupEnv,?\s*\}\)/,
  )
})

test('vite dev mounts the same production HTTP capability catalog', () => {
  const configSource = source()

  assert.match(
    configSource,
    /import\(['"]\.\/server\/core\/builtinHttpCapabilities\.js['"]\)/,
  )
  assert.match(
    configSource,
    /registerBuiltinHttpCapabilities:\s*builtinHttpCapabilities\.registerBuiltinHttpCapabilities/,
  )
  assert.match(
    configSource,
    /registerBuiltinHttpCapabilities\(registry, \{\s*cwd: runtimeCwd,\s*getEnv,?\s*\}\)/,
  )

  for (const prefix of [
    '/api/tools/code',
    '/api/tools/agent',
    '/api/approvals',
    '/api/tool-permissions',
    '/api/tools/fs',
    '/api/tools/shell',
  ]) {
    assert.ok(BUILTIN_HTTP_API_PREFIXES.includes(prefix), `生产 capability catalog 缺少 ${prefix}`)
  }
})

function createDevelopmentHttpHarness() {
  const handlers = []
  const calls = []
  const registry = {
    dispatch() {
      calls.push('dispatch')
      return { handled: false }
    },
    disposeAll() {},
  }
  const plugin = developmentHttpCapabilityPlugin({
    bindRuntimePluginHttpCapabilities: () => () => {},
    createHttpCapabilityRegistry: () => registry,
    healthCheck: () => calls.push('health'),
    healthCheckFull: () => calls.push('health-full'),
    registerBuiltinHttpCapabilities: () => () => {},
    requireAuth: (_req, _res, next) => {
      calls.push('auth')
      next()
    },
    runtimeCwd: ROOT,
    runtimeEnv: {},
  })
  plugin.configureServer({
    httpServer: { once() {} },
    middlewares: { use: (handler) => handlers.push(handler) },
  })
  return { calls, handler: handlers[0] }
}

test('vite dev handles query-string liveness requests before the SPA fallback', () => {
  const { calls, handler } = createDevelopmentHttpHarness()
  let nextCalls = 0

  handler({ url: '/api/health?source=startup-probe' }, {}, () => { nextCalls += 1 })

  assert.deepEqual(calls, ['health'])
  assert.equal(nextCalls, 0)
})

test('vite dev authenticates query-string full-health requests before dispatch', () => {
  const { calls, handler } = createDevelopmentHttpHarness()
  let nextCalls = 0

  handler({ url: '/api/health/full?source=doctor' }, {}, () => { nextCalls += 1 })

  assert.deepEqual(calls, ['auth', 'health-full'])
  assert.equal(nextCalls, 0)
})

test('vite dev mounts realtime WebSocket through deferred runtime imports', () => {
  const configSource = source()

  assert.match(
    configSource,
    /import\(['"]\.\/server\/services\/turnWebSocket\.js['"]\)/,
  )
  assert.match(
    configSource,
    /import\(['"]\.\/server\/services\/turnEngineHost\.js['"]\)/,
  )
  assert.match(
    configSource,
    /function turnRealtimePlugin[\s\S]*?attachTurnWebSocketServer\(server\.httpServer,[\s\S]*?getTurnEngine\(\)\.listEvents/,
  )
})

test('vite dev passes one HostContext into capability preparation and lifecycle', () => {
  const configSource = source()

  assert.match(
    configSource,
    /prepareRuntimeCapabilitySnapshot\(\{\s*cwd: runtimeCwd,\s*env: runtimeEnv,?\s*\}\)/,
  )
  assert.match(
    configSource,
    /const startup = bootstrap\(\{\s*cwd: runtimeCwd,\s*runtimeEnv,/,
  )
  assert.match(configSource, /let shutdownPromise = null/)
  assert.match(
    configSource,
    /\.then\(\(\) => gracefulShutdown\(null, \{ silent: true, exit: false \}\)\)/,
  )
  assert.match(
    configSource,
    /acquireHostTurnPersistenceCapability:\s*runtimeCapabilityHost\.acquireHostTurnPersistenceCapability/,
  )
  assert.match(
    configSource,
    /import\(['"]\.\/server\/adapters\/sqliteSubagentRunPersistenceAdapter\.js['"]\)/,
  )
  assert.match(
    configSource,
    /createSqliteSubagentRunPersistenceAdapter\(\{\s*getDb:\s*database\.getDb,?\s*\}\)/,
  )
  assert.match(
    configSource,
    /async closeBundle\(\)\s*\{\s*const exitCode = await shutdownRuntime\(\)/,
  )
})

function fakeViteServer() {
  const closeListeners = []
  return {
    closeListeners,
    config: { logger: { error() {} } },
    httpServer: {
      once(event, listener) {
        if (event === 'close') closeListeners.push(listener)
      },
    },
  }
}

function createLifecyclePluginHarness(overrides = {}) {
  let releaseCalls = 0
  const subagentRunPersistenceAdapter = Object.freeze({
    id: 'test.subagent-run-persistence',
  })
  const plugin = runtimeLifecyclePlugin({
    acquireHostTurnPersistenceCapability: (adapter) => Object.freeze({
      adapter,
      release() {
        releaseCalls += 1
        return true
      },
    }),
    bootstrap: () => ({ ready: Promise.resolve({ failures: [] }) }),
    createBoundTurnPersistenceAdapter: (snapshot) => snapshot.persistence,
    gracefulShutdown: async () => 0,
    prepareRuntimeCapabilitySnapshot: async () => ({
      persistence: { id: 'test.persistence' },
      loop: { id: 'test.loop' },
    }),
    runtimeCwd: ROOT,
    runtimeEnv: Object.freeze({ GUGO_LOAD_DOTENV: '0' }),
    selectedToolLoopAdapter: (snapshot) => snapshot.loop,
    subagentRunPersistenceAdapter,
    turnPersistenceAdapter: Object.freeze({ id: 'test.persistence-input' }),
    ...overrides,
  })
  return {
    plugin,
    releaseCalls: () => releaseCalls,
    subagentRunPersistenceAdapter,
  }
}

test('vite passes the explicit Subagent persistence adapter into lifecycle bootstrap', async () => {
  let bootstrapInput = null
  const harness = createLifecyclePluginHarness({
    bootstrap(input) {
      bootstrapInput = input
      return { ready: Promise.resolve({ failures: [] }) }
    },
  })

  await harness.plugin.configureServer(fakeViteServer())
  assert.equal(
    bootstrapInput?.subagentRunPersistenceAdapter,
    harness.subagentRunPersistenceAdapter,
  )
  await harness.plugin.closeBundle()
  assert.equal(harness.releaseCalls(), 1)
})

test('vite releases the persistence lease when snapshot preparation fails before lifecycle starts', async () => {
  const sentinel = new Error('snapshot failed')
  let shutdownCalls = 0
  const harness = createLifecyclePluginHarness({
    prepareRuntimeCapabilitySnapshot: async () => { throw sentinel },
    gracefulShutdown: async () => {
      shutdownCalls += 1
      return 0
    },
  })

  await assert.rejects(
    harness.plugin.configureServer(fakeViteServer()),
    (error) => error === sentinel,
  )
  assert.equal(shutdownCalls, 0)
  assert.equal(harness.releaseCalls(), 1)
})

test('vite retains a lease after failed lifecycle stop and releases it on retry', async () => {
  const startupFailure = new Error('startup failed')
  let shutdownCalls = 0
  const harness = createLifecyclePluginHarness({
    bootstrap: () => ({
      ready: Promise.resolve({
        failures: [{
          capability: { id: 'test.startup', startFailure: 'fail' },
          error: startupFailure,
        }],
      }),
    }),
    gracefulShutdown: async () => {
      shutdownCalls += 1
      return shutdownCalls === 1 ? 1 : 0
    },
  })

  await assert.rejects(
    harness.plugin.configureServer(fakeViteServer()),
    (error) => error instanceof AggregateError
      && error.errors.some((entry) => entry?.code === 'DEV_RUNTIME_STARTUP_CAPABILITY_FAILED')
      && error.errors.some((entry) => entry?.code === 'DEV_RUNTIME_ROLLBACK_FAILED'),
  )
  assert.equal(shutdownCalls, 1)
  assert.equal(harness.releaseCalls(), 0)

  await harness.plugin.closeBundle()
  assert.equal(shutdownCalls, 2)
  assert.equal(harness.releaseCalls(), 1)
})

test('vite preserves a synchronous shutdown error and keeps the lease retryable', async () => {
  const startupFailure = new Error('startup failed')
  const shutdownFailure = new Error('synchronous shutdown failed')
  let shutdownCalls = 0
  const harness = createLifecyclePluginHarness({
    bootstrap: () => ({
      ready: Promise.resolve({
        failures: [{
          capability: { id: 'test.startup', startFailure: 'fail' },
          error: startupFailure,
        }],
      }),
    }),
    gracefulShutdown: () => {
      shutdownCalls += 1
      if (shutdownCalls === 1) throw shutdownFailure
      return Promise.resolve(0)
    },
  })

  await assert.rejects(
    harness.plugin.configureServer(fakeViteServer()),
    (error) => error instanceof AggregateError
      && error.errors.some((entry) => entry?.code === 'DEV_RUNTIME_STARTUP_CAPABILITY_FAILED')
      && error.errors.includes(shutdownFailure),
  )
  assert.equal(shutdownCalls, 1)
  assert.equal(harness.releaseCalls(), 0)

  await harness.plugin.closeBundle()
  assert.equal(shutdownCalls, 2)
  assert.equal(harness.releaseCalls(), 1)
})

for (const probeCase of [
  { name: 'build', command: 'build', isPreview: false },
  { name: 'preview', command: 'serve', isPreview: true },
]) {
  test(`vite ${probeCase.name} does not open the runtime database`, () => {
    const cwd = mkdtempSync(join(tmpdir(), `gugo-vite-${probeCase.name}-`))
    const forbiddenDbPath = join(cwd, 'must-not-exist', 'app.db')
    try {
      const result = runConfigProbe({
        cwd,
        command: probeCase.command,
        isPreview: probeCase.isPreview,
        env: {
          APP_DB_PATH: forbiddenDbPath,
          GUGO_LOAD_DOTENV: '0',
          NODE_ENV: 'test',
        },
      })
      assertProbeSucceeded(result)
      assert.equal(existsSync(forbiddenDbPath), false)
      assert.equal(existsSync(join(cwd, 'server-data', 'app.db')), false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
}

test('vite dev preflights relocated storage before loading the backend runtime', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gugo-vite-dev-'))
  const relocatedDataDir = join(cwd, 'relocated-data')
  const relocatedDbPath = join(relocatedDataDir, 'app.db')
  const defaultDbPath = join(cwd, 'server-data', 'app.db')
  try {
    const result = runConfigProbe({
      cwd,
      command: 'serve',
      isPreview: false,
      env: {
        APP_DATA_DIR: relocatedDataDir,
        GUGO_LOAD_DOTENV: '0',
        NODE_ENV: 'test',
      },
    })
    assertProbeSucceeded(result)
    assert.equal(existsSync(relocatedDbPath), true)
    assert.equal(existsSync(defaultDbPath), false)
    assert.match(result.stdout, /local-runtime-http-capabilities/)
    assert.match(result.stdout, /builtin-runtime-lifecycle/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('vite dev ignores dotenv persistence selection when explicitly disabled', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gugo-vite-dotenv-disabled-'))
  const dataDir = join(cwd, 'runtime-data')
  try {
    writeFileSync(
      join(cwd, '.env'),
      'GUGO_TURN_PERSISTENCE_MODULE=must-not-load.mjs\nAPP_DATA_DIR=dotenv-data\n',
      'utf8',
    )
    const result = runConfigProbe({
      cwd,
      command: 'serve',
      isPreview: false,
      env: {
        APP_DATA_DIR: dataDir,
        GUGO_LOAD_DOTENV: '0',
        NODE_ENV: 'test',
      },
    })

    assertProbeSucceeded(result)
    assert.equal(existsSync(join(dataDir, 'app.db')), true)
    assert.equal(existsSync(join(cwd, 'dotenv-data', 'app.db')), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('vite dev watcher ignores electron-builder release directories', () => {
  const configSource = source()
  const ignoredBlock = configSource.match(/watch:\s*\{\s*ignored:\s*\[([\s\S]*?)\]/)?.[1]

  assert.ok(ignoredBlock, 'vite.config.js 应配置 server.watch.ignored')
  const ignoredPatterns = [...ignoredBlock.matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => match[1])

  assert.ok(ignoredPatterns.includes('**/release/**'))
  assert.ok(ignoredPatterns.includes('**/release-*/**'))
})
