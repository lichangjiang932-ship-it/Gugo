import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Parser } from 'acorn'
import jsx from 'acorn-jsx'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TURN_ENGINE_FILE = path.join(REPO_ROOT, 'server', 'services', 'TurnEngine.js')
const TURN_ENGINE_HOST_FILE = path.join(REPO_ROOT, 'server', 'services', 'turnEngineHost.js')
const LOCAL_MODULE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.jsx', '.cjs'])
const PRODUCTION_SOURCE_ROOTS = Object.freeze([
  'server',
  'desktop',
  'bin',
  'scripts',
  'src',
  'shared',
])
const EXCLUDED_SCAN_DIRECTORIES = new Set(['tests', 'node_modules', 'dist'])
const JavaScriptParser = Parser.extend(jsx())

function walkAst(node, visitor) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visitor(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visitor)
    } else if (value && typeof value === 'object') {
      walkAst(value, visitor)
    }
  }
}

function moduleSpecifiers(file) {
  const ast = JavaScriptParser.parse(readFileSync(file, 'utf8'), {
    ecmaVersion: 'latest',
    sourceType: path.extname(file) === '.cjs' ? 'script' : 'module',
    allowHashBang: true,
  })
  const specifiers = []
  walkAst(ast, (node) => {
    if (
      (node.type === 'ImportDeclaration'
        || node.type === 'ExportNamedDeclaration'
        || node.type === 'ExportAllDeclaration')
      && typeof node.source?.value === 'string'
    ) {
      specifiers.push(node.source.value)
    }
    if (node.type === 'ImportExpression' && typeof node.source?.value === 'string') {
      specifiers.push(node.source.value)
    }
    if (
      node.type === 'CallExpression'
      && node.callee?.type === 'Identifier'
      && node.callee.name === 'require'
      && node.arguments?.length === 1
      && typeof node.arguments[0]?.value === 'string'
    ) {
      specifiers.push(node.arguments[0].value)
    }
  })
  return specifiers
}

function walkJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && EXCLUDED_SCAN_DIRECTORIES.has(entry.name)) return []
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return walkJavaScriptFiles(absolute)
    return entry.isFile() && /\.(?:js|mjs|jsx|cjs)$/.test(entry.name) ? [absolute] : []
  })
}

function isFile(file) {
  return existsSync(file) && statSync(file).isFile()
}

function isDirectory(directory) {
  return existsSync(directory) && statSync(directory).isDirectory()
}

function resolveLocalModule(fromFile, specifier) {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return null
  const candidate = path.resolve(path.dirname(fromFile), specifier)
  const explicitExtension = path.extname(candidate)
  if (explicitExtension) {
    return LOCAL_MODULE_EXTENSIONS.includes(explicitExtension) && isFile(candidate)
      ? candidate
      : null
  }
  if (isFile(candidate)) return candidate
  for (const extension of LOCAL_MODULE_EXTENSIONS) {
    const withExtension = `${candidate}${extension}`
    if (isFile(withExtension)) return withExtension
  }
  if (isDirectory(candidate)) {
    for (const extension of LOCAL_MODULE_EXTENSIONS) {
      const indexFile = path.join(candidate, `index${extension}`)
      if (isFile(indexFile)) return indexFile
    }
  }
  return null
}

function traceLocalDependencies(entryFile) {
  const parents = new Map([[entryFile, null]])
  const pending = [entryFile]
  while (pending.length > 0) {
    const file = pending.shift()
    for (const specifier of moduleSpecifiers(file)) {
      const dependency = resolveLocalModule(file, specifier)
      if (!dependency || parents.has(dependency)) continue
      parents.set(dependency, file)
      pending.push(dependency)
    }
  }
  return parents
}

function dependencyPath(parents, target) {
  const files = []
  for (let current = target; current; current = parents.get(current)) files.push(current)
  return files.reverse().map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
}

