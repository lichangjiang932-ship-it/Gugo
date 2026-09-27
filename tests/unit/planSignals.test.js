import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  announceGoalPlanChanged,
  GOAL_PLAN_CHANGED_EVENT,
  inspectGoalPlanSignal,
  subscribeGoalPlanChanged,
  turnEventChangesGoalPlan,
} from '../../src/lib/goalPlanSignals.js'
import {
  messageIndexForTurn,
  REVEAL_TURN_EVENT,
  revealTurnInConversation,
  subscribeRevealTurn,
} from '../../src/lib/chatMessageSignals.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/#/chat' })
  // Deliberately no CustomEvent global: the module must build its event from the
  // window it dispatches on, or a host with its own Event class rejects it.
  globalThis.window = dom.window
  return dom
}

// ---------------------------------------------------------------------------
// Which turn events mean "the plan may have moved"
// ---------------------------------------------------------------------------

test('the plan-changing tools are recognised, and other tools are not', () => {
  for (const name of ['goal_step_update', 'goal_plan_rewrite', 'goal_plan_status', 'manage_todos', 'set_deliverables']) {
    const signal = inspectGoalPlanSignal({ type: 'tool.completed', payload: { name } })
    assert.equal(signal.changed, true, name)
    assert.equal(signal.toolName, name)
  }
  // A tool that cannot touch the plan must not trigger a re-read; otherwise every
  // single tool call would re-fetch and the signal would mean nothing.
  for (const name of ['read_file', 'bash_exec', 'web_search', 'write_file', '']) {
    assert.equal(turnEventChangesGoalPlan({ type: 'tool.completed', payload: { name } }), false, name || '(empty)')
  }
})

test('a turn that ends for any reason re-reads the plan, other events do not', () => {
  for (const type of ['turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted', 'turn.blocked', 'turn.paused']) {
    assert.equal(turnEventChangesGoalPlan({ type }), true, type)
  }
  for (const type of ['turn.started', 'assistant.delta', 'reasoning.delta', 'tool.started', 'heartbeat', 'model.phase', '']) {
    assert.equal(turnEventChangesGoalPlan({ type }), false, type || '(empty)')
  }
  // Nothing at all must not throw or count as a change.
  assert.equal(turnEventChangesGoalPlan(null), false)
  assert.equal(turnEventChangesGoalPlan(undefined), false)
})

test('a plan change is announced to whoever is showing a plan', () => {
  const dom = setupDom()
  const seen = []
  const unsubscribe = subscribeGoalPlanChanged((detail) => seen.push(detail))
  announceGoalPlanChanged({ reason: 'goal_tool', toolName: 'goal_step_update' })
  // A reader that has gone away must stop hearing about changes.
  unsubscribe()
  announceGoalPlanChanged({ reason: 'turn_end' })
  assert.deepEqual(seen, [{ reason: 'goal_tool', toolName: 'goal_step_update' }])
  assert.equal(GOAL_PLAN_CHANGED_EVENT, 'chat-goals:changed')
  dom.window.close()
})

// ---------------------------------------------------------------------------
// Pointing the conversation at a turn
// ---------------------------------------------------------------------------

test('the transcript resolves a turn id to the message that carries it', () => {
  const messages = [
    { id: 'm1', meta: { serverTurnId: 'turn-a' } },
    { id: 'm2', meta: {} },
    { id: 'm3', meta: { serverTurnId: 'turn-b' } },
    // The same turn may be reported by more than one message (a retry, a resumed
    // turn); the newest one is the one worth showing.
    { id: 'm4', meta: { serverTurnId: 'turn-a' } },
  ]
  assert.equal(messageIndexForTurn(messages, 'turn-a'), 3)
  assert.equal(messageIndexForTurn(messages, 'turn-b'), 2)
  // A turn from an older session, or a deleted message, is honestly not found.
  assert.equal(messageIndexForTurn(messages, 'turn-gone'), -1)
  assert.equal(messageIndexForTurn(messages, ''), -1)
  assert.equal(messageIndexForTurn(null, 'turn-a'), -1)
})

test('asking to see a turn reaches the transcript, and an empty request does not', () => {
  const dom = setupDom()
  const seen = []
  const unsubscribe = subscribeRevealTurn((turnId) => seen.push(turnId))
  assert.equal(revealTurnInConversation('turn-a'), true)
  assert.equal(revealTurnInConversation('   '), false)
  assert.equal(revealTurnInConversation(null), false)
  unsubscribe()
  revealTurnInConversation('turn-b')
  assert.deepEqual(seen, ['turn-a'])
  assert.equal(REVEAL_TURN_EVENT, 'chat-messages:reveal-turn')
  dom.window.close()
})
