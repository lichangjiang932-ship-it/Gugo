import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateModelCostUsd } from '../server/adapters/modelUsage.js'

test('provider token rates calculate dollars for job hard budgets', () => {
  const cost = calculateModelCostUsd({
    modelName: 'deepseek-v4-flash',
    usage: { promptTokens: 2_000_000, completionTokens: 500_000 },
    env: {
      MODEL_USD_RATES: JSON.stringify({
        'deepseek-v4-flash': { input: 0.1, output: 0.4 },
      }),
    },
  })
  assert.equal(cost, 0.4)
  assert.equal(calculateModelCostUsd({ modelName: 'missing', usage: {}, env: {} }), 0)
})
