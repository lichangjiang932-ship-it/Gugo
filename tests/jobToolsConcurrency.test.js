import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-tools-concurrency-tests', String(process.pid))
process.env.APPROVAL_MODE = 'off'

const { runToolsLoop } = await import('../server/services/jobTools.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const TEST_USER = issueTestSession({ email: 'job-tools-concurrency@example.com' }).userId

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('runToolsLoop executes an all-read batch concurrently and preserves result order', async () => {
  let modelTurns = 0
  let active = 0
  let peak = 0
  let orderedResults = []
  const waits = new Map([['first.txt', 45], ['second.txt', 25], ['third.txt', 5]])

  const result = await runToolsLoop({
    job: { id: 'job-read-parallel', userId: TEST_USER, title: 'parallel reads' },
    step: { id: 'step-read-parallel', kind: 'execute' },
    messages: [{ role: 'user', content: 'Read three files.' }],
    runModel: async ({ messages }) => {
      modelTurns += 1
      if (modelTurns === 1) {
        return {
          content: '',
          toolCalls: [
            toolCall('read-1', 'read_file', { path: 'first.txt' }),
            toolCall('read-2', 'read_file', { path: 'second.txt' }),
            toolCall('read-3', 'read_file', { path: 'third.txt' }),
          ],
        }
      }
      orderedResults = messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(message.content).path)
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async ({ args }) => {
      active += 1
      peak = Math.max(peak, active)
      await delay(waits.get(args.path))
      active -= 1
      return { ok: true, path: args.path }
    },
  })

  assert.equal(result.text, 'done')
  assert.ok(peak > 1, `expected concurrent reads, observed peak ${peak}`)
  assert.deepEqual(orderedResults, ['first.txt', 'second.txt', 'third.txt'])
})

test('runToolsLoop caps a large parallel read batch at three active tools', async () => {
  let modelTurns = 0
  let active = 0
  let peak = 0

  const result = await runToolsLoop({
    job: { id: 'job-read-parallel-cap', userId: TEST_USER, title: 'bounded parallel reads' },
    step: { id: 'step-read-parallel-cap', kind: 'execute' },
    messages: [{ role: 'user', content: 'Read five files.' }],
    runModel: async () => {
      modelTurns += 1
      if (modelTurns === 1) {
        return {
          content: '',
          toolCalls: Array.from({ length: 5 }, (_, index) => (
            toolCall(`bounded-read-${index}`, 'read_file', { path: `bounded-${index}.txt` })
          )),
        }
      }
      return { content: 'bounded done', toolCalls: [] }
    },
    executeTool: async ({ args }) => {
      active += 1
      peak = Math.max(peak, active)
      await delay(25)
      active -= 1
      return { ok: true, path: args.path }
    },
  })

  assert.equal(result.text, 'bounded done')
  assert.equal(peak, 3)
})

test('runToolsLoop runs read segments concurrently around a durable write barrier and preserves result order', async () => {
  const writeUser = issueTestSession({ email: 'job-tools-concurrency-write@example.com' }).userId
  setApprovalMode({ userId: writeUser, mode: 'bypass' })
  let modelTurns = 0
  let active = 0
  let peak = 0
  let beforeActive = 0
  let beforePeak = 0
  let beforeCompleted = 0
  let afterActive = 0
  let afterPeak = 0
  let writeActive = false
  let writeFinished = false
  let writeWasDurablyExecuting = false
  const executionOrder = []
  const barrierViolations = []
  let resultOrder = []
  const waits = new Map([
    ['before-one.txt', 35],
    ['before-two.txt', 15],
    ['after.txt', 10],
    ['after-two.txt', 30],
  ])

  const result = await runToolsLoop({
    job: { id: 'job-mixed-barrier', userId: writeUser, title: 'mixed tools' },
    step: { id: 'step-mixed-barrier', kind: 'execute' },
    messages: [{ role: 'user', content: 'Read twice, write, then read twice.' }],
    saveCheckpoint: async (state) => {
      if (state.toolCalls.some((call) => (
        call.id === 'mixed-write' && call.checkpointStatus === 'executing'
      ))) writeWasDurablyExecuting = true
      return true
    },
    runModel: async ({ messages }) => {
      modelTurns += 1
      if (modelTurns === 1) {
        return {
          content: '',
          toolCalls: [
            toolCall('mixed-read-1', 'read_file', { path: 'before-one.txt' }),
            toolCall('mixed-read-2', 'read_file', { path: 'before-two.txt' }),
            toolCall('mixed-write', 'write_file', { path: 'after.txt', content: 'updated' }),
            toolCall('mixed-read-3', 'read_file', { path: 'after.txt' }),
            toolCall('mixed-read-4', 'read_file', { path: 'after-two.txt' }),
          ],
        }
      }
      resultOrder = messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(message.content).label)
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      const label = name === 'write_file' ? 'write:after.txt' : `read:${args.path}`
      const beforeRead = name === 'read_file' && args.path.startsWith('before-')
      const afterRead = name === 'read_file' && !beforeRead
      if (name === 'write_file') {
        if (active !== 0 || beforeCompleted !== 2) barrierViolations.push('write overlapped the first read segment')
        writeActive = true
      } else if (writeActive || (afterRead && !writeFinished)) {
        barrierViolations.push(`${label} crossed the write barrier`)
      }
      active += 1
      peak = Math.max(peak, active)
      if (beforeRead) {
        beforeActive += 1
        beforePeak = Math.max(beforePeak, beforeActive)
      }
      if (afterRead) {
        afterActive += 1
        afterPeak = Math.max(afterPeak, afterActive)
      }
      executionOrder.push(label)
      await delay(waits.get(args.path) ?? 10)
      active -= 1
      if (beforeRead) {
        beforeActive -= 1
        beforeCompleted += 1
      }
      if (afterRead) afterActive -= 1
      if (name === 'write_file') {
        writeActive = false
        writeFinished = true
      }
      return { ok: true, name, label, ...(args?.path ? { path: args.path } : {}) }
    },
  })

  const expected = [
    'read:before-one.txt',
    'read:before-two.txt',
    'write:after.txt',
    'read:after.txt',
    'read:after-two.txt',
  ]
  assert.equal(result.text, 'done')
  assert.equal(peak, 2)
  assert.equal(beforePeak, 2)
  assert.equal(afterPeak, 2)
  assert.equal(writeWasDurablyExecuting, true)
  assert.deepEqual(barrierViolations, [])
  assert.deepEqual(executionOrder, expected)
  assert.deepEqual(resultOrder, expected)
})

