import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  resolveTurnPersistenceBootstrap,
  TURN_PERSISTENCE_MODULE_ENV,
  TURN_PERSISTENCE_TRUST_ROOT_ENV,
} from '../server/core/turnPersistenceBootstrap.js'
import {
  isBuiltinSqliteTurnPersistenceProvenance,
  resolveBuiltinSqliteTurnPersistenceBootstrap,
} from '../server/adapters/builtinSqliteTurnPersistenceBootstrap.js'
import { SQLITE_TURN_PERSISTENCE_ADAPTER } from '../server/adapters/sqliteTurnPersistenceAdapter.js'

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-persistence-bootstrap-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function adapterModuleSource(exportName = 'turnPersistenceAdapter') {
  const adapterUrl = new URL('../server/adapters/sqliteTurnPersistenceAdapter.js', import.meta.url)
  return `export { SQLITE_TURN_PERSISTENCE_ADAPTER as ${exportName} } from ${JSON.stringify(adapterUrl.href)}\n`
}

function standaloneAdapterModuleSource() {
  const section = (value) => Object.entries(value)
    .filter(([, member]) => typeof member === 'function')
    .map(([name]) => `${JSON.stringify(name)}: noOp`)
    .join(',\n    ')
  return `
const noOp = () => null

export const turnPersistenceAdapter = {
  id: 'test.external',
  contractVersion: ${SQLITE_TURN_PERSISTENCE_ADAPTER.contractVersion},
  session: {
    ${section(SQLITE_TURN_PERSISTENCE_ADAPTER.session)}
  },
  eventLog: {
    ${section(SQLITE_TURN_PERSISTENCE_ADAPTER.eventLog)}
  },
  transactions: {
    ${section(SQLITE_TURN_PERSISTENCE_ADAPTER.transactions)}
  },
  execution: {
    ${section(SQLITE_TURN_PERSISTENCE_ADAPTER.execution)}
  },
  steering: {
    ${section(SQLITE_TURN_PERSISTENCE_ADAPTER.steering)}
  },
  recovery: {
    ${section(SQLITE_TURN_PERSISTENCE_ADAPTER.recovery)}
  },
  modelRequestRecovery: {
    ${section(SQLITE_TURN_PERSISTENCE_ADAPTER.modelRequestRecovery)}
  },
  sessionAdmin: {
    contractVersion: ${SQLITE_TURN_PERSISTENCE_ADAPTER.sessionAdmin.contractVersion},
    ${section(SQLITE_TURN_PERSISTENCE_ADAPTER.sessionAdmin)}
  },
}
`
}

test('trusted persistence bootstrap validates and freezes the distribution default', async () => {
  const result = await resolveBuiltinSqliteTurnPersistenceBootstrap({ env: {} })

  assert.equal(result.adapter.id, 'builtin.sqlite')
  assert.deepEqual(result.provenance, {
    source: 'builtin',
    configured: false,
    modulePath: null,
    adapterId: 'builtin.sqlite',
    contractVersion: result.adapter.contractVersion,
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.adapter), true)
  assert.equal(Object.isFrozen(result.provenance), true)
  assert.equal(
    isBuiltinSqliteTurnPersistenceProvenance(result.provenance, result.adapter),
    true,
  )
  assert.equal(
    isBuiltinSqliteTurnPersistenceProvenance(
      Object.freeze({ ...result.provenance }),
      result.adapter,
    ),
    false,
  )
  assert.equal(
    isBuiltinSqliteTurnPersistenceProvenance(
      result.provenance,
      Object.freeze({ ...result.adapter }),
    ),
    false,
  )
  assert.equal(isBuiltinSqliteTurnPersistenceProvenance(null, null), false)
})

test('explicit trusted module is selected before the built-in adapter', async (t) => {
  const root = tempRoot(t)
  const modulePath = path.join(root, 'adapter.mjs')
  fs.writeFileSync(modulePath, adapterModuleSource(), 'utf8')
  const [canonicalModulePath, canonicalRoot] = await Promise.all([
    fs.promises.realpath(modulePath),
    fs.promises.realpath(root),
  ])
  let callerFactoryCalls = 0

  const result = await resolveBuiltinSqliteTurnPersistenceBootstrap({
    cwd: root,
    env: {
      [TURN_PERSISTENCE_MODULE_ENV]: 'adapter.mjs',
      [TURN_PERSISTENCE_TRUST_ROOT_ENV]: '.',
    },
    builtinAdapterFactory: async () => {
      callerFactoryCalls += 1
      throw new Error('caller fallback must stay unreachable')
    },
  })

  assert.equal(result.adapter.id, 'builtin.sqlite')
  assert.equal(result.provenance.source, 'module')
  assert.equal(result.provenance.configured, true)
  assert.equal(result.provenance.modulePath, canonicalModulePath)
  assert.equal(result.provenance.trustedRoot, canonicalRoot)
  assert.equal(Object.isFrozen(result.provenance), true)
  assert.equal(callerFactoryCalls, 0)
  assert.equal(
    isBuiltinSqliteTurnPersistenceProvenance(result.provenance, result.adapter),
    false,
  )
})

