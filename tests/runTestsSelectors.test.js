import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('..', import.meta.url))
const runner = path.join(repository, 'scripts', 'run-tests.js')
const valid = 'tests/contextUsage.test.js'
const missing = 'tests/cli/missing-selector-regression.test.js'

function preload(forbidSpawn) {
  return `data:text/javascript,${encodeURIComponent(`
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const create = fs.mkdtempSync;
    fs.mkdtempSync = (...args) => { process.stdout.write('ROOT_CREATED\\n'); return create(...args); };
    const spawn = childProcess.spawn;
    childProcess.spawn = (...args) => {
      process.stdout.write('WORKER_STARTED\\n');
      if (${JSON.stringify(forbidSpawn)}) process.exit(97);
      return spawn(...args);
    };
    syncBuiltinESMExports();
  `)}`
}

function run(t, args, { forbidSpawn = true, emptyWorkspace = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'gugo-selector-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const scratch = path.join(directory, 'tmp')
  mkdirSync(scratch)
  if (emptyWorkspace) mkdirSync(path.join(directory, 'tests'))
  const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--import', preload(forbidSpawn), runner, ...args], {
    cwd: emptyWorkspace ? directory : repository, env, encoding: 'utf8', timeout: 15000,
  })
  return { result, output: `${result.stdout || ''}\n${result.stderr || ''}`, scratch }
}

function rejectedBeforeWork(state, code) {
  assert.equal(state.result.error, undefined, state.output)
  assert.equal(state.result.status, 2, state.output)
  assert.match(state.output, new RegExp(code, 'u'))
  assert.doesNotMatch(state.output, /WORKER_STARTED|ROOT_CREATED|starting batch|final result: PASS/u)
  assert.deepEqual(readdirSync(state.scratch), [])
}

test('missing test files fail before worker launch or test data root creation', (t) => {
  rejectedBeforeWork(run(t, [missing]), 'TEST_SELECTOR_NOT_FOUND')
})

test('a missing selector invalidates a mixed selection before any valid file runs', (t) => {
  rejectedBeforeWork(run(t, [valid, missing]), 'TEST_SELECTOR_NOT_FOUND')
})

test('duplicate files, Windows slashes, dot paths and absolute paths execute and count once', (t) => {
  const state = run(t, [valid, valid.replaceAll('/', '\\'), `./${valid}`, path.join(repository, valid)], { forbidSpawn: false })
  assert.equal(state.result.status, 0, state.output)
  assert.match(state.output, /final result: PASS \(1 test file\(s\)\)/u)
  assert.equal((state.output.match(/WORKER_STARTED/gu) || []).length, 1)
  assert.equal((state.output.match(/# Subtest: client token estimate charges non-ASCII/gu) || []).length, 1)
  assert.deepEqual(readdirSync(state.scratch), [])
})

test('glob syntax is explicitly rejected whether it would match a file or not', (t) => {
  for (const selector of ['tests/contextUsage.test.*', 'tests/not-present-*.test.js', 'tests/@(contextUsage).test.js']) {
    rejectedBeforeWork(run(t, [selector]), 'TEST_SELECTOR_PATTERN_UNSUPPORTED')
  }
})

test('directory selectors are rejected instead of inheriting implicit Node discovery/counting', (t) => {
  rejectedBeforeWork(run(t, ['tests/cli']), 'TEST_SELECTOR_NOT_FILE')
})

test('empty automatic discovery is an error, not PASS zero files', (t) => {
  rejectedBeforeWork(run(t, [], { emptyWorkspace: true }), 'TEST_SELECTOR_EMPTY')
})

test('short filename aliases retain explicit-file compatibility', (t) => {
  const state = run(t, ['contextUsage', 'contextUsage.test.js'], { forbidSpawn: false })
  assert.equal(state.result.status, 0, state.output)
  assert.match(state.output, /final result: PASS \(1 test file\(s\)\)/u)
})

test('invalid offline flags also stop before test root allocation', (t) => {
  rejectedBeforeWork(run(t, ['--eval-unknown', valid]), 'unknown offline eval option')
})
