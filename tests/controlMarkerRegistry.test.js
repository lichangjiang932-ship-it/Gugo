/**
 * Registry integrity for host→model control markers.
 *
 * Division of labour with `tests/loopMarkers.test.js`:
 *   - that test owns the *wire* invariants inside `server/services/loop` (every marker
 *     is a named constant, every bracketed literal occurs exactly once, shape is valid);
 *   - this test owns the *set*: the registry enumerates every marker under the whole
 *     `server/` tree, pins a growth ceiling, and requires an owner and purpose per entry.
 * Neither duplicates the other's assertions.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  CONTROL_MARKER_COUNT_BASELINE,
  CONTROL_MARKER_NAMES,
  CONTROL_MARKER_PREFIX_NAMES,
  CONTROL_MARKER_REGISTRY,
  controlMarkerByName,
  isControlMarkerName,
} from '../server/services/loop/controlMarkers.js'

const repoRoot = path.resolve(import.meta.dirname, '..')
const SCAN_ROOT = path.join(repoRoot, 'server')
const REGISTRY_RELATIVE_PATH = 'server/services/loop/controlMarkers.js'
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])
const MARKER_DEFINITION_PATTERN = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_MARKER)\s*=\s*'(\[[^']*)'/

function collectSourceFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, found)
    else if (/\.(?:js|jsx)$/.test(entry.name)) found.push(full)
  }
  return found
}

function collectMarkerDefinitions() {
  const definitions = new Map()
  for (const file of collectSourceFiles(SCAN_ROOT)) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/')
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const match = line.match(MARKER_DEFINITION_PATTERN)
        if (!match) return
        assert.equal(definitions.has(match[1]), false, `marker ${match[1]} is defined twice (again at ${relative}:${index + 1})`)
        definitions.set(match[1], { file: relative, line: index + 1 })
      })
  }
  return definitions
}

const definitions = collectMarkerDefinitions()

test('the registry enumerates every control marker defined under server/, and nothing more', () => {
  const defined = [...definitions.keys()].sort()
  const registered = [...CONTROL_MARKER_NAMES].sort()
  assert.deepEqual(defined.filter((name) => !registered.includes(name)), [], 'register every new control marker in controlMarkers.js')
  assert.deepEqual(registered.filter((name) => !defined.includes(name)), [], 'remove registry entries whose definition no longer exists')
})

test('each registry entry points at the file that really defines it', () => {
  for (const entry of CONTROL_MARKER_REGISTRY) {
    const definition = definitions.get(entry.name)
    assert.ok(definition, `missing definition for ${entry.name}`)
    assert.equal(entry.definedIn, definition.file, `${entry.name} claims ${entry.definedIn} but is defined in ${definition.file}:${definition.line}`)
  }
})

test('the control marker set cannot grow past the registered baseline', () => {
  assert.equal(
    CONTROL_MARKER_REGISTRY.length,
    CONTROL_MARKER_COUNT_BASELINE,
    'register the new marker and raise CONTROL_MARKER_COUNT_BASELINE deliberately',
  )
  assert.ok(
    definitions.size <= CONTROL_MARKER_COUNT_BASELINE,
    `found ${definitions.size} marker definitions under server/ but the baseline is ${CONTROL_MARKER_COUNT_BASELINE}`,
  )
})

test('every registry entry has an owner, a purpose and a valid constant name', () => {
  for (const entry of CONTROL_MARKER_REGISTRY) {
    assert.ok(existsSync(path.join(repoRoot, entry.definedIn)), `${entry.name} definedIn does not exist: ${entry.definedIn}`)
    assert.ok(isControlMarkerName(entry.name), `${entry.name} must be a *_MARKER constant name`)
    assert.equal(typeof entry.purpose, 'string', `${entry.name} is missing a purpose`)
    assert.ok(entry.purpose.length >= 24, `${entry.name} purpose is too short to be actionable`)
  }
  assert.equal(new Set(CONTROL_MARKER_NAMES).size, CONTROL_MARKER_NAMES.length, 'duplicate constant name in the registry')
})

test('markers flagged unused really have no consumer outside their definition', () => {
  // The registry currently flags none (the last one was deleted on 2026-09-17); the
  // check stays so a future `status: 'unused'` entry cannot quietly become stale.
  const unused = CONTROL_MARKER_REGISTRY.filter((entry) => entry.status === 'unused')
  for (const entry of unused) {
    for (const file of collectSourceFiles(SCAN_ROOT)) {
      const relative = path.relative(repoRoot, file).split(path.sep).join('/')
      // This registry names every marker, so it always mentions an unused one by name.
      if (relative === entry.definedIn || relative === REGISTRY_RELATIVE_PATH) continue
      const occurrences = readFileSync(file, 'utf8').split(new RegExp(`\\b${entry.name}\\b`)).length - 1
      assert.equal(occurrences, 0, `${entry.name} is flagged unused but is referenced by ${relative}`)
    }
  }
})

test('prefix markers are listed exactly once and resolve by name', () => {
  for (const name of CONTROL_MARKER_PREFIX_NAMES) {
    assert.ok(CONTROL_MARKER_NAMES.includes(name), `${name} is not registered`)
    assert.ok(definitions.has(name), `${name} has no definition`)
  }
  assert.equal(new Set(CONTROL_MARKER_PREFIX_NAMES).size, CONTROL_MARKER_PREFIX_NAMES.length)
  assert.equal(controlMarkerByName('REPEAT_CALL_GUARD_MARKER')?.definedIn, 'server/services/loop/heuristics/constants.js')
  assert.equal(controlMarkerByName('MISSING_MARKER'), null)
})