test('tool-boundary steering lets an active read segment finish and supersedes the following write barrier', async () => {
  let claims = 0
  let modelTurns = 0
  let activeReads = 0
  let peakReads = 0
  let writeExecutions = 0
  const acknowledged = []
  let observedResults = []

  const result = await runToolsLoop({
    job: { id: 'job-read-steering-barrier', userId: TEST_USER, title: 'steer after reads' },
    step: { id: 'step-read-steering-barrier', kind: 'execute' },
    messages: [{ role: 'user', content: 'Inspect the two inputs.' }],
    saveCheckpoint: async () => true,
    claimSteering: async () => {
      claims += 1
      if (claims === 2) {
        return {
          leaseId: 'parallel-boundary-lease',
          messages: [{ id: 'parallel-boundary-steering', content: 'Stop after the reads; do not write anything.' }],
        }
      }
      return { leaseId: null, messages: [] }
    },
    acknowledgeSteering: async (leaseId) => acknowledged.push(leaseId),
    runModel: async ({ messages }) => {
      modelTurns += 1
      if (modelTurns === 1) {
        return {
          content: '',
          toolCalls: [
            toolCall('steering-read-1', 'read_file', { path: 'one.txt' }),
            toolCall('steering-read-2', 'read_file', { path: 'two.txt' }),
            toolCall('steering-write', 'write_file', { path: 'stale.txt', content: 'stale' }),
          ],
        }
      }
      observedResults = messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(message.content))
      assert.ok(messages.some((message) => (
        message.role === 'user' && message.content === 'Stop after the reads; do not write anything.'
      )))
      return { content: 'Stopped after both reads.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      if (name === 'write_file') {
        writeExecutions += 1
        return { ok: true, path: args.path }
      }
      activeReads += 1
      peakReads = Math.max(peakReads, activeReads)
      await delay(args.path === 'one.txt' ? 30 : 10)
      activeReads -= 1
      return { ok: true, path: args.path, content: args.path }
    },
  })

  assert.equal(result.text, 'Stopped after both reads.')
  assert.equal(peakReads, 2)
  assert.equal(writeExecutions, 0)
  assert.deepEqual(observedResults.map((entry) => entry.code || entry.path), [
    'one.txt',
    'two.txt',
    'tool_execution_superseded_by_steering',
  ])
  assert.deepEqual(acknowledged, ['parallel-boundary-lease'])
})

