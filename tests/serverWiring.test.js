import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { BUILTIN_HTTP_CAPABILITY_CATALOG } from '../server/core/builtinHttpCapabilities.js'
import { startRuntimeServer } from '../server/services/runtimeServerStartup.js'

test('router returns async handlers so errorBoundary can observe rejected promises', () => {
  const hostSource = fs.readFileSync(new URL('../server/appServer.js', import.meta.url), 'utf8')
  const capabilitySource = fs.readFileSync(
    new URL('../server/core/builtinHttpCapabilities.js', import.meta.url),
    'utf8',
  )

  assert.match(hostSource, /if \(dispatched\.handled\) return dispatched\.result/)
  for (const handler of [
    'handleAuthAccountRequest',
    'handleModelStatusRequest',
    'handleSystemDiagnosticsRequest',
    'modelProxyRequestHandler',
    'handleToolProxyRequest',
    'handleJobRequest',
    'handleSkillRequest',
  ]) {
    assert.match(capabilitySource, new RegExp(`=> ${handler}\\(req, res`))
  }
})

test('fatal process handlers keep logging in production', () => {
  const source = fs.readFileSync(new URL('../server/appServer.js', import.meta.url), 'utf8')

  assert.match(source, /const onUncaughtException = \(error\) => \{\s*console\.error\('\[server\] uncaughtException:'/)
  assert.match(source, /const onUnhandledRejection = \(reason\) => \{\s*console\.error\('\[server\] unhandledRejection:'/)
  assert.match(source, /processTarget\.on\('uncaughtException', onUncaughtException\)/)
  assert.match(source, /processTarget\.off\('uncaughtException', onUncaughtException\)/)
  assert.match(source, /processTarget\.on\('unhandledRejection', onUnhandledRejection\)/)
  assert.match(source, /processTarget\.off\('unhandledRejection', onUnhandledRejection\)/)
})


test('app server routes fs and shell tool endpoints before generic web tools proxy', () => {
  const byId = new Map(BUILTIN_HTTP_CAPABILITY_CATALOG.map((entry) => [entry.id, entry]))
  assert.ok(
    byId.get('builtin.tools.fs-shell').priority > byId.get('builtin.tools.proxy').priority,
  )
  assert.ok(
    byId.get('builtin.mcp.api').priority > byId.get('builtin.tools.proxy').priority,
    '/api/tools/mcp/call must reach the MCP handler before the generic proxy',
  )
})

test('HTTP listener starts before the lifecycle barrier while required failures stay fail-closed', () => {
  const source = fs.readFileSync(new URL('../server/appServer.js', import.meta.url), 'utf8')
  const startSupport = fs.readFileSync(new URL('../server/appServerStartSupport.js', import.meta.url), 'utf8')
  const pluginSupport = fs.readFileSync(new URL('../server/appServerPluginStartup.js', import.meta.url), 'utf8')

  assert.match(source, /runRuntimeConfigStartupPreflight\(\{ cwd, env \}\)/)
  assert.match(pluginSupport, /initializeRuntimePluginConfig\(\{ cwd, env: runtimeEnv \}\)/)
  assert.match(pluginSupport, /restoreEnabledRuntimePlugins\(\{ env: runtimeEnv \}\)/)
  assert.match(source, /prepareRuntimeCapabilitySnapshot\(\{ env: runtimeEnv, cwd \}\)/)
  assert.match(source, /bootstrap\(\{[\s\S]*?runtimeEnv,\s+cwd,\s+\}\)/)
  assert.match(source, /entry\.capability\.startFailure === 'fail'/)
  assert.match(startSupport, /server\.listen\(port, host/)
  assert.match(source, /const listeningReady = createAppServerListeningReady\(\{/)
  assert.ok(
    source.indexOf('const listeningReady = createAppServerListeningReady')
      < source.indexOf('const runtimePluginStartupReady = createRuntimePluginStartupReady'),
    'HTTP listen must succeed before the local recovery barrier creates side effects',
  )
  assert.match(
    pluginSupport,
    /return listeningReady\.then\(async \(\) => \{[\s\S]*?compactionArchiveController\.activate\(\)[\s\S]*?recoverPendingSessionDeletion\(\)[\s\S]*?initializeRuntimePluginConfig[\s\S]*?initPlugins[\s\S]*?restoreEnabledRuntimePlugins/,
    'session deletion recovery must finish before any runtime plugin initialization or restoration',
  )
  assert.doesNotMatch(
    source,
    /Promise\.all\(\[listeningReady,\s*runtimeStartupReady\]\)/,
    'startup must not use a fail-fast listener/runtime race',
  )
  assert.ok(
    pluginSupport.indexOf('recoverPendingSessionDeletion()')
      < pluginSupport.indexOf('initializeRuntimePluginConfig({ cwd, env: runtimeEnv })'),
    'runtime plugin configuration must remain behind the session deletion recovery barrier',
  )
  assert.ok(
    pluginSupport.indexOf('restoreEnabledRuntimePlugins({ env: runtimeEnv })') >= 0
      && source.indexOf('const runtimeStartupReady = runtimePluginStartupReady.then')
        < source.indexOf('prepareRuntimeCapabilitySnapshot({ env: runtimeEnv, cwd })'),
    'runtime plugins must restore before the capability snapshot is selected',
  )
  assert.ok(
    source.indexOf('prepareRuntimeCapabilitySnapshot({ env: runtimeEnv, cwd })')
      < source.indexOf('const startup = bootstrap({'),
    'the selected capability snapshot must be fixed before lifecycle activation',
  )
  assert.match(
    source,
    /const startup = bootstrap\(\{[\s\S]*?compactionArchiveController: pluginStartup\.compactionArchiveController,/,
  )
  assert.equal(
    pluginSupport.match(/restoreEnabledRuntimePlugins\(\{ env: runtimeEnv \}\)/g)?.length,
    1,
    'runtime plugins must be restored exactly once',
  )
  assert.match(source, /runtimeReadiness\.markReady\(\)/)
  assert.match(source, /runtimeReadiness\.markFailed\(error\)/)
  assert.match(
    startSupport,
    /server\.listen\(port, host, \(\) => \{[\s\S]*?startupAbortGuard\.assertNotRequested\(\)[\s\S]*?onReady/,
    'an aborted startup must not announce a late listener as running',
  )
  assert.match(source, /startupAbortGuard\.assertNotRequested\(\)\s*\n\s*const startup = bootstrap/)
  assert.match(
    source,
    /const requestShutdown = \(signal\) => \{\s*startupAbortGuard\.request\(signal\)\s*return shutdown\(server\)/,
  )
})

test('server entrypoint performs one preflight and reuses its resolved environment', () => {
  const entrySource = fs.readFileSync(new URL('../server/start.js', import.meta.url), 'utf8')
  const startupSource = fs.readFileSync(
    new URL('../server/services/runtimeServerStartup.js', import.meta.url),
    'utf8',
  )
  const hostSource = fs.readFileSync(new URL('../server/appServer.js', import.meta.url), 'utf8')
  const pluginStartupSource = fs.readFileSync(
    new URL('../server/appServerPluginStartup.js', import.meta.url),
    'utf8',
  )

  assert.match(
    entrySource,
    /import \{ SERVER_APPLICATION_ROOT \} from '\.\/utils\/serverApplicationRoot\.js'/,
  )
  assert.match(
    entrySource,
    /await startRuntimeServer\(\{ cwd: SERVER_APPLICATION_ROOT, env: process\.env \}\)/,
  )
  assert.doesNotMatch(entrySource, /cwd: process\.cwd\(\)/)
  assert.match(
    hostSource,
    /await startRuntimeServer\(\{ cwd: rootDir, env: process\.env \}\)/,
  )
  assert.equal(startupSource.match(/preflight\(\{ cwd, env \}\)/g)?.length, 1)
  assert.match(
    startupSource,
    /const persistenceBootstrap = await resolvePersistenceBootstrap\(\{ cwd, env \}, dependencies\)/,
  )
  assert.match(
    startupSource,
    /import\('\.\.\/adapters\/builtinSqliteTurnPersistenceBootstrap\.js'\)/,
  )
  assert.match(
    startupSource,
    /import\('\.\.\/adapters\/sqliteSubagentRunPersistenceAdapter\.js'\)/,
  )
  assert.doesNotMatch(startupSource, /sqliteTurnPersistenceAdapter\.js/)
  assert.doesNotMatch(startupSource, /core\/turnPersistenceBootstrap\.js/)
  assert.doesNotMatch(startupSource, /builtinTurnPersistenceAdapter/)
  assert.match(
    startupSource,
    /const \{ runtimeEnv \} = preflight\(\{ cwd, env \}\)/,
  )
  assert.ok(
    startupSource.indexOf('await resolvePersistenceBootstrap({ cwd, env }, dependencies)')
      < startupSource.indexOf('preflight({ cwd, env })'),
    'trusted persistence selection must finish before preflight can open a database',
  )
  assert.ok(
    startupSource.indexOf('await resolveSubagentRunPersistenceAdapter(dependencies)')
      < startupSource.indexOf('preflight({ cwd, env })'),
    'trusted Subagent persistence selection must finish before preflight can open a database',
  )
  assert.match(
    startupSource,
    /startAppServer\(\{[\s\S]*?cwd,[\s\S]*?runtimeEnv,[\s\S]*?turnPersistenceAdapter: persistenceBootstrap\.adapter,[\s\S]*?subagentRunPersistenceAdapter,[\s\S]*?\}\)/,
  )
  assert.match(hostSource, /runtimeEnv: preflightRuntimeEnv = null/)
  assert.match(pluginStartupSource, /acquireHostTurnPersistenceCapability\(turnPersistenceAdapter\)/)
  assert.match(pluginStartupSource, /registerServerShutdownFinalizer\(server, \(\) => persistenceLease\.release\(\)\)/)
  assert.doesNotMatch(hostSource, /sqliteTurnPersistenceAdapter/)
  assert.match(
    hostSource,
    /const runtimeEnv = preflightRuntimeEnv\s*\?\? runRuntimeConfigStartupPreflight\(\{ cwd, env \}\)\.runtimeEnv/,
  )
  assert.doesNotMatch(startupSource, /startAppServer\(\{[^}]*\benv\b/)
})

test('runtime startup resolves Subagent persistence before preflight and preserves adapter identity', async () => {
  const calls = []
  const turnPersistenceAdapter = Object.freeze({ kind: 'turn-persistence' })
  const subagentRunPersistenceAdapter = Object.freeze({ kind: 'subagent-persistence' })
  const runtimeEnv = Object.freeze({ SERVER_HOST: '127.0.0.1' })
  const getDb = () => {
    throw new Error('the wiring fixture must not open SQLite')
  }
  let received = null

  const result = await startRuntimeServer({ cwd: 'C:\\gugo', env: {} }, {
    persistenceBootstrapEnv: Object.freeze({}),
    resolveBuiltinSqliteTurnPersistenceBootstrap: async () => {
      calls.push('turn-persistence')
      return { adapter: turnPersistenceAdapter }
    },
    createSqliteSubagentRunPersistenceAdapter: (input) => {
      calls.push('subagent-persistence')
      assert.equal(input.getDb, getDb)
      return subagentRunPersistenceAdapter
    },
    getDb,
    runRuntimeConfigStartupPreflight: () => {
      calls.push('preflight')
      return { runtimeEnv }
    },
    startAppServer: (input) => {
      calls.push('start-app-server')
      received = input
      return 'started'
    },
  })

  assert.equal(result, 'started')
  assert.deepEqual(calls, [
    'turn-persistence',
    'subagent-persistence',
    'preflight',
    'start-app-server',
  ])
  assert.equal(received.turnPersistenceAdapter, turnPersistenceAdapter)
  assert.equal(received.subagentRunPersistenceAdapter, subagentRunPersistenceAdapter)
  assert.equal(received.runtimeEnv, runtimeEnv)
})
