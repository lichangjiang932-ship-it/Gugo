/**
 * M3 集成测试:验证 runToolsLoop 在模型调 request_clarification 时
 * 能立刻 break 出循环并返回 paused 标志 + clarification 数据。
 *
 * 用一个 fake runModel/executeTool 测,不打真模型。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runToolsLoop } from '../server/services/jobTools.js'
import { requestClarificationTool, requestDirectoryTool, reflectTool } from '../server/utils/agenticTools.js'

function makeFakeJob() {
  return { id: 'job-1', userId: 'u-1', steps: [] }
}

test('runToolsLoop: 模型调 request_clarification → 立即 paused 中断', async () => {
  let callCount = 0
  const fakeRunModel = async () => {
    callCount++
    if (callCount === 1) {
      return {
        content: '我需要先确认一下',
        toolCalls: [{
          id: 'call-1',
          function: { name: 'request_clarification', arguments: JSON.stringify({ question: '用 TS 还是 JS?', options: ['ts', 'js'] }) },
        }],
      }
    }
    // 不应该被调到第二次 — paused 后必须 break
    throw new Error('runModel 不应该被再调用')
  }
  const fakeExecute = async ({ name, args }) => {
    if (name === 'request_clarification') return requestClarificationTool(args)
    throw new Error(`unexpected tool: ${name}`)
  }
  const result = await runToolsLoop({
    job: makeFakeJob(),
    step: { id: 'step-1' },
    messages: [{ role: 'user', content: 'hi' }],
    runModel: fakeRunModel,
    executeTool: fakeExecute,
  })
  assert.equal(result.paused, true)
  assert.ok(result.clarification)
  assert.equal(result.clarification.question, '用 TS 还是 JS?')
  assert.deepEqual(result.clarification.options, ['ts', 'js'])
  assert.equal(callCount, 1, '模型只能被调一次')
})

test('runToolsLoop: reflect 不中断,继续下一轮', async () => {
  let callCount = 0
  const fakeRunModel = async () => {
    callCount++
    if (callCount === 1) {
      return {
        content: '复盘一下',
        toolCalls: [{
          id: 'r1',
          function: { name: 'reflect', arguments: JSON.stringify({ observation: 'x', next_step: 'y' }) },
        }],
      }
    }
    if (callCount === 2) return { content: '完成', toolCalls: [] }
    throw new Error('too many calls')
  }
  const fakeExecute = async ({ name, args }) => {
    if (name === 'reflect') return reflectTool(args)
    throw new Error(`unexpected tool: ${name}`)
  }
  const result = await runToolsLoop({
    job: makeFakeJob(),
    step: { id: 'step-1' },
    messages: [{ role: 'user', content: 'hi' }],
    runModel: fakeRunModel,
    executeTool: fakeExecute,
  })
  assert.equal(result.paused, undefined, 'reflect 不应触发暂停')
  assert.equal(result.text, '完成')
  assert.equal(callCount, 2)
})

test('runToolsLoop: request_directory 立即挂起并保留最小权限请求', async () => {
  const result = await runToolsLoop({
    job: makeFakeJob(),
    step: { id: 'step-directory' },
    messages: [{ role: 'user', content: '读取我的报告' }],
    runModel: async () => ({
      content: '',
      toolCalls: [{
        id: 'directory-1',
        function: { name: 'request_directory', arguments: JSON.stringify({ purpose: '读取报告' }) },
      }],
    }),
    executeTool: async ({ name, args }) => {
      assert.equal(name, 'request_directory')
      return requestDirectoryTool(args)
    },
  })
  assert.equal(result.paused, true)
  assert.equal(result.clarification.request_type, 'directory')
  assert.equal(result.clarification.access_mode, 'read_only')
})

test('runToolsLoop: budgetExceeded 触发停止', async () => {
  const { attachJobBudget } = await import('../server/utils/jobBudget.js')
  let n = 0
  const fakeRunModel = async () => {
    n++
    return {
      content: '',
      toolCalls: [{
        id: `c${n}`,
        function: { name: 'echo_tool', arguments: JSON.stringify({ attempt: n }) },
      }],
    }
  }
  const fakeExecute = async () => ({ ok: true })
  const job = { id: 'j', userId: 'u', steps: [] }
  attachJobBudget(job, { maxTotalCalls: 3, maxWallMs: 60_000 })
  const r = await runToolsLoop({
    job, step: { id: 's' },
    messages: [{ role: 'user', content: 'x' }],
    runModel: fakeRunModel,
    executeTool: fakeExecute,
    maxIters: 20,
  })
  assert.equal(r.budgetExceeded, true)
  assert.match(r.reason, /budget/)
})
