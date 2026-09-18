import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LOOP_RUNTIME_DEPENDENCY_MANIFEST,
} from '../server/services/loop/dependencyBagManifest.js'
import {
  RUNTIME_DEPENDENCY_KINDS,
  DECLARED_RUNTIME_DEPENDENCIES,
  REQUIRED_RUNTIME_DEPENDENCIES,
  inspectRuntimeDependencies,
} from '../server/services/loop/dependencyBagContract.js'
import {
  LOOP_RUNTIME_CONTRACT_ERROR_CODE,
  assertRuntimeDependencies,
} from '../server/services/loop/runtimeContract.js'
import { prepareToolsLoopRuntime } from '../server/services/loop/runtime.js'
import { buildManifest } from '../scripts/generate-loop-dependency-manifest.mjs'

// The loop kernel hands every phase one shared dependency bag (`s.d`). Phases
// consume it through property access, literal string index access and
// destructuring (including aliases, defaults and nested patterns). A cleanup
// that only counts one form concludes that the others are dead and deletes
// them; the object literal still parses, so the failure only surfaces mid-turn
// when a phase destructures `undefined` and calls it. These tests pin both the
// consumption forms and the runtime boundary against the real source.

const SAMPLE_VALUES = Object.freeze({
  function: () => {},
  string: '',
  number: 0,
  boolean: true,
  symbol: Symbol('dependency'),
  set: new Set(),
  map: new Map(),
  regexp: /x/u,
  array: [],
  object: {},
  bigint: 0n,
})

function syntheticBag({ omit = [], override = {} } = {}) {
  const bag = {}
  for (const [name, kind] of Object.entries(RUNTIME_DEPENDENCY_KINDS)) {
    if (omit.includes(name)) continue
    bag[name] = SAMPLE_VALUES[kind] ?? (() => {})
  }
  return { ...bag, ...override }
}

test('the committed dependency manifest matches the real loop source', () => {
  const manifest = buildManifest()
  assert.deepEqual(manifest.unresolved, [], 'state-bag access must be statically resolvable')
  assert.deepEqual(
    [...LOOP_RUNTIME_DEPENDENCY_MANIFEST.required],
    manifest.required,
    'dependencyBagManifest.js is stale; run node scripts/generate-loop-dependency-manifest.mjs',
  )
  assert.deepEqual([...LOOP_RUNTIME_DEPENDENCY_MANIFEST.declared], manifest.declared)
})

test('every dependency the loop phases consume is declared in the bag', () => {
  const consumed = new Set(REQUIRED_RUNTIME_DEPENDENCIES)
  const declared = new Set(DECLARED_RUNTIME_DEPENDENCIES)
  const missing = [...consumed].filter((name) => !declared.has(name)).sort()
  assert.deepEqual(
    missing,
    [],
    'These symbols are consumed via s.d but absent from runtimeDependencies. '
      + 'Destructured consumption counts: do not delete a bag entry without running this audit.',
  )
})

test('the bag has no dead entries and no duplicates', () => {
  const declared = [...DECLARED_RUNTIME_DEPENDENCIES]
  const duplicates = declared.filter((name, index) => declared.indexOf(name) !== index)
  assert.deepEqual([...new Set(duplicates)], [], 'runtimeDependencies must not repeat a key')

  const required = new Set(REQUIRED_RUNTIME_DEPENDENCIES)
  const dead = declared.filter((name) => !required.has(name)).sort()
  assert.deepEqual(
    dead,
    [],
    'These runtimeDependencies entries are never consumed by any phase. '
      + 'Remove them instead of keeping a dead bag entry.',
  )
})

test('every required dependency has a verified kind, and no kind entry is stale', () => {
  const required = new Set(REQUIRED_RUNTIME_DEPENDENCIES)
  const missingKinds = [...required].filter((name) => !RUNTIME_DEPENDENCY_KINDS[name]).sort()
  assert.deepEqual(missingKinds, [], 'every required dependency needs an expected kind')
  const staleKinds = Object.keys(RUNTIME_DEPENDENCY_KINDS)
    .filter((name) => !required.has(name))
    .sort()
  assert.deepEqual(staleKinds, [], 'RUNTIME_DEPENDENCY_KINDS must not describe removed symbols')
})

test('the boundary rejects an incomplete bag before touching the host context', async () => {
  const omitted = 'extractTextToolCalls'
  const bag = syntheticBag({ omit: [omitted] })
  const inspection = inspectRuntimeDependencies(bag)
  assert.equal(inspection.ok, false)
  assert.equal(inspection.stage, 'runtime-dependencies')
  assert.ok(inspection.missingFields.includes(omitted))

  let contextTouched = false
  const context = new Proxy({}, {
    get() { contextTouched = true; throw new Error('context must not be touched') },
  })
  await assert.rejects(
    prepareToolsLoopRuntime(context, bag),
    (error) => {
      assert.equal(error?.code, LOOP_RUNTIME_CONTRACT_ERROR_CODE)
      assert.equal(error?.stage, 'runtime-dependencies')
      assert.deepEqual(error?.missingFields, [omitted])
      return true
    },
  )
  assert.equal(contextTouched, false, 'the dependency gate must run before any host side effect')
})

test('the boundary rejects a wrong-kind dependency instead of treating it as a function', async () => {
  const bag = syntheticBag({ override: { MAX_ITERS: () => 2000 } })
  const inspection = inspectRuntimeDependencies(bag)
  assert.equal(inspection.ok, false)
  assert.ok(inspection.invalidFields.includes('MAX_ITERS'))
  assert.equal(inspection.expectedKinds.MAX_ITERS, 'number')

  assert.throws(
    () => assertRuntimeDependencies(bag),
    (error) => {
      assert.equal(error?.code, LOOP_RUNTIME_CONTRACT_ERROR_CODE)
      assert.ok(error?.invalidFields.includes('MAX_ITERS'))
      return true
    },
  )
})

test('the boundary rejects unknown bag keys so accidental drift is visible', () => {
  const bag = { ...syntheticBag(), notARealDependency: () => {} }
  const inspection = inspectRuntimeDependencies(bag)
  assert.equal(inspection.ok, false)
  assert.deepEqual(inspection.unexpectedFields, ['notARealDependency'])
})

test('a complete bag with correct kinds passes the boundary inspection', () => {
  assert.deepEqual(inspectRuntimeDependencies(syntheticBag()), { ok: true })
})

test('the core bootstrap schema still fails closed on an empty bag', () => {
  assert.throws(
    () => assertRuntimeDependencies({}),
    (error) => {
      assert.equal(error?.code, LOOP_RUNTIME_CONTRACT_ERROR_CODE)
      assert.equal(error?.stage, 'runtime-dependencies')
      assert.ok(error?.missingFields.includes('createCheckpointBarrier'))
      return true
    },
  )
})
