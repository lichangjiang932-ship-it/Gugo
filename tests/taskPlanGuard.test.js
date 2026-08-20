import assert from 'node:assert/strict'
import test from 'node:test'

import { applyRuntimeTaskPlanGuard } from '../server/services/taskPlanGuard.js'

function input(overrides = {}) {
  return {
    plan: {
      title: 'Release the verified build',
      prompt: 'Build, verify, and release the package',
      taskType: 'code',
      planningSource: 'model',
      secret: 'must not cross the guard boundary',
      steps: [
        {
          title: 'Build package',
          kind: 'execute',
          input: {
            description: 'Create the package',
            action: 'run build',
            risk: 'medium',
            targets: ['dist/package.zip'],
            acceptance: ['build succeeds'],
            transcript: 'must not cross the guard boundary',
          },
        },
      ],
    },
    modelName: 'worker-model',
    requirePlanApproval: false,
    ...overrides,
  }
}

test('task plan guard is absent by default and preserves explicit approval requirements', async () => {
  const invokePluginService = async () => ({ found: false, pluginId: null, value: undefined })
  assert.deepEqual(await applyRuntimeTaskPlanGuard(input(), { invokePluginService }), {
    requirePlanApproval: false,
    guard: null,
  })
  assert.deepEqual(await applyRuntimeTaskPlanGuard(input({ requirePlanApproval: true }), { invokePluginService }), {
    requirePlanApproval: true,
    guard: null,
  })
})

test('task plan guard receives a frozen bounded projection and can only require approval', async () => {
  let observedScope = null
  const plan = input().plan
  const result = await applyRuntimeTaskPlanGuard(input({
    plan: {
      ...plan,
      prompt: 'o'.repeat(10_000),
      steps: Array.from({ length: 60 }, (_, index) => ({
        ...plan.steps[0],
        title: `Step ${index + 1}`,
        input: {
          ...plan.steps[0].input,
          acceptance: ['a'.repeat(2_000)],
        },
      })),
    },
  }), {
    invokePluginService: async (name, method, args) => {
      assert.equal(name, 'task-plan-guard')
      assert.equal(method, 'review')
      observedScope = args[0]
      return {
        found: true,
        pluginId: 'release-policy-plugin',
        value: {
          decision: 'require_approval',
          steps: [{ title: 'malicious replacement must be ignored' }],
          requirePlanApproval: false,
        },
      }
    },
  })

  assert.equal(Object.isFrozen(observedScope), true)
  assert.equal(Object.isFrozen(observedScope.steps), true)
  assert.equal(Object.isFrozen(observedScope.steps[0]), true)
  assert.equal(Object.isFrozen(observedScope.steps[0].acceptance), true)
  assert.deepEqual(Object.keys(observedScope), [
    'title',
    'objective',
    'taskType',
    'planningSource',
    'modelName',
    'requirePlanApproval',
    'steps',
  ])
  assert.equal('secret' in observedScope, false)
  assert.equal('input' in observedScope.steps[0], false)
  assert.equal('transcript' in observedScope.steps[0], false)
  assert.equal(observedScope.objective.length, 8_000)
  assert.equal(observedScope.steps.length, 50)
  assert.equal(observedScope.steps[0].acceptance[0].length, 1_000)
  assert.deepEqual(result, {
    requirePlanApproval: true,
    guard: {
      pluginId: 'release-policy-plugin',
      service: 'task-plan-guard',
      mode: 'approval_only',
      decision: 'require_approval',
    },
  })
})

test('task plan guard pass cannot cancel an approval already required by the host', async () => {
  const result = await applyRuntimeTaskPlanGuard(input({ requirePlanApproval: true }), {
    invokePluginService: async () => ({
      found: true,
      pluginId: 'advisory-plugin',
      value: { decision: 'pass', requirePlanApproval: false },
    }),
  })

  assert.deepEqual(result, {
    requirePlanApproval: true,
    guard: {
      pluginId: 'advisory-plugin',
      service: 'task-plan-guard',
      mode: 'approval_only',
      decision: 'pass',
    },
  })
})

test('active task plan guard errors and invalid results fail closed to explicit approval', async () => {
  const cases = [
    {
      invokePluginService: async () => ({ found: true, pluginId: 'invalid-guard', value: { decision: 'deny' } }),
      code: 'TASK_PLAN_GUARD_RESULT_INVALID',
      pluginId: 'invalid-guard',
    },
    {
      invokePluginService: async () => {
        throw Object.assign(new Error('private plugin details'), {
          code: 'PLUGIN_SERVICE_CALL_FAILED',
          pluginId: 'failed-guard',
        })
      },
      code: 'PLUGIN_SERVICE_CALL_FAILED',
      pluginId: 'failed-guard',
    },
  ]

  for (const item of cases) {
    const result = await applyRuntimeTaskPlanGuard(input(), item)
    assert.equal(result.requirePlanApproval, true)
    assert.deepEqual(result.guard, {
      pluginId: item.pluginId,
      service: 'task-plan-guard',
      mode: 'approval_only',
      decision: 'error',
      error: item.code,
    })
    assert.doesNotMatch(JSON.stringify(result), /private plugin details/)
  }
})
