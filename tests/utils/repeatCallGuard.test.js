import test from 'node:test'
import assert from 'node:assert/strict'
import { createRepeatCallGuard } from '../../server/utils/repeatCallGuard.js'

test('fires a gentle reminder at the first threshold and escalates later', () => {
  const guard = createRepeatCallGuard()
  assert.equal(guard.record('read_file', { path: 'a.js' }), null)
  assert.equal(guard.record('read_file', { path: 'a.js' }), null)
  const first = guard.record('read_file', { path: 'a.js' })
  assert.ok(first)
  assert.equal(first.count, 3)
  assert.equal(first.first, true)
  assert.match(first.content, /read_file/)

  assert.equal(guard.record('read_file', { path: 'a.js' }), null)
  const fifth = guard.record('read_file', { path: 'a.js' })
  assert.ok(fifth)
  assert.equal(fifth.first, false)
  assert.match(fifth.content, /5 times/)
})

test('a different call resets the chain', () => {
  const guard = createRepeatCallGuard()
  guard.record('grep_code', { pattern: 'x' })
  guard.record('grep_code', { pattern: 'x' })
  guard.record('grep_code', { pattern: 'y' })
  assert.equal(guard.record('grep_code', { pattern: 'x' }), null)
  guard.record('grep_code', { pattern: 'x' })
  const third = guard.record('grep_code', { pattern: 'x' })
  assert.ok(third)
})

test('excluded bookkeeping tools are transparent to the chain', () => {
  const guard = createRepeatCallGuard()
  guard.record('grep_code', { pattern: 'x' })
  guard.record('manage_todos', { todos: [] })
  guard.record('grep_code', { pattern: 'x' })
  const third = guard.record('grep_code', { pattern: 'x' })
  assert.ok(third)
})

test('argument key order does not affect identity', () => {
  const guard = createRepeatCallGuard()
  guard.record('bash_exec', { command: 'npm test', cwd: '.' })
  guard.record('bash_exec', { cwd: '.', command: 'npm test' })
  const third = guard.record('bash_exec', { command: 'npm test', cwd: '.' })
  assert.ok(third)
})

test('reset clears both chain and fired reminders', () => {
  const guard = createRepeatCallGuard()
  guard.record('read_file', { path: 'a.js' })
  guard.record('read_file', { path: 'a.js' })
  guard.reset()
  assert.equal(guard.record('read_file', { path: 'a.js' }), null)
  guard.record('read_file', { path: 'a.js' })
  const third = guard.record('read_file', { path: 'a.js' })
  assert.ok(third)
})
