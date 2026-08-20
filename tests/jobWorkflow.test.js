import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFinalOutput,
  buildPriorStepsContext,
  evaluateTaskAcceptance,
  normalizeStructuredPlanSteps,
  parseTaskEvaluation,
  resolveWorkflowState,
  shouldCompileDocx,
  withStableStepIds,
} from '../server/services/jobWorkflow.js'

test('workflow gives duplicate plan ids stable unique job-scoped ids', () => {
  const steps = withStableStepIds('job-1', normalizeStructuredPlanSteps([
    { id: 'work', title: '步骤一' },
    { id: 'work', title: '步骤二' },
  ]))
  assert.deepEqual(steps.map((step) => step.id), [
    'job-1:work',
    'job-1:work-2',
    'job-1:verify',
    'job-1:finalize',
  ])
  assert.deepEqual(steps.map((step) => step.status), ['queued', 'queued', 'queued', 'queued'])
})

test('structured plan normalization preserves input metadata and description', () => {
  const [step] = normalizeStructuredPlanSteps([{
    id: 'inspect',
    title: '检查现状',
    description: '  先读取代码和测试  ',
    input: {
      taskType: 'code',
      acceptance: ['测试通过'],
      action: '读取项目',
    },
  }])

  assert.equal(step.input.description, '先读取代码和测试')
  assert.equal(step.input.taskType, 'code')
  assert.equal(step.input.action, '读取项目')
  assert.deepEqual(step.input.acceptance, ['测试通过'])
})

test('structured plan normalization always ends with one verify and one finalize step', () => {
  const steps = normalizeStructuredPlanSteps([
    { id: 'final', title: 'Custom delivery', kind: 'finalize' },
    { id: 'work', title: 'Do the work', kind: 'execute' },
    { id: 'check', title: 'Custom verification', kind: 'verify' },
    { id: 'duplicate-check', title: 'Duplicate verification', kind: 'verify' },
  ])

  assert.deepEqual(steps.map((step) => step.kind), ['execute', 'verify', 'finalize'])
  assert.equal(steps[1].title, 'Custom verification')
  assert.equal(steps[2].title, 'Custom delivery')
})

test('workflow refuses to report incomplete non-runnable work as completed', () => {
  const resolution = resolveWorkflowState([
    { title: '已完成', status: 'completed' },
    { title: '卡住', status: 'waiting' },
  ])
  assert.equal(resolution.state, 'blocked')
  assert.match(resolution.reason, /未完成/)
})

test('workflow refuses completed steps whose structured acceptance did not pass', () => {
  const resolution = resolveWorkflowState([
    { kind: 'execute', status: 'completed' },
    {
      kind: 'verify',
      status: 'completed',
      output: { acceptance: { verdict: 'blocked', summary: '缺少外部服务' } },
    },
    { kind: 'finalize', status: 'completed', output: { complete: true } },
  ])
  assert.equal(resolution.state, 'failed')
  assert.equal(resolution.reason, '缺少外部服务')
})

test('task evaluator prefers a structured verdict and normalizes its evidence', () => {
  const text = [
    'Checks finished.',
    '<task_evaluation>{"verdict":"fixable","summary":"One assertion failed","issues":["test A"],"evidence":["npm test: 1 failed"]}</task_evaluation>',
  ].join('\n')
  assert.deepEqual(parseTaskEvaluation(text), {
    verdict: 'fixable',
    summary: 'One assertion failed',
    issues: ['test A'],
    evidence: ['npm test: 1 failed'],
    source: 'model',
  })
  assert.equal(evaluateTaskAcceptance({ text }).verdict, 'fixable')
})

test('task evaluator falls back to a bounded repair verdict for legacy prose', () => {
  const acceptance = evaluateTaskAcceptance({ text: '构建失败，仍有错误需要修正。' })
  assert.equal(acceptance.verdict, 'fixable')
  assert.equal(acceptance.source, 'fallback')
})

test('prior step context carries completed results but not future work', () => {
  const context = buildPriorStepsContext([
    { id: 'a', title: '检查', status: 'completed', sortOrder: 0, output: { text: '发现问题 A' } },
    { id: 'b', title: '修改', status: 'queued', sortOrder: 1 },
  ], 'b')
  assert.match(context, /发现问题 A/)
  assert.doesNotMatch(context, /无文本输出/)
})

test('final output separates deliverable text from verification evidence', () => {
  const output = buildFinalOutput({
    steps: [
      { kind: 'execute', output: { text: '实际交付' } },
      { kind: 'verify', output: { text: '测试通过' } },
    ],
  })
  assert.equal(output.text, '实际交付')
  assert.deepEqual(output.evidence, ['测试通过'])
})

test('final output preserves bounded runtime review guard provenance', () => {
  const output = buildFinalOutput({
    steps: [
      { kind: 'execute', status: 'completed', output: { text: 'actual delivery' } },
      {
        kind: 'verify',
        status: 'completed',
        output: {
          text: 'verified',
          acceptance: {
            verdict: 'pass',
            summary: 'checks pass',
            issues: [],
            evidence: ['npm test: pass'],
            source: 'independent_reviewer',
            guard: {
              pluginId: 'release-policy-plugin',
              service: 'task-review-guard',
              mode: 'forged-mode',
              decision: 'pass',
              extra: 'must be dropped',
            },
          },
        },
      },
    ],
  })

  assert.deepEqual(output.acceptance.guard, {
    pluginId: 'release-policy-plugin',
    service: 'task-review-guard',
    mode: 'veto_only',
    decision: 'pass',
  })
})

test('Word compilation requires an explicit export intent', () => {
  assert.equal(shouldCompileDocx('整理会议纪要并导出'), true)
  assert.equal(shouldCompileDocx('修复代码并运行测试'), false)
  assert.equal(shouldCompileDocx('生成 PPT 并导出'), false)
})
