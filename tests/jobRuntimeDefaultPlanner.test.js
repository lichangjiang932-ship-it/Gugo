import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultJobPlanner } from '../server/services/jobRuntimeDefaultPlanner.js'

test('default job planner forwards the full planning context through both model ports', async () => {
  const calls = []
  const modelEnv = { MODEL_NAME: 'planner-model' }
  const planner = createDefaultJobPlanner({
    buildPlan: async (prompt, options) => ({
      prompt,
      userId: options.userId,
      exploration: await options.exploreModel({ messages: ['explore-message'] }),
      planning: await options.runModel({ messages: ['planning-message'] }),
    }),
    explorePlan: async (input) => {
      calls.push({ port: 'explore', input })
      return 'explored'
    },
    runPlanningModel: async (input) => {
      calls.push({ port: 'model', input })
      return 'planned'
    },
  })

  const result = await planner('ship the workspace', {
    userId: 'user-a',
    modelName: 'planner-model',
    modelEnv,
  })

  assert.deepEqual(result, {
    prompt: 'ship the workspace',
    userId: 'user-a',
    exploration: 'explored',
    planning: 'planned',
  })
  assert.deepEqual(calls, [
    {
      port: 'explore',
      input: {
        prompt: 'ship the workspace',
        messages: ['explore-message'],
        userId: 'user-a',
        modelName: 'planner-model',
        modelEnv,
      },
    },
    {
      port: 'model',
      input: {
        messages: ['planning-message'],
        userId: 'user-a',
        modelName: 'planner-model',
        modelEnv,
      },
    },
  ])
})