function runFreshModule(script) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gugo-turn-host-'))
  try {
    return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_DATA_DIR: path.join(tempRoot, 'data'),
      },
    })
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function assertFreshModuleSucceeded(result) {
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
  )
}

test('TurnEngine stays transitively below its host and persistence composition roots', () => {
  const parents = traceLocalDependencies(TURN_ENGINE_FILE)
  const forbiddenRoots = [
    TURN_ENGINE_HOST_FILE,
    path.join(REPO_ROOT, 'server', 'core', 'turnPersistenceAdapter.js'),
    path.join(REPO_ROOT, 'server', 'adapters', 'sqliteTurnPersistenceAdapter.js'),
    path.join(REPO_ROOT, 'server', 'services', 'modelReadinessService.js'),
  ]
  const forbiddenEngineDependencies = forbiddenRoots
    .filter((file) => parents.has(file))
    .map((file) => dependencyPath(parents, file).join(' -> '))
  assert.deepEqual(
    forbiddenEngineDependencies,
    [],
    'TurnEngine must not directly or indirectly import its process host or composition roots',
  )

  const hostSpecifiers = moduleSpecifiers(TURN_ENGINE_HOST_FILE)
  assert.ok(hostSpecifiers.includes('./TurnEngine.js'))
  assert.ok(hostSpecifiers.includes('../core/turnPersistenceAdapter.js'))
  assert.equal(
    hostSpecifiers.some((specifier) => (
      /(?:^|\/)sqliteTurnPersistenceAdapter\.js$/.test(specifier)
      || /(?:^|\/)db\.js$/.test(specifier)
      || /(?:^|\/)routes(?:\/|$)/.test(specifier)
    )),
    false,
    'turnEngineHost must compose the active adapter without selecting SQLite or importing routes',
  )
})

test('the unsafe TurnEngine reset hook is unreachable from production modules', () => {
  const productionFiles = [
    ...PRODUCTION_SOURCE_ROOTS.flatMap((directory) => (
      walkJavaScriptFiles(path.join(REPO_ROOT, directory))
    )),
    path.join(REPO_ROOT, 'vite.config.js'),
  ]
  const consumers = productionFiles
    .filter((file) => file !== TURN_ENGINE_HOST_FILE)
    .filter((file) => readFileSync(file, 'utf8').includes('_resetTurnEngine'))
    .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
  assert.deepEqual(consumers, [])
})

test('importing turnEngineHost selects no backend and acquisition fails closed', () => {
  const result = runFreshModule(`
    import assert from 'node:assert/strict'
    const persistence = await import('./server/core/turnPersistenceAdapter.js')
    const before = persistence.getTurnPersistenceAdapterStatus()
    const host = await import('./server/services/turnEngineHost.js')
    const after = persistence.getTurnPersistenceAdapterStatus()
    assert.deepEqual(after, before)
    assert.equal(after.configured, false)
    assert.equal(after.engineBound, false)
    assert.throws(
      () => host.getTurnEngine(),
      (error) => error?.code === 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED'
        && error?.retryable === false,
    )
    assert.deepEqual(persistence.getTurnPersistenceAdapterStatus(), before)
  `)
  assertFreshModuleSucceeded(result)
})