test('distribution bootstrap does not load SQLite when a trusted module is selected', (t) => {
  const root = tempRoot(t)
  const modulePath = path.join(root, 'external-adapter.mjs')
  const loaderPath = path.join(root, 'reject-sqlite-loader.mjs')
  fs.writeFileSync(modulePath, standaloneAdapterModuleSource(), 'utf8')
  fs.writeFileSync(loaderPath, `
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  if (result.url.endsWith('/server/adapters/sqliteTurnPersistenceAdapter.js')) {
    throw new Error('bundled SQLite adapter must stay unloaded')
  }
  return result
}
`, 'utf8')

  const bootstrapUrl = new URL(
    '../server/adapters/builtinSqliteTurnPersistenceBootstrap.js',
    import.meta.url,
  ).href
  const childSource = `
import {
  isBuiltinSqliteTurnPersistenceProvenance,
  resolveBuiltinSqliteTurnPersistenceBootstrap,
} from ${JSON.stringify(bootstrapUrl)}

const result = await resolveBuiltinSqliteTurnPersistenceBootstrap({
  cwd: ${JSON.stringify(root)},
  env: {
    ${JSON.stringify(TURN_PERSISTENCE_MODULE_ENV)}: ${JSON.stringify(modulePath)},
    ${JSON.stringify(TURN_PERSISTENCE_TRUST_ROOT_ENV)}: ${JSON.stringify(root)},
  },
})
process.stdout.write(JSON.stringify({
  adapterId: result.adapter.id,
  source: result.provenance.source,
  builtinAuthority: isBuiltinSqliteTurnPersistenceProvenance(
    result.provenance,
    result.adapter,
  ),
}))
`
  const child = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-loader',
    pathToFileURL(loaderPath).href,
    '--input-type=module',
    '--eval',
    childSource,
  ], {
    encoding: 'utf8',
    timeout: 10_000,
  })

  assert.equal(child.status, 0, child.stderr || child.stdout)
  assert.deepEqual(JSON.parse(child.stdout), {
    adapterId: 'test.external',
    source: 'module',
    builtinAuthority: false,
  })
})

test('generic built-in adapter factory is lazy and runs exactly once when selected', async () => {
  let factoryCalls = 0
  const result = await resolveTurnPersistenceBootstrap({
    env: {},
    builtinAdapterFactory: async () => {
      factoryCalls += 1
      return SQLITE_TURN_PERSISTENCE_ADAPTER
    },
  })

  assert.equal(factoryCalls, 1)
  assert.equal(result.adapter.id, 'builtin.sqlite')
  assert.equal(result.provenance.source, 'builtin')
})

test('configured module never invokes the generic built-in adapter factory', async (t) => {
  const root = tempRoot(t)
  const modulePath = path.join(root, 'adapter.mjs')
  fs.writeFileSync(modulePath, adapterModuleSource(), 'utf8')
  let factoryCalls = 0

  const result = await resolveTurnPersistenceBootstrap({
    cwd: root,
    env: { [TURN_PERSISTENCE_MODULE_ENV]: modulePath },
    builtinAdapterFactory: async () => {
      factoryCalls += 1
      throw new Error('unselected fallback must not load')
    },
  })

  assert.equal(factoryCalls, 0)
  assert.equal(result.provenance.source, 'module')
})

test('generic bootstrap cannot mint distribution-owned SQLite provenance', async () => {
  const result = await resolveTurnPersistenceBootstrap({
    builtinAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
    env: {},
  })

  assert.equal(result.provenance.source, 'builtin')
  assert.equal(
    isBuiltinSqliteTurnPersistenceProvenance(result.provenance, result.adapter),
    false,
  )
})

test('distribution bootstrap cannot be overridden with a caller-selected fallback', async () => {
  const spoofedBuiltin = Object.freeze({
    ...SQLITE_TURN_PERSISTENCE_ADAPTER,
    id: 'spoofed.sqlite',
  })
  let callerFactoryCalls = 0
  const result = await resolveBuiltinSqliteTurnPersistenceBootstrap({
    env: {},
    builtinAdapter: spoofedBuiltin,
    builtinAdapterFactory: async () => {
      callerFactoryCalls += 1
      return spoofedBuiltin
    },
  })

  assert.equal(callerFactoryCalls, 0)
  assert.equal(result.adapter.id, 'builtin.sqlite')
  assert.equal(
    isBuiltinSqliteTurnPersistenceProvenance(result.provenance, result.adapter),
    true,
  )
})

test('trusted persistence module may use the default export', async (t) => {
  const root = tempRoot(t)
  const modulePath = path.join(root, 'default-adapter.mjs')
  fs.writeFileSync(modulePath, adapterModuleSource('default'), 'utf8')

  const result = await resolveTurnPersistenceBootstrap({
    cwd: root,
    env: { [TURN_PERSISTENCE_MODULE_ENV]: modulePath },
  })
  assert.equal(result.adapter.id, 'builtin.sqlite')
  assert.equal(result.provenance.source, 'module')
})

