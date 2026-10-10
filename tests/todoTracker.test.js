import assert from 'node:assert/strict'
import test from 'node:test'
import { trackTodos, getTodoStatuses, clearTodos } from '../server/services/todoTracker.js'

test('records a todo update and reports no drift for forward progress', () => {
  clearTodos('session-a')
  const first = trackTodos('session-a', [
    { content: 'write the parser', status: 'pending' },
    { content: 'add tests', status: 'pending' },
  ])
  assert.equal(first.regressions.length, 0)

  // pending → in_progress → completed is ordinary forward movement.
  const second = trackTodos('session-a', [
    { content: 'write the parser', status: 'completed' },
    { content: 'add tests', status: 'in_progress' },
  ])
  assert.equal(second.regressions.length, 0)
  assert.equal(getTodoStatuses('session-a').get('write the parser'), 'completed')
})

test('flags a completed todo that regresses to unfinished', () => {
  clearTodos('session-b')
  trackTodos('session-b', [{ content: 'ship it', status: 'completed' }])
  const drift = trackTodos('session-b', [{ content: 'ship it', status: 'in_progress' }])
  assert.equal(drift.regressions.length, 1)
  assert.deepEqual(drift.regressions[0], { content: 'ship it', from: 'completed', to: 'in_progress' })
})

test('a regression that returns to completed on the next update is clean again', () => {
  clearTodos('session-c')
  trackTodos('session-c', [{ content: 'task', status: 'completed' }])
  trackTodos('session-c', [{ content: 'task', status: 'pending' }]) // drift
  const fixed = trackTodos('session-c', [{ content: 'task', status: 'completed' }])
  assert.equal(fixed.regressions.length, 0, 'the prior drift does not repeat once completed again')
})

test('tracking is isolated per session', () => {
  clearTodos('s1')
  clearTodos('s2')
  trackTodos('s1', [{ content: 'shared', status: 'completed' }])
  // s2 never recorded 'shared' as completed, so finishing it is not a regression.
  const other = trackTodos('s2', [{ content: 'shared', status: 'pending' }])
  assert.equal(other.regressions.length, 0)
  // s1 sees the regression when its own completed todo moves back.
  const s1 = trackTodos('s1', [{ content: 'shared', status: 'pending' }])
  assert.equal(s1.regressions.length, 1)
})

test('clearTodos drops tracked state', () => {
  clearTodos('session-d')
  trackTodos('session-d', [{ content: 'x', status: 'completed' }])
  assert.equal(getTodoStatuses('session-d').size, 1)
  clearTodos('session-d')
  assert.equal(getTodoStatuses('session-d').size, 0)
})
