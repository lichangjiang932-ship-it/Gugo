import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInitialPlan } from '../server/services/jobPlanner.js'

test('planner creates batch children when prompt mentions multiple outputs', () => {
  const plan = buildInitialPlan('生成 3 份行业周报并导出')
  assert.equal(plan.title, '生成 3 份行业周报并导出')
  assert.equal(plan.steps[0].kind, 'plan')
  assert.equal(plan.steps.filter((step) => step.kind === 'batch_item').length, 3)
  assert.equal(plan.steps.at(-1).kind, 'finalize')
})

test('planner falls back to a simple execution plan', () => {
  const plan = buildInitialPlan('整理今天的会议纪要')
  assert.deepEqual(plan.steps.map((step) => step.kind), ['plan', 'execute', 'finalize'])
})

test('planner recognizes Chinese numerals in batch prompts', () => {
  const plan = buildInitialPlan('生成十份招商文案')
  assert.equal(plan.steps.filter((step) => step.kind === 'batch_item').length, 10)
})

