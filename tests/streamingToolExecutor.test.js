import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamingToolExecutor } from '../src/lib/StreamingToolExecutor.js'

test('safe streamed calls start eagerly and are only executed once', async () => {
  let resolveTool
  let runs = 0
  const executor = new StreamingToolExecutor({
    isSafe: (call) => call.name === 'read_file',
    execute: () => {
      runs += 1
      return new Promise((resolve) => { resolveTool = resolve })
    },
  })
  const call = { id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' }

  const eager = executor.begin(call, { eager: true })
  assert.equal(runs, 1, 'tool starts before the final tool_calls event')
  assert.equal(executor.begin(call), eager, 'final event reuses the eager execution')
  assert.equal(runs, 1)

  resolveTool({ ok: true, content: 'done' })
  assert.deepEqual(await eager.promise, { ok: true, content: 'done' })
})

test('unsafe calls wait for the final tool_calls event', async () => {
  let runs = 0
  const executor = new StreamingToolExecutor({
    isSafe: () => false,
    execute: async () => { runs += 1; return { ok: true } },
  })
  const call = { id: 'call-2', name: 'write_file', arguments: '{}' }

  assert.equal(executor.begin(call, { eager: true }), null)
  assert.equal(runs, 0)
  await executor.begin(call).promise
  assert.equal(runs, 1)
})

test('executor converts thrown tools and guard rejection into model-readable results', async () => {
  const failed = new StreamingToolExecutor({
    before: () => ({ ok: true }),
    execute: async () => { throw new Error('offline') },
  })
  const failedResult = await failed.begin({ id: 'failed', name: 'fetch_url' }).promise
  assert.equal(failedResult.ok, false)
  assert.equal(JSON.parse(failedResult.content).code, 'tool_execution_failed')

  const guarded = new StreamingToolExecutor({
    before: () => ({ ok: false, reason: 'duplicate' }),
  })
  const guardedExecution = guarded.begin({ id: 'guarded', name: 'read_file' })
  assert.equal(guardedExecution.guardDecision.ok, false)
  assert.equal(JSON.parse((await guardedExecution.promise).content).code, 'repeated_tool_call')
})
