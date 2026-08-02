import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  reflectTool,
  requestClarificationTool,
  requestDirectoryTool,
  AGENTIC_TOOL_SPECS,
  dispatchAgenticTool,
  isLoopPauseResult,
} from '../server/utils/agenticTools.js'

/* reflect */

test('reflect: 基础有效输入', () => {
  const r = reflectTool({
    observation: 'grep_code 找到 3 个 loginUser 引用',
    what_worked: '正则匹配命中目标文件',
    next_step: '打开 auth.ts 看完整实现',
    confidence: 'high',
  })
  assert.equal(r.ok, true)
  assert.equal(r.accepted, true)
  assert.equal(r.reflection.observation, 'grep_code 找到 3 个 loginUser 引用')
  assert.equal(r.reflection.confidence, 'high')
  assert.equal(r.reflection.is_done, false)
  assert.ok(typeof r.reflection.timestamp === 'number')
})

test('reflect: next_step = "done" 触发完成标志', () => {
  const r = reflectTool({
    observation: '所有测试通过',
    next_step: 'done',
  })
  assert.equal(r.reflection.is_done, true)
})

test('reflect: next_step = "Done" (大小写不敏感)', () => {
  const r = reflectTool({ observation: 'x', next_step: 'Done' })
  assert.equal(r.reflection.is_done, true)
})

test('reflect: observation/next_step 必填', () => {
  assert.throws(() => reflectTool({ next_step: 'x' }), /observation/)
  assert.throws(() => reflectTool({ observation: 'x' }), /next_step/)
  assert.throws(() => reflectTool({ observation: '   ', next_step: 'x' }), /observation/)
})

test('reflect: confidence 非法拒绝', () => {
  assert.throws(
    () => reflectTool({ observation: 'x', next_step: 'y', confidence: 'super-high' }),
    /confidence/
  )
})

test('reflect: 长字段截断', () => {
  const long = 'A'.repeat(10_000)
  const r = reflectTool({ observation: long, next_step: 'y' })
  assert.ok(r.reflection.observation.length <= 4000)
})

/* request_clarification */

test('request_clarification: 基础流程返回 paused=true', () => {
  const r = requestClarificationTool({
    question: '要用 React 还是 Vue?',
    why: '影响目录结构',
    blocker_kind: 'ambiguous_intent',
    options: ['React', 'Vue', 'Svelte'],
  })
  assert.equal(r.ok, true)
  assert.equal(r.paused, true, 'paused 必须 true 以触发 loop 中断')
  assert.equal(r.clarification.question, '要用 React 还是 Vue?')
  assert.equal(r.clarification.blocker_kind, 'ambiguous_intent')
  assert.deepEqual(r.clarification.options, ['React', 'Vue', 'Svelte'])
})

test('request_clarification: options 默认 blocker_kind', () => {
  const r = requestClarificationTool({ question: '?' })
  assert.equal(r.clarification.blocker_kind, 'missing_info')
  assert.equal(r.clarification.options, null)
})

test('request_clarification: options 上限 8', () => {
  const many = Array.from({ length: 20 }, (_, i) => `opt ${i}`)
  const r = requestClarificationTool({ question: '?', options: many })
  assert.equal(r.clarification.options.length, 8)
})

test('request_clarification: 非字符串/空选项过滤', () => {
  const r = requestClarificationTool({
    question: '?',
    options: ['ok', '', null, 'fine', 42, '   '],
  })
  assert.deepEqual(r.clarification.options, ['ok', 'fine'])
})

test('request_clarification: question 必填', () => {
  assert.throws(() => requestClarificationTool({}), /question/)
  assert.throws(() => requestClarificationTool({ question: '   ' }), /question/)
})

test('request_clarification: blocker_kind 非法拒绝', () => {
  assert.throws(
    () => requestClarificationTool({ question: 'x', blocker_kind: 'evil' }),
    /blocker_kind/
  )
})

test('request_directory: 以最小权限挂起并携带结构化目录请求', () => {
  const result = requestDirectoryTool({
    purpose: '读取季度报告',
    suggested_path: 'D:\\Reports',
  })
  assert.equal(result.paused, true)
  assert.equal(result.clarification.request_type, 'directory')
  assert.equal(result.clarification.access_mode, 'read_only')
  assert.equal(result.clarification.suggested_path, 'D:\\Reports')
  assert.equal(result.clarification.blocker_kind, 'permission')
  assert.equal(isLoopPauseResult(result), true)
})

test('request_directory: 拒绝空用途和非法读写模式', () => {
  assert.throws(() => requestDirectoryTool({}), /purpose/)
  assert.throws(() => requestDirectoryTool({ purpose: '输出文件', access_mode: 'all_files' }), /access_mode/)
})

test('request_directory spec tells models to request read_write for file changes', () => {
  const spec = AGENTIC_TOOL_SPECS.find((item) => item.function.name === 'request_directory')
  assert.match(spec.function.description, /create, edit, patch, rename, or delete files/)
  assert.match(spec.function.parameters.properties.access_mode.description, /require read_write/)
})

/* dispatcher + loop-pause helper */

test('dispatchAgenticTool 分发', async () => {
  const r1 = await dispatchAgenticTool('reflect', { observation: 'x', next_step: 'y' })
  assert.equal(r1.ok, true)
  const r2 = await dispatchAgenticTool('request_clarification', { question: 'q' })
  assert.equal(r2.paused, true)
  const r3 = await dispatchAgenticTool('request_directory', { purpose: 'read project files' })
  assert.equal(r3.clarification.request_type, 'directory')
  await assert.rejects(() => dispatchAgenticTool('unknown', {}), /unknown agentic tool/)
})

test('isLoopPauseResult: 只对 clarification 返回 true', () => {
  const r1 = reflectTool({ observation: 'x', next_step: 'y' })
  assert.equal(isLoopPauseResult(r1), false, 'reflect 不暂停')
  const r2 = requestClarificationTool({ question: '?' })
  assert.equal(isLoopPauseResult(r2), true, 'clarification 暂停')
  assert.equal(isLoopPauseResult(null), false)
  assert.equal(isLoopPauseResult({ ok: true }), false)
  assert.equal(isLoopPauseResult({ paused: true }), false, '没 clarification 不算')
})
