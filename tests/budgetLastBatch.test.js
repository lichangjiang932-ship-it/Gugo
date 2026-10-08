import test from 'node:test'
import assert from 'node:assert/strict'
import { runToolLoop } from '../server/services/loop/index.js'

// The model budget can run out with the very response that proposed a batch.
// Only the first call of that batch used to run; the rest were recorded as
// skipped and never replayed, while the turn reported that "the last batch of
// tool calls returned by the model was executed".

const spec = (name) => ({ type: 'function', function: { name, description: `${name} fixture.`,
  parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } } })

test('a batch proposed by the response that exhausted the model budget runs to the end', async () => {
  const executed = []
  const completed = []
  let modelCalls = 0
  const result = await runToolLoop({
    job: { id: 'budget-batch', userId: 'budget-user', origin: 'chat', prompt: 'Write and check.' },
    step: { id: 'budget-batch-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Write and check.' }],
    toolSpecs: [spec('first_tool'), spec('second_tool')],
    maxIters: 4,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'fixture' }),
    onToolCompleted: (outcome) => completed.push(outcome),
    runModel: async () => {
      modelCalls += 1
      if (modelCalls > 1) return { content: 'wrap-up', toolCalls: [] }
      throw Object.assign(new Error('model budget exceeded'), {
        code: 'MODEL_BUDGET_EXCEEDED',
        partialModelResult: { content: '', toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'first_tool', arguments: '{"note":"a"}' } },
          { id: 'call-2', type: 'function', function: { name: 'second_tool', arguments: '{"note":"b"}' } },
        ] },
      })
    },
    executeTool: async ({ name }) => { executed.push(name); return { ok: true } },
  })
  assert.deepEqual(executed, ['first_tool', 'second_tool'], 'every call the response proposed ran')
  assert.equal(completed.some((outcome) => outcome.result?.code === 'tool_execution_skipped'), false)
  assert.equal(result.budgetExceeded, true)
  assert.match(result.text, /last batch|最后一批/u)
})

test('a call superseded by steering still reports its completed row', async () => {
  const completed = []
  let modelCalls = 0
  let claims = 0
  await runToolLoop({
    job: { id: 'supersede', userId: 'supersede-user', origin: 'chat', prompt: 'Do two things.' },
    step: { id: 'supersede-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Do two things.' }],
    toolSpecs: [spec('first_tool'), spec('second_tool')],
    maxIters: 3,
    enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'fixture' }),
    // A steering message lands after the first call, superseding the second.
    claimSteering: async () => (++claims === 2 ? { leaseId: 'steer', messages: [{ id: 'steer-1', content: 'Stop, do it differently.' }] } : { leaseId: null, messages: [] }),
    acknowledgeSteering: async () => {},
    onToolCompleted: (outcome) => completed.push(outcome),
    runModel: async () => (++modelCalls === 1 ? { content: '', toolCalls: [
      { id: 'call-1', type: 'function', function: { name: 'first_tool', arguments: '{"note":"a"}' } },
      { id: 'call-2', type: 'function', function: { name: 'second_tool', arguments: '{"note":"b"}' } },
    ] } : { content: 'Adjusted.', toolCalls: [] }),
    executeTool: async () => ({ ok: true }),
  })
  const second = completed.find((outcome) => outcome.call?.id === 'call-2')
  assert.equal(second?.result?.code, 'tool_execution_superseded_by_steering', JSON.stringify(completed.map((outcome) => [outcome.call?.id, outcome.result?.code])))
})