test('TurnEngine host permits pure chat without an attachment capability and rejects attachment use', () => {
  const result = runFreshModule(`
    import assert from 'node:assert/strict'
    const {
      createTurnPersistenceAdapterController,
      getTurnPersistenceAdapterStatus,
    } = await import('./server/core/turnPersistenceAdapter.js')
    const {
      COMPACTION_ARCHIVE_PORT_VERSION,
      createCompactionArchivePortController,
    } = await import('./server/core/compactionArchivePort.js')
    const { getManagedAttachmentRuntimePortStatus } = await import(
      './server/core/managedAttachmentRuntimePort.js'
    )
    const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import(
      './server/adapters/sqliteTurnPersistenceAdapter.js'
    )
    const { closeTurnEngine, getTurnEngine } = await import(
      './server/services/turnEngineHost.js'
    )

    const persistenceController = createTurnPersistenceAdapterController(
      SQLITE_TURN_PERSISTENCE_ADAPTER,
      { source: 'test.turn-engine-host-no-attachments' },
    )
    const compactionController = createCompactionArchivePortController({
      apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
      id: 'test.turn-engine-host-no-attachments',
      create(input) {
        return {
          id: input.id || 'unused-archive',
          userId: input.userId,
          sessionId: input.sessionId,
          replacedMessageCount: input.archivedMessages.length,
          archivedMessages: input.archivedMessages,
          summaryText: input.summaryText,
          createdAt: 1,
        }
      },
      get() { return null },
      cleanup() { return { removed: 0 } },
    }, { source: 'test.turn-engine-host-no-attachments' })
    persistenceController.activate()
    compactionController.activate()

    const engine = getTurnEngine()
    assert.equal(getManagedAttachmentRuntimePortStatus().configured, false)
    assert.equal(getManagedAttachmentRuntimePortStatus().activeLeases, 0)
    assert.deepEqual(engine.deps.validateAttachments({ attachmentIds: [] }), [])
    assert.deepEqual(
      engine.deps.prepareAttachments({ attachmentIds: [], text: 'plain chat' }),
      { attachments: [], content: 'plain chat' },
    )
    assert.throws(
      () => engine.deps.validateAttachments({ attachmentIds: ['attachment-1'] }),
      (error) => error?.code === 'MANAGED_ATTACHMENT_PORT_NOT_CONFIGURED'
        && error?.status === 503
        && error?.retryable === false,
    )

    await closeTurnEngine()
    assert.equal(getTurnPersistenceAdapterStatus().engineBound, false)
    assert.equal(compactionController.release(), true)
    assert.equal(persistenceController.release(), true)
  `)
  assertFreshModuleSucceeded(result)
})

test('TurnEngine initialization failure preserves its cause and releases the persistence lease', () => {
  const result = runFreshModule(`
    import assert from 'node:assert/strict'
    const persistence = await import('./server/core/turnPersistenceAdapter.js')
    const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import(
      './server/adapters/sqliteTurnPersistenceAdapter.js'
    )
    const {
      MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
      createManagedAttachmentRuntimePortController,
      getManagedAttachmentRuntimePortStatus,
    } = await import('./server/core/managedAttachmentRuntimePort.js')
    const { getTurnEngine } = await import('./server/services/turnEngineHost.js')

    const controller = persistence.createTurnPersistenceAdapterController(
      SQLITE_TURN_PERSISTENCE_ADAPTER,
      { source: 'test.turn-engine-initialization-rollback' },
    )
    const managedAttachmentController = createManagedAttachmentRuntimePortController({
      apiVersion: MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
      id: 'test.turn-engine-initialization-rollback',
      validateAttachments: () => [],
      bindAttachments: () => [],
      prepareAttachments: () => ({ attachments: [], content: '' }),
    }, { source: 'test.turn-engine-initialization-rollback' })
    controller.activate()
    managedAttachmentController.activate()
    assert.throws(
      () => getTurnEngine(),
      (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
    )
    assert.equal(persistence.getTurnPersistenceAdapterStatus().engineBound, false)
    assert.equal(getManagedAttachmentRuntimePortStatus().activeLeases, 0)
    assert.equal(managedAttachmentController.release(), true)
    assert.equal(controller.release(), true)
  `)
  assertFreshModuleSucceeded(result)
})

