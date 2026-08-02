import assert from 'node:assert/strict'
import test from 'node:test'
import { buildExploredPlan, buildInitialPlan } from '../server/services/jobPlanner.js'

test('planner creates batch children when prompt mentions multiple outputs', () => {
  const plan = buildInitialPlan('生成 3 份行业周报并导出')
  assert.equal(plan.title, '生成 3 份行业周报并导出')
  assert.equal(plan.steps[0].kind, 'plan')
  assert.equal(plan.steps.filter((step) => step.kind === 'batch_item').length, 3)
  assert.equal(plan.steps.at(-1).kind, 'finalize')
})

test('planner falls back to a simple execution plan', () => {
  const plan = buildInitialPlan('整理今天的会议纪要')
  assert.deepEqual(plan.steps.map((step) => step.kind), ['plan', 'execute', 'verify', 'finalize'])
  assert.ok(plan.acceptance.length >= 3)
})

test('planner does not classify PPT complaints as presentation work', () => {
  for (const prompt of [
    '不要生成 PPT，只修复代码',
    '修复自动生成幻灯片的问题',
    '为什么输出会突然变成 pptx 文件',
    '还有在生成幻灯片.pptx文件，我没有让他生成，他自动生成，你深入解读代码，彻底修复',
  ]) {
    const plan = buildInitialPlan(prompt)
    assert.notEqual(plan.taskType, 'presentation', prompt)
    assert.equal(plan.acceptance.includes('所需文件已生成并可下载'), false, prompt)
  }
})

test('planner recognizes Chinese numerals in batch prompts', () => {
  const plan = buildInitialPlan('生成十份招商文案')
  assert.equal(plan.steps.filter((step) => step.kind === 'batch_item').length, 10)
})

test('model planner explores first and only then produces a structured plan', async () => {
  const phases = []
  const plan = await buildExploredPlan('修复页面刷新并验证', {
    userId: 'user-plan',
    runModel: async ({ phase }) => {
      phases.push(phase)
      if (phase === 'explore') return '入口在路由和状态恢复逻辑；需要验证直接刷新。'
      return JSON.stringify({
        title: '修复页面刷新',
        taskType: 'code',
        acceptance: ['刷新后路由可恢复', '相关测试通过'],
        steps: [
          { kind: 'execute', title: '修复路由状态恢复' },
          { kind: 'verify', title: '验证直接刷新与回归测试' },
          { kind: 'finalize', title: '整理改动说明' },
        ],
      })
    },
  })
  assert.deepEqual(phases, ['explore', 'plan'])
  assert.equal(plan.planningSource, 'model')
  assert.match(plan.steps[0].input.exploration, /路由/)
  assert.deepEqual(plan.steps.map((step) => step.kind), ['plan', 'execute', 'verify', 'finalize'])
})

test('model planner falls back deterministically when exploration fails', async () => {
  const plan = await buildExploredPlan('生成 2 份报告', {
    runModel: async () => { throw new Error('provider unavailable') },
  })
  assert.equal(plan.planningSource, 'fallback')
  assert.equal(plan.steps.filter((step) => step.kind === 'batch_item').length, 2)
})