test('explicit module outside the canonical trust root fails closed', async (t) => {
  const root = tempRoot(t)
  const trusted = path.join(root, 'trusted')
  const outside = path.join(root, 'outside.mjs')
  fs.mkdirSync(trusted)
  fs.writeFileSync(outside, adapterModuleSource(), 'utf8')

  await assert.rejects(resolveTurnPersistenceBootstrap({
    cwd: trusted,
    trustedRoot: trusted,
    env: { [TURN_PERSISTENCE_MODULE_ENV]: outside },
  }), (error) => error?.code === 'TURN_PERSISTENCE_BOOTSTRAP_MODULE_OUTSIDE_TRUST_ROOT'
    && error?.retryable === false)
})

test('URLs, missing files, and directories cannot become persistence modules', async (t) => {
  const root = tempRoot(t)
  for (const configured of ['https://example.test/adapter.mjs', 'file:///adapter.mjs', 'missing.mjs', '.']) {
    await assert.rejects(resolveTurnPersistenceBootstrap({
      cwd: root,
      env: { [TURN_PERSISTENCE_MODULE_ENV]: configured },
    }), (error) => error?.code === 'TURN_PERSISTENCE_BOOTSTRAP_MODULE_INVALID')
  }
})

test('explicit module import and export failures never fall back to the built-in adapter', async (t) => {
  const root = tempRoot(t)
  const invalid = path.join(root, 'invalid.mjs')
  const throwing = path.join(root, 'throwing.mjs')
  fs.writeFileSync(invalid, 'export const value = 1\n', 'utf8')
  fs.writeFileSync(throwing, 'throw new Error("module failed")\n', 'utf8')

  await assert.rejects(resolveTurnPersistenceBootstrap({
    cwd: root,
    env: { [TURN_PERSISTENCE_MODULE_ENV]: invalid },
    builtinAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
  }), (error) => error?.code === 'TURN_PERSISTENCE_BOOTSTRAP_EXPORT_INVALID')

  await assert.rejects(resolveTurnPersistenceBootstrap({
    cwd: root,
    env: { [TURN_PERSISTENCE_MODULE_ENV]: throwing },
    builtinAdapter: SQLITE_TURN_PERSISTENCE_ADAPTER,
  }), (error) => error?.code === 'TURN_PERSISTENCE_BOOTSTRAP_IMPORT_FAILED'
    && error?.cause?.message === 'module failed')
})

test('module exports are read only as own data properties and adapters are fully validated', async (t) => {
  const root = tempRoot(t)
  const modulePath = path.join(root, 'placeholder.mjs')
  fs.writeFileSync(modulePath, 'export default null\n', 'utf8')
  const canonicalModuleUrl = pathToFileURL(await fs.promises.realpath(modulePath)).href
  let getterCalls = 0
  const namespace = {}
  Object.defineProperty(namespace, 'turnPersistenceAdapter', {
    enumerable: true,
    get() {
      getterCalls += 1
      return SQLITE_TURN_PERSISTENCE_ADAPTER
    },
  })

  await assert.rejects(resolveTurnPersistenceBootstrap({
    cwd: root,
    env: { [TURN_PERSISTENCE_MODULE_ENV]: modulePath },
    importModule: async (specifier) => {
      assert.equal(specifier, canonicalModuleUrl)
      return namespace
    },
  }), (error) => error?.code === 'TURN_PERSISTENCE_BOOTSTRAP_EXPORT_INVALID')
  assert.equal(getterCalls, 0)

  await assert.rejects(resolveTurnPersistenceBootstrap({
    cwd: root,
    env: { [TURN_PERSISTENCE_MODULE_ENV]: modulePath },
    importModule: async () => ({ turnPersistenceAdapter: { id: 'partial' } }),
  }), (error) => error?.code === 'TURN_PERSISTENCE_BOOTSTRAP_ADAPTER_INVALID'
    && error?.cause?.code === 'TURN_PERSISTENCE_ADAPTER_INVALID')
})

test('missing default adapter and malformed bootstrap values fail closed', async () => {
  await assert.rejects(resolveTurnPersistenceBootstrap({ env: {} }), (error) => (
    error?.code === 'TURN_PERSISTENCE_BOOTSTRAP_BUILTIN_REQUIRED'
  ))
  for (const value of [' adapter.mjs', 'adapter.mjs ', 'https://example.test/module']) {
    await assert.rejects(resolveTurnPersistenceBootstrap({
      env: { [TURN_PERSISTENCE_MODULE_ENV]: value },
    }), (error) => [
      'TURN_PERSISTENCE_BOOTSTRAP_CONFIG_INVALID',
      'TURN_PERSISTENCE_BOOTSTRAP_MODULE_INVALID',
    ].includes(error?.code))
  }
})
