import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolsLoop } from '../server/services/jobTools.js'

function toolModel(name, args) {
  let calls = 0
  return async () => {
    calls += 1
    if (calls === 1) {
      return {
        content: '',
        toolCalls: [{
          id: `call-${name}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      }
    }
    return { content: 'done', toolCalls: [] }
  }
}

function runWithTool({ signal, command, executeTool }) {
  return runToolsLoop({
    job: { id: `interrupt-${command}`, userId: null, prompt: command },
    step: { id: `step-${command}`, kind: 'execute' },
    messages: [{ role: 'user', content: command }],
    signal,
    approvalMode: 'off',
    runModel: toolModel('bash_exec', { command }),
    executeTool,
  })
}

test('cancel tools receive the task cancellation signal', async () => {
  const controller = new AbortController()
  let receivedSignal = null
  const loop = runWithTool({
    signal: controller.signal,
    command: 'git status',
    executeTool: async ({ signal }) => {
      receivedSignal = signal
      controller.abort()
      return { ok: true }
    },
  })

  await assert.rejects(loop, { name: 'AbortError' })
  assert.equal(receivedSignal, controller.signal)
  assert.equal(receivedSignal.aborted, true)
})

test('block tools finish before task cancellation takes effect', async () => {
  const controller = new AbortController()
  let releaseTool
  let notifyStarted
  const toolStarted = new Promise((resolve) => { notifyStarted = resolve })
  const toolMayFinish = new Promise((resolve) => { releaseTool = resolve })
  let receivedSignal = null
  let settled = false

  const loop = runWithTool({
    signal: controller.signal,
    command: 'npm test',
    executeTool: async ({ signal }) => {
      receivedSignal = signal
      notifyStarted()
      await toolMayFinish
      assert.equal(signal.aborted, false)
      return { ok: true }
    },
  })
  loop.then(() => { settled = true }, () => { settled = true })

  await toolStarted
  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))

  assert.notEqual(receivedSignal, controller.signal)
  assert.equal(receivedSignal.aborted, false)
  assert.equal(settled, false, 'the loop must wait for the active block tool')

  releaseTool()
  await assert.rejects(loop, { name: 'AbortError' })
})
