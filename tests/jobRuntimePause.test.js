/**
 * Regression test: jobRuntime's default executeStep used to destructure only
 * text/artifactIds/toolIterations out of runToolsLoop and silently drop
 * result.paused / result.budgetExceeded — a truncated run reported ok:true.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-jobruntime-pause-'))
process.env.APP_DATA_DIR = TMP_DIR
process.env.APPROVAL_MODE = 'off'

const { createDefaultExecuteStep } = await import('../server/services/jobRuntime.js')
const { attachJobBudget } = await import('../server/utils/jobBudget.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

function makeJob(id, userId, prompt) {
  return { id, userId, title: prompt, prompt, steps: [] }
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

test('paused: request_clarification truncates the step and is NOT reported ok:true', async () => {
  const userId = issueTestSession({ email: `pause-clarify-${process.pid}@example.com` }).userId
  let modelCalls = 0
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async () => {
      modelCalls += 1
      return {
        content: '',
        toolCalls: [toolCall('c1', 'request_clarification', {
          question: '你要 PPT 还是 Word?',
          why: '需求里没写输出格式',
          blocker_kind: 'ambiguous_intent',
          options: ['PPT', 'Word'],
        })],
      }
    },
  })

  const job = makeJob('job-pause-1', userId, '帮我做个东西')
  const step = { id: 'step-pause-1', kind: 'execute' }
  const result = await executeStep({ job, step })

  assert.equal(modelCalls, 1, 'loop should break on the clarification turn')
  assert.notEqual(result.ok, true, 'a paused run must not report ok:true')
  assert.equal(result.ok, false)
  assert.equal(result.truncated, true)
  assert.equal(result.paused, true)
  assert.equal(result.budgetExceeded, false)
  assert.ok(result.reason, 'paused result should carry a reason')
  assert.ok(result.clarification, 'clarification payload must survive')
  assert.equal(result.clarification.question, '你要 PPT 还是 Word?')
  assert.equal(result.clarification.blocker_kind, 'ambiguous_intent')
  assert.deepEqual(result.clarification.options, ['PPT', 'Word'])
  assert.equal(result.output.toolIterations, 1)
})

test('budget exceeded: exhausted job budget yields ok:false + budgetExceeded + reason', async () => {
  const userId = issueTestSession({ email: `pause-budget-${process.pid}@example.com` }).userId
  let modelCalls = 0
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async () => {
      modelCalls += 1
      // 用一个不存在的工具:预算在 executeTool 之前就 consume,
      // 所以不会真的产生副作用,但仍然吃掉预算。
      return {
        content: '',
        toolCalls: [toolCall(`c${modelCalls}`, 'no_such_tool', { attempt: modelCalls })],
      }
    },
  })

  const job = makeJob('job-budget-1', userId, '无限循环调用工具')
  attachJobBudget(job, { maxTotalCalls: 2 })
  const step = { id: 'step-budget-1', kind: 'execute' }
  const result = await executeStep({ job, step })

  // 3 次是烧穿 2-call 预算需要的调用,第 4 次是**预算耗尽后的收尾调用**。
  // ★ 那次收尾是有意加的:原来预算路径直接 return 空 finalText,
  // 用户看到「任务跑了很久然后一个字都没有」—— 这正是「做到一半没后续」。
  assert.equal(modelCalls, 4, '3 次烧穿预算 + 1 次收尾总结')
  assert.notEqual(result.ok, true, 'a budget-exceeded run must not report ok:true')
  assert.equal(result.ok, false)
  assert.equal(result.truncated, true)
  assert.equal(result.budgetExceeded, true)
  assert.equal(result.paused, false)
  assert.equal(result.reason, 'execution_budget_exhausted')
  assert.ok(result.missingRequirements.includes('remaining_task_steps'))
  // 预算耗尽也必须给用户一句交代,绝不能是空文本
  assert.ok(String(result.output?.text || '').trim().length > 0, '预算耗尽也要有文字交代')
})

test('non-execution completion still returns ok:true with the model text', async () => {
  const userId = issueTestSession({ email: `pause-happy-${process.pid}@example.com` }).userId
  const executeStep = createDefaultExecuteStep({
    runModelWithTools: async () => ({ content: '第一行\n第二行', toolCalls: [] }),
  })

  const job = makeJob('job-happy-1', userId, '简单问答')
  const step = { id: 'step-happy-1', kind: 'verify' }
  const result = await executeStep({ job, step })

  assert.equal(result.ok, true)
  assert.equal(result.truncated, false)
  assert.equal(result.paused, false)
  assert.equal(result.budgetExceeded, false)
  assert.equal(result.output.text.replace(/\r\n/g, '\n'), '第一行\n第二行')
  assert.deepEqual(result.output.artifactIds, [])
})

test.after(() => {
  try { closeDb() } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})
