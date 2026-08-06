import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-job-tools-concurrency-tests', String(process.pid))
process.env.APPROVAL_MODE = 'off'

const { runToolsLoop } = await import('../server/services/jobTools.js')
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

test('runToolsLoop keeps mixed read, write, and shell batches strictly serial', async () => {
  let modelTurns = 0
  let active = 0
  let peak = 0
  const executionOrder = []
  let resultOrder = []

  const result = await runToolsLoop({
    job: { id: 'job-mixed-serial', userId: TEST_USER, title: 'mixed tools' },
    step: { id: 'step-mixed-serial', kind: 'execute' },
    messages: [{ role: 'user', content: 'Read, write, then inspect.' }],
    runModel: async ({ messages }) => {
      modelTurns += 1
      if (modelTurns === 1) {
        return {
          content: '',
          toolCalls: [
            toolCall('mixed-1', 'read_file', { path: 'before.txt' }),
            toolCall('mixed-2', 'write_file', { path: 'after.txt', content: 'updated' }),
            toolCall('mixed-3', 'bash_exec', { command: 'git status' }),
          ],
        }
      }
      resultOrder = messages
        .filter((message) => message.role === 'tool')
        .map((message) => JSON.parse(message.content).name)
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async ({ name }) => {
      active += 1
      peak = Math.max(peak, active)
      executionOrder.push(name)
      await delay(10)
      active -= 1
      return { ok: true, name }
    },
  })

  const expected = ['read_file', 'write_file', 'bash_exec']
  assert.equal(result.text, 'done')
  assert.equal(peak, 1)
  assert.deepEqual(executionOrder, expected)
  assert.deepEqual(resultOrder, expected)
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
