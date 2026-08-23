import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse } from 'acorn'

import * as modelProxy from '../server/adapters/modelProxy.js'
import * as modelRuntimeCatalog from '../server/adapters/modelRuntimeCatalog.js'

const FACADE_EXPORTS = Object.freeze([
  'getModelContextWindow',
  'getModelStatus',
  'getSystemDiagnostics',
  'getToolMaxRounds',
  'getVisibleModels',
  'hasVisionContent',
  'supportsToolsModel',
  'supportsVisionModel',
])

test('modelProxy keeps identity-preserving catalog facade exports', () => {
  for (const name of FACADE_EXPORTS) {
    assert.equal(modelProxy[name], modelRuntimeCatalog[name], name)
  }
  assert.equal(Object.hasOwn(modelProxy, 'pickAllowedModel'), false)
})

function readStaticImports(file) {
  const source = fs.readFileSync(file, 'utf8')
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  return program.body.flatMap((node) => {
    if (node.type === 'ImportDeclaration') return [node.source.value]
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      return [node.source.value]
    }
    return []
  })
}

function collectStaticModuleGraph(entry) {
  const pending = [path.resolve(entry)]
  const visited = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file)) continue
    visited.add(file)
    for (const specifier of readStaticImports(file)) {
      if (!specifier.startsWith('.')) continue
      const resolved = path.resolve(path.dirname(file), specifier)
      pending.push(path.extname(resolved) ? resolved : `${resolved}.js`)
    }
  }
  return [...visited]
}

test('model runtime catalog static dependency graph remains free of IO and host layers', () => {
  const entry = fileURLToPath(new URL('../server/adapters/modelRuntimeCatalog.js', import.meta.url))
  const repoRoot = path.resolve(path.dirname(entry), '..', '..')
  const graph = collectStaticModuleGraph(entry)
    .map((file) => path.relative(repoRoot, file).replaceAll('\\', '/'))
    .sort()

  for (const forbidden of [
    'server/db.js',
    'server/middleware.js',
    'server/services/',
    'server/routes/',
    'server/adapters/modelEndpoint.js',
    'server/adapters/modelRequestBuilder.js',
    'server/adapters/modelRequestTransport.js',
    'server/adapters/modelProxyResponseCoordinator.js',
    'server/adapters/modelSystemDiagnostics.js',
    'server/adapters/proxyFetch.js',
    'server/utils/outboundNetworkGuard.js',
    'server/utils/runtimeEnv.js',
  ]) {
    assert.equal(
      graph.some((file) => file === forbidden || file.startsWith(forbidden)),
      false,
      `${forbidden}\n${graph.join('\n')}`,
    )
  }
})