test('concurrent host shutdowns share one barrier and retain every lease until a retry succeeds', () => {
  const result = runFreshModule(`
    import assert from 'node:assert/strict'
    const {
      createTurnPersistenceAdapterController,
      getTurnPersistenceAdapterStatus,
    } = await import('./server/core/turnPersistenceAdapter.js')
    const {
      COMPACTION_ARCHIVE_PORT_VERSION,
      createCompactionArchivePortController,
      getCompactionArchivePortStatus,
    } = await import('./server/core/compactionArchivePort.js')
    const {
      MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
      createManagedAttachmentRuntimePortController,
      getManagedAttachmentRuntimePortStatus,
    } = await import('./server/core/managedAttachmentRuntimePort.js')
    const { SQLITE_TURN_PERSISTENCE_ADAPTER } = await import(
      './server/adapters/sqliteTurnPersistenceAdapter.js'
    )
    const {
      closeTurnEngine,
      getTurnEngine,
      isTurnEngineHostUnavailableError,
    } = await import(
      './server/services/turnEngineHost.js'
    )
    const { resolveSubagentModelBinding } = await import(
      './server/services/subagentModelBindingRuntime.js'
    )

    const controller = createTurnPersistenceAdapterController(
      SQLITE_TURN_PERSISTENCE_ADAPTER,
      { source: 'test.turn-engine-host' },
    )
    const compactionController = createCompactionArchivePortController({
      apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
      id: 'test.turn-engine-host',
      create(input) {
        return {
          id: input.id || 'unused-archive',
          userId: input.userId,
          sessionId: input.sessionId,
          replacedMessageCount: input.archivedMessages.length,
          archivedMessages: input.archivedMessages,
          summaryText: input.summaryText,
          createdAt: 1,
        }
      },
      get() { return null },
      cleanup() { return { removed: 0 } },
    }, { source: 'test.turn-engine-host' })
    const managedAttachmentController = createManagedAttachmentRuntimePortController({
      apiVersion: MANAGED_ATTACHMENT_RUNTIME_PORT_VERSION,
      id: 'test.turn-engine-host',
      validateAttachments() { return [] },
      bindAttachments() { return [] },
      prepareAttachments() { return { attachments: [], content: '' } },
    }, { source: 'test.turn-engine-host' })
    controller.activate()
    managedAttachmentController.activate()
    compactionController.activate()

    const firstEngine = getTurnEngine()
    assert.equal(getManagedAttachmentRuntimePortStatus().activeLeases, 1)
    assert.throws(
      () => managedAttachmentController.release(),
      (error) => error?.code === 'MANAGED_ATTACHMENT_RUNTIME_PORT_IN_USE',
    )
    let configuredResolverError = null
    try {
      resolveSubagentModelBinding({ userId: 'missing-test-owner' })
    } catch (error) {
      configuredResolverError = error
    }
    assert.notEqual(
      configuredResolverError?.code,
      'SUBAGENT_MODEL_BINDING_RESOLVER_NOT_CONFIGURED',
    )
    let finishShutdown
    const shutdownGate = new Promise((resolve) => { finishShutdown = resolve })
    let synchronousShutdownReentryError = null
    firstEngine.shutdown = () => {
      try {
        getTurnEngine()
      } catch (error) {
        synchronousShutdownReentryError = error
      }
      return shutdownGate
    }
    const firstClose = closeTurnEngine()
    const secondClose = closeTurnEngine()
    assert.strictEqual(secondClose, firstClose)
    assert.throws(
      () => getTurnEngine(),
      (error) => error?.code === 'TURN_ENGINE_SHUTTING_DOWN'
        && error?.statusCode === 503
        && error?.retryable === true
        && isTurnEngineHostUnavailableError(error),
    )
    assert.equal(getTurnPersistenceAdapterStatus().engineBound, true)
    let settled = false
    secondClose.then(() => { settled = true })
    await Promise.resolve()
    assert.equal(synchronousShutdownReentryError?.code, 'TURN_ENGINE_SHUTTING_DOWN')
    assert.equal(synchronousShutdownReentryError?.statusCode, 503)
    assert.equal(synchronousShutdownReentryError?.retryable, true)
    assert.equal(settled, false)
    finishShutdown()
    await secondClose
    assert.equal(getTurnPersistenceAdapterStatus().engineBound, false)
    assert.equal(getManagedAttachmentRuntimePortStatus().activeLeases, 0)
    assert.throws(
      () => resolveSubagentModelBinding({ userId: 'missing-test-owner' }),
      (error) => error?.code === 'SUBAGENT_MODEL_BINDING_RESOLVER_NOT_CONFIGURED',
    )

    const secondEngine = getTurnEngine()
    assert.equal(getManagedAttachmentRuntimePortStatus().activeLeases, 1)
    let completedWriterCloseCalls = 0
    let retryWriterCloseCalls = 0
    let cachedFailureWriterCloseCalls = 0
    let cachedFailureWriterFlushCalls = 0
    secondEngine.eventWriters.add({
      async close() {
        completedWriterCloseCalls += 1
      },
    })
    secondEngine.eventWriters.add({
      async close() {
        retryWriterCloseCalls += 1
        if (retryWriterCloseCalls === 1) throw new Error('forced writer drain failure')
      },
    })
    const cachedCloseFailure = Promise.reject(new Error('cached writer close failure'))
    cachedCloseFailure.catch(() => {})
    secondEngine.eventWriters.add({
      close() {
        cachedFailureWriterCloseCalls += 1
        return cachedCloseFailure
      },
      async flush() {
        cachedFailureWriterFlushCalls += 1
      },
    })
    const failedClose = closeTurnEngine()
    assert.strictEqual(closeTurnEngine(), failedClose)
    await assert.rejects(failedClose, /Failed to shut down TurnEngine cleanly/)
    assert.strictEqual(getTurnEngine(), secondEngine)
    assert.equal(completedWriterCloseCalls, 1)
    assert.equal(retryWriterCloseCalls, 1)
    assert.equal(cachedFailureWriterCloseCalls, 1)
    assert.equal(cachedFailureWriterFlushCalls, 0)
    assert.equal(getTurnPersistenceAdapterStatus().engineBound, true)
    assert.equal(getCompactionArchivePortStatus().activeLeases, 1)
    assert.equal(getManagedAttachmentRuntimePortStatus().activeLeases, 1)
    assert.throws(
      () => compactionController.release(),
      (error) => error?.code === 'COMPACTION_ARCHIVE_PORT_IN_USE',
    )
    let configuredAfterFailure = null
    try {
      resolveSubagentModelBinding({ userId: 'missing-test-owner' })
    } catch (error) {
      configuredAfterFailure = error
    }
    assert.notEqual(
      configuredAfterFailure?.code,
      'SUBAGENT_MODEL_BINDING_RESOLVER_NOT_CONFIGURED',
    )

    await closeTurnEngine()
    assert.equal(completedWriterCloseCalls, 1)
    assert.equal(retryWriterCloseCalls, 2)
    assert.equal(cachedFailureWriterCloseCalls, 1)
    assert.equal(cachedFailureWriterFlushCalls, 1)
    assert.equal(getTurnPersistenceAdapterStatus().engineBound, false)
    assert.equal(getCompactionArchivePortStatus().activeLeases, 0)
    assert.equal(getManagedAttachmentRuntimePortStatus().activeLeases, 0)
    assert.throws(
      () => resolveSubagentModelBinding({ userId: 'missing-test-owner' }),
      (error) => error?.code === 'SUBAGENT_MODEL_BINDING_RESOLVER_NOT_CONFIGURED',
    )
    await closeTurnEngine()
    assert.equal(completedWriterCloseCalls, 1)
    assert.equal(retryWriterCloseCalls, 2)
    assert.equal(cachedFailureWriterCloseCalls, 1)
    assert.equal(cachedFailureWriterFlushCalls, 1)
    assert.equal(compactionController.release(), true)
    assert.equal(managedAttachmentController.release(), true)
    assert.equal(controller.release(), true)
    assert.equal(getTurnPersistenceAdapterStatus().configured, false)
  `)
  assertFreshModuleSucceeded(result)
})