test('a third identical parallel read trips no-progress and skips the following write barrier', async () => {
  let modelTurns = 0
  let readExecutions = 0
  let writeExecutions = 0
  let wrapUpMessages = []

  const result = await runToolsLoop({
    job: { id: 'job-parallel-repeat-fuse', userId: TEST_USER, title: 'repeat fuse' },
    step: { id: 'step-parallel-repeat-fuse', kind: 'execute' },
    messages: [{ role: 'user', content: 'Read once safely and do not loop before writing.' }],
    runModel: async ({ messages, tools }) => {
      modelTurns += 1
      if (modelTurns === 1) {
        return {
          content: '',
          toolCalls: [
            toolCall('repeat-read-1', 'read_file', { path: 'same.txt' }),
            toolCall('repeat-read-2', 'read_file', { path: 'same.txt' }),
            toolCall('repeat-read-3', 'read_file', { path: 'same.txt' }),
            toolCall('repeat-write', 'write_file', { path: 'must-not-run.txt', content: 'blocked' }),
          ],
        }
      }
      assert.deepEqual(tools, [])
      wrapUpMessages = messages
      return { content: 'Stopped after detecting the repeated read.', toolCalls: [] }
    },
    executeTool: async ({ name, args }) => {
      if (name === 'write_file') {
        writeExecutions += 1
        return { ok: true, path: args.path }
      }
      readExecutions += 1
      return { ok: true, path: args.path, content: 'same' }
    },
  })

  const toolResults = wrapUpMessages
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(message.content))
  assert.equal(readExecutions, 2)
  assert.equal(writeExecutions, 0)
  assert.equal(result.incomplete, true)
  assert.equal(result.noProgress, true)
  assert.equal(result.reason, 'tool_no_progress')
  assert.ok(result.missingRequirements.includes('progress_after_last_checkpoint'))
  assert.equal(toolResults[2].code, 'repeated_tool_call')
  assert.equal(toolResults[3].code, 'tool_execution_skipped')
})

test('runToolsLoop shares an 8k context budget across concurrent tool results', async () => {
  let modelTurns = 0
  let resultMessages = []

  const result = await runToolsLoop({
    job: { id: 'job-read-context-budget', userId: TEST_USER, title: 'bounded parallel reads' },
    step: { id: 'step-read-context-budget', kind: 'execute' },
    messages: [{ role: 'user', content: 'Read four files.' }],
    contextWindow: 8_192,
    runModel: async ({ messages }) => {
      modelTurns += 1
      if (modelTurns === 1) {
        return {
          content: '',
          toolCalls: [
            toolCall('bounded-1', 'read_file', { path: 'one.txt' }),
            toolCall('bounded-2', 'read_file', { path: 'two.txt' }),
            toolCall('bounded-3', 'read_file', { path: 'three.txt' }),
            toolCall('bounded-4', 'read_file', { path: 'four.txt' }),
          ],
        }
      }
      resultMessages = messages.filter((message) => message.role === 'tool')
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async ({ args }) => ({
      ok: true,
      path: args.path,
      content: 'x'.repeat(30_000),
    }),
  })

  assert.equal(result.text, 'done')
  assert.equal(resultMessages.length, 4)
  assert.equal(resultMessages.every((message) => message.content.length <= 1_536), true)
  assert.equal(resultMessages.reduce((total, message) => total + message.content.length, 0) <= 6_144, true)
  assert.equal(resultMessages.every((message) => JSON.parse(message.content).truncated === true), true)
})
