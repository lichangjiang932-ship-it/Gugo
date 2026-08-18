import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyPlanExecutionConfirmation,
  intentModeForAgentMode,
  resolvePlanExecutionConfirmation,
} from '../src/pages/ChatSplit/chatSendMode.js'

test('exact execution confirmations leave the current plan context with the requested mode', () => {
  for (const [content, approvalMode] of [
    ['执行', 'acceptEdits'],
    ['  自动模式执行  ', 'acceptEdits'],
    ['正常模式执行', 'normal'],
  ]) {
    assert.deepEqual(resolvePlanExecutionConfirmation({
      content,
      agentMode: 'plan',
      approvalMode: 'plan',
    }), {
      agentMode: 'code',
      approvalMode,
      intentMode: 'execute',
    })
  }
})

test('execution wording never changes modes outside an exact current-plan confirmation', () => {
  for (const request of [
    { content: '执行', agentMode: 'chat', approvalMode: 'normal' },
    { content: '请执行', agentMode: 'plan', approvalMode: 'plan' },
    { content: '执行。', agentMode: 'plan', approvalMode: 'plan' },
    { content: '为什么不能执行', agentMode: 'plan', approvalMode: 'plan' },
    { content: '自动模式执行这个方案', agentMode: 'plan', approvalMode: 'plan' },
  ]) {
    assert.equal(resolvePlanExecutionConfirmation(request), null, request.content)
  }
})

test('plan confirmation persists permission before changing the agent mode used by this send', async () => {
  const calls = []
  const confirmation = resolvePlanExecutionConfirmation({
    content: '执行',
    agentMode: 'plan',
    approvalMode: 'plan',
  })
  const result = await applyPlanExecutionConfirmation(confirmation, {
    currentApprovalMode: 'plan',
    changeApprovalMode: async (mode) => {
      calls.push(`permission:${mode}`)
      return { mode }
    },
    dispatch: (action) => calls.push(`agent:${action.payload}`),
  })

  assert.deepEqual(result, { proceed: true, applied: true })
  assert.deepEqual(calls, ['permission:acceptEdits', 'agent:code'])
  assert.equal(intentModeForAgentMode(confirmation.agentMode), 'execute')
})

test('failed permission persistence stops the execution confirmation', async () => {
  const actions = []
  const result = await applyPlanExecutionConfirmation({
    agentMode: 'code', approvalMode: 'acceptEdits', intentMode: 'execute',
  }, {
    currentApprovalMode: 'plan',
    changeApprovalMode: async () => false,
    dispatch: (action) => actions.push(action),
  })

  assert.deepEqual(result, { proceed: false, applied: false })
  assert.deepEqual(actions, [])
})
