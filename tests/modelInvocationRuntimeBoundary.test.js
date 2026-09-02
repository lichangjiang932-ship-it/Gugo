import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse } from 'acorn'

import * as invocationRuntime from '../server/adapters/modelInvocationRuntime.js'
import * as modelProxy from '../server/adapters/modelProxy.js'

const INVOCATION_EXPORTS = Object.freeze([
  'callBackgroundModel',
  'callBackgroundModelWithTools',
  'callStreamingModelWithTools',
  'createBoundBackgroundModelCaller',
])

const proxySourceUrl = new URL('../server/adapters/modelProxy.js', import.meta.url)
const runtimeSourceUrl = new URL('../server/adapters/modelInvocationRuntime.js', import.meta.url)
const httpSourceUrl = new URL('../server/adapters/modelProxyHttp.js', import.meta.url)
const proxySourcePath = fileURLToPath(proxySourceUrl)
const runtimeSourcePath = fileURLToPath(runtimeSourceUrl)
const httpSourcePath = fileURLToPath(httpSourceUrl)
const repoRoot = path.resolve(path.dirname(runtimeSourcePath), '..', '..')

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

function resolveStaticLocalImport(file, specifier) {
  if (!specifier.startsWith('.')) return null
  const resolved = path.resolve(path.dirname(file), specifier)
  return path.extname(resolved) ? resolved : `${resolved}.js`
}

function collectStaticDependencyParents(entry) {
  const parents = new Map([[path.resolve(entry), null]])
  const pending = [path.resolve(entry)]
  while (pending.length) {
    const file = pending.pop()
    for (const specifier of readStaticImports(file)) {
      const dependency = resolveStaticLocalImport(file, specifier)
      if (!dependency || parents.has(dependency)) continue
      parents.set(dependency, file)
      pending.push(dependency)
    }
  }
  return parents
}

function dependencyPath(parents, target) {
  const chain = []
  for (let file = target; file; file = parents.get(file)) chain.push(file)
  return chain.reverse().map((file) => path.relative(repoRoot, file).replaceAll('\\', '/'))
}

test('modelProxy preserves invocation export identity through its compatibility facade', () => {
  for (const name of INVOCATION_EXPORTS) {
    assert.strictEqual(modelProxy[name], invocationRuntime[name], name)
  }
})

test('modelProxy is composition-only and invocation orchestration stays statically below it', () => {
  const proxySource = fs.readFileSync(proxySourceUrl, 'utf8')
  const runtimeSource = fs.readFileSync(runtimeSourceUrl, 'utf8')

  assert.ok(
    proxySource.split(/\r?\n/u).length <= 100,
    'Keep the model proxy compatibility facade thin',
  )
  assert.match(proxySource, /from ['"]\.\/modelInvocationRuntime\.js['"]/u)
  assert.match(proxySource, /createModelProxyHttpAdapter\(\{/u)
  for (const implementationToken of [
    'export async function callBackgroundModel',
    'export async function callBackgroundModelWithTools',
    'export async function callStreamingModelWithTools',
    'function createProviderAttemptTracker',
    'fetchWithTimeout(',
    'for await (',
  ]) {
    assert.equal(
      proxySource.includes(implementationToken),
      false,
      `Invocation concern leaked into modelProxy: ${implementationToken}`,
    )
    assert.equal(
      runtimeSource.includes(implementationToken),
      true,
      `Invocation runtime lost expected concern: ${implementationToken}`,
    )
  }
  const dependencyParents = collectStaticDependencyParents(runtimeSourcePath)
  for (const forbidden of [proxySourcePath, httpSourcePath]) {
    const found = dependencyParents.has(forbidden)
    assert.equal(
      found,
      false,
      `Invocation runtime has a forbidden static dependency:\n${
        found ? dependencyPath(dependencyParents, forbidden).join(' -> ') : ''
      }`,
    )
  }
})
