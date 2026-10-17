import assert from 'node:assert/strict'
import test from 'node:test'

import { createTurnEvent } from '../shared/turnEvents.js'
import { deriveSessionTodos, normalizeSessionTodos, resolveSessionTodos, todosSignature } from '../src/lib/sessionTodos.js'
import { dispatchTurnEvent } from '../src/lib/turnClient/turnEventDispatch.js'
import { reduceTaskSettingsState } from '../src/store/reducers/taskSettingsReducer.js'

function toolMessage(calls) {
  return { id: 'assistant-1', role: 'assistant', content: '', meta: { toolCalls: calls } }
}

test('todo normalization accepts the tool shape and the legacy slash-goal shape', () => {
  const normalized = normalizeSessionTodos([
    { content: 'Read the spec', activeForm: 'Reading the spec', status: 'in_progress' },
    { text: 'Ship it', done: true },
    { title: 'Check output', status: 'done' },
    { content: '   ', status: 'pending' },
    null,
  ])
  assert.deepEqual(normalized.map((todo) => [todo.content, todo.activeForm, todo.status]), [
    ['Read the spec', 'Reading the spec', 'in_progress'],
    ['Ship it', 'Ship it', 'completed'],
    ['Check output', 'Check output', 'completed'],
  ])
  assert.equal(normalized[0].id, '0:Read the spec')
})

test('todo normalization keeps a bounded list and a stable signature', () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ content: `Task ${index}`, status: 'pending' }))
  const normalized = normalizeSessionTodos(many)
  assert.equal(normalized.length, 50)
  assert.equal(todosSignature(normalized), todosSignature(many.slice(0, 50)))
  assert.notEqual(todosSignature(normalized), todosSignature([{ content: 'Task 0', status: 'completed' }]))
})

test('the transcript fallback reads the latest successful manage_todos call', () => {
  const messages = [
    toolMessage([{ id: 'old', name: 'manage_todos', status: 'success', arguments: JSON.stringify({ todos: [{ content: 'Old step', status: 'pending' }] }) }]),
    toolMessage([
      { id: 'failed', name: 'manage_todos', status: 'error', arguments: JSON.stringify({ todos: [{ content: 'Failed step', status: 'pending' }] }) },
      { id: 'new', name: 'manage_todos', status: 'success', result: JSON.stringify({ ok: true, todos: [{ content: 'New step', status: 'in_progress' }] }) },
    ]),
  ]
  assert.deepEqual(deriveSessionTodos(messages).map((todo) => [todo.content, todo.status]), [['New step', 'in_progress']])
  assert.equal(deriveSessionTodos([]), null)
})

test('stored todos win, and the transcript fills a session that stored none', () => {
  const messages = [toolMessage([{ id: 'todo', name: 'manage_todos', status: 'success', arguments: JSON.stringify({ todos: [{ content: 'From history', status: 'pending' }] }) }])]
  assert.deepEqual(resolveSessionTodos({ messages }).map((todo) => todo.content), ['From history'])
  assert.deepEqual(
    resolveSessionTodos({ messages, storedTodos: [{ content: 'Live list', status: 'completed' }] }).map((todo) => todo.content),
    ['Live list'],
  )
})

test('SET_TODOS normalizes, ignores unknown sessions, and does not churn an unchanged list', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [{ id: 's1', todos: [{ id: 'a', text: 'Old', done: false }], updatedAt: 1 }],
  }
  const action = { type: 'SET_TODOS', payload: { sessionId: 's1', todos: [{ content: 'Build it', status: 'in_progress' }] } }
  const next = reduceTaskSettingsState(state, action)
  assert.deepEqual(next.sessions[0].todos, [{ id: '0:Build it', content: 'Build it', activeForm: 'Build it', status: 'in_progress' }])
  assert.notEqual(next.sessions[0].updatedAt, 1)
  assert.equal(reduceTaskSettingsState(next, action), next)
  assert.equal(reduceTaskSettingsState(state, { type: 'SET_TODOS', payload: { sessionId: 'missing', todos: [] } }), state)
})

test('a successful manage_todos tool event publishes the live task list; a failure does not', async () => {
  const actions = []
  const options = {
    dispatch: (action) => actions.push(action),
    taskId: 'task',
    messageTarget: { sessionId: 's1', messageId: 'assistant-1' },
  }
  await dispatchTurnEvent(createTurnEvent({
    id: 'todo-ok', sessionId: 's1', turnId: 't1', sequence: 1, type: 'tool.completed',
    payload: {
      toolCallId: 'c1',
      name: 'manage_todos',
      args: { todos: [{ content: 'Build it', activeForm: 'Building it', status: 'in_progress' }] },
      result: { ok: true, todos: [{ content: 'Build it', activeForm: 'Building it', status: 'in_progress' }] },
    },
    createdAt: 1,
  }), options)
  const published = actions.filter((action) => action.type === 'SET_TODOS')
  assert.equal(published.length, 1)
  assert.equal(published[0].payload.sessionId, 's1')
  assert.deepEqual(published[0].payload.todos.map((todo) => [todo.content, todo.activeForm, todo.status]), [
    ['Build it', 'Building it', 'in_progress'],
  ])

  actions.length = 0
  await dispatchTurnEvent(createTurnEvent({
    id: 'todo-failed', sessionId: 's1', turnId: 't1', sequence: 2, type: 'tool.completed',
    payload: {
      toolCallId: 'c2',
      name: 'manage_todos',
      args: { todos: [{ content: 'Claimed but failed', status: 'completed' }] },
      result: { ok: false, error: 'todo update rejected' },
    },
    createdAt: 2,
  }), options)
  assert.equal(actions.some((action) => action.type === 'SET_TODOS'), false)
})

test('a successful empty manage_todos list clears the session list', async () => {
  const actions = []
  await dispatchTurnEvent(createTurnEvent({
    id: 'todo-clear', sessionId: 's1', turnId: 't1', sequence: 1, type: 'tool.completed',
    payload: {
      toolCallId: 'c3',
      name: 'manage_todos',
      args: { todos: [] },
      result: { ok: true, todos: [] },
    },
    createdAt: 1,
  }), { dispatch: (action) => actions.push(action), taskId: 'task', messageTarget: { sessionId: 's1' } })
  const published = actions.find((action) => action.type === 'SET_TODOS')
  assert.ok(published)
  assert.deepEqual(published.payload.todos, [])
})
