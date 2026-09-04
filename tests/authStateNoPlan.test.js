import assert from 'node:assert/strict'
import test from 'node:test'

import { createInitialState } from '../src/store/appStateBootstrap.js'
import { reduceAuthState } from '../src/store/reducers/authReducer.js'

test('authentication refresh preserves drafts and valid explicit session selections', () => {
  const sessions = [{ id: 'history-a' }, { id: 'history-b' }]
  const draft = reduceAuthState({
    ...createInitialState(),
    sessions,
    activeSessionId: null,
  }, {
    type: 'LOGIN',
    payload: { name: 'Local user', email: 'local@example.test' },
  })
  assert.equal(draft.activeSessionId, null)

  const selected = reduceAuthState({
    ...createInitialState(),
    sessions,
    activeSessionId: 'history-b',
  }, {
    type: 'LOGIN',
    payload: { name: 'Local user', email: 'local@example.test' },
  })
  assert.equal(selected.activeSessionId, 'history-b')
})

test('authentication state has no subscription plan field', () => {
  const initial = createInitialState()
  assert.equal(Object.hasOwn(initial.user, 'plan'), false)

  const loggedIn = reduceAuthState(initial, {
    type: 'LOGIN',
    payload: {
      name: 'Local user',
      email: 'local@example.test',
      plan: 'pro',
    },
  })
  assert.equal(loggedIn.isLoggedIn, true)
  assert.equal(Object.hasOwn(loggedIn.user, 'plan'), false)

  const bootstrapped = reduceAuthState(initial, {
    type: 'AUTH_BOOTSTRAP',
    payload: {
      authenticated: true,
      mode: 'local',
      user: {
        email: 'local@example.test',
        createdAt: 1,
        plan: 'enterprise',
      },
    },
  })
  assert.equal(Object.hasOwn(bootstrapped.user, 'plan'), false)

  const loggedOut = reduceAuthState(loggedIn, { type: 'LOGOUT' })
  assert.equal(Object.hasOwn(loggedOut.user, 'plan'), false)

  const unauthenticated = reduceAuthState(initial, {
    type: 'AUTH_BOOTSTRAP',
    payload: {
      authenticated: false,
      mode: 'multi_user',
      user: { plan: 'legacy' },
    },
  })
  assert.equal(Object.hasOwn(unauthenticated.user, 'plan'), false)

  const failed = reduceAuthState(initial, { type: 'AUTH_BOOTSTRAP_FAILED' })
  assert.equal(Object.hasOwn(failed.user, 'plan'), false)
})
