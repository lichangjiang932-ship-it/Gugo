import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const setupUrl = pathToFileURL(path.resolve('scripts/testEnvironment.mjs')).href
const emergencyJournalUrl = pathToFileURL(
  path.resolve('server/services/turnEmergencyFailureJournal.js'),
).href
const RESET_ENV_KEYS = [
  'YMA_TEST_DATA_ROOT',
  'APP_DATA_DIR',
  'APP_DB_PATH',
  'ARTIFACT_DIR',
  'YMA_TEST_DEFAULT_OUTPUT_DIR',
]
const TEST_ENV_KEYS = [
  ...RESET_ENV_KEYS,
  'TMPDIR',
  'TMP',
  'TEMP',
]

function runSetup({ cwd, root } = {}) {
  const env = { ...process.env }
  for (const key of RESET_ENV_KEYS) delete env[key]
  if (root) env.YMA_TEST_DATA_ROOT = root
  const source = `
    await import(${JSON.stringify(setupUrl)});
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { resolveTurnEmergencyFailureLogPaths } = await import(${JSON.stringify(emergencyJournalUrl)});
    const snapshot = Object.fromEntries(${JSON.stringify(TEST_ENV_KEYS)}.map((key) => [key, process.env[key]]));
    snapshot.pathsExist = ['APP_DATA_DIR', 'ARTIFACT_DIR', 'YMA_TEST_DEFAULT_OUTPUT_DIR']
      .every((key) => fs.existsSync(snapshot[key]));
    snapshot.dbParentExists = fs.existsSync(path.dirname(snapshot.APP_DB_PATH));
    snapshot.osTempDir = os.tmpdir();
    snapshot.emergencyJournalPaths = resolveTurnEmergencyFailureLogPaths();
    process.stdout.write(JSON.stringify(snapshot));
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd,
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function assertIsolated(snapshot, checkout) {
  assert.equal(snapshot.pathsExist, true)
  assert.equal(snapshot.dbParentExists, true)
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    assert.equal(path.resolve(snapshot[key]), path.resolve(snapshot.APP_DATA_DIR), key)
  }
  assert.equal(path.resolve(snapshot.osTempDir), path.resolve(snapshot.APP_DATA_DIR))
  assert.deepEqual(snapshot.emergencyJournalPaths, [
    path.join(snapshot.APP_DATA_DIR, 'turn-emergency-failures.jsonl'),
    path.join(snapshot.APP_DATA_DIR, 'gugo-turn-emergency-failures.jsonl'),
  ])
  for (const key of ['APP_DATA_DIR', 'APP_DB_PATH', 'ARTIFACT_DIR', 'YMA_TEST_DEFAULT_OUTPUT_DIR']) {
    assert.equal(path.isAbsolute(snapshot[key]), true, key)
    const relative = path.relative(checkout, snapshot[key])
    const insideCheckout = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    assert.equal(insideCheckout, false, key)
    assert.notEqual(snapshot[key], 'undefined', key)
  }
}

test('test setup isolates direct imports and removes its owned temporary root', () => {
  const checkout = process.cwd()
  const directCwd = mkdtempSync(path.join(tmpdir(), 'gugo-test-env-cwd-'))
  try {
    const snapshot = runSetup({ cwd: directCwd })
    assertIsolated(snapshot, checkout)
    assert.equal(existsSync(snapshot.YMA_TEST_DATA_ROOT), false)
  } finally {
    rmSync(directCwd, { recursive: true, force: true })
  }
})

test('test setup keeps wrapper-owned roots while isolating every generated path', () => {
  const checkout = process.cwd()
  const wrapperRoot = mkdtempSync(path.join(tmpdir(), 'gugo-test-env-wrapper-'))
  try {
    const snapshot = runSetup({ cwd: checkout, root: wrapperRoot })
    assertIsolated(snapshot, checkout)
    assert.equal(path.resolve(snapshot.YMA_TEST_DATA_ROOT), path.resolve(wrapperRoot))
    assert.equal(existsSync(wrapperRoot), true)
  } finally {
    rmSync(wrapperRoot, { recursive: true, force: true })
  }
})
