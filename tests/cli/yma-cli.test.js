import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const CLI = join(process.cwd(), 'bin', 'yma-cli.js')

function run(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'yma-cli-test-'))
  try {
    return {
      ...spawnSync('node', [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, ...env },
      }),
      home,
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('--help prints usage and exits 0', () => {
  const r = run(['--help'])
  assert.equal(r.status, 0)
  assert.ok(r.stdout.length > 0)
  assert.match(r.stdout, /yma-cli/)
  assert.match(r.stdout, /session list/)
  assert.match(r.stdout, /agent list/)
  assert.match(r.stdout, /skill list/)
})

test('no args prints help', () => {
  const r = run([])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Usage:/)
})

test('session list without token exits non-zero with login hint', () => {
  const r = run(['session', 'list'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /login/i)
})

test('agent list without token exits non-zero', () => {
  const r = run(['agent', 'list'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /login/i)
})

test('unknown command exits non-zero', () => {
  const r = run(['nope'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Unknown command/)
})

test('login without --email exits non-zero', () => {
  const r = run(['login'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /email/i)
})
