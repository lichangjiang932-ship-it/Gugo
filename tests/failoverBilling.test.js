import test from 'node:test'
import assert from 'node:assert/strict'

import { isProviderFailoverError, resolveModelFailoverConfigs } from '../server/adapters/modelProxy.js'
import { isRetryableError } from '../server/utils/modelRetry.js'

/**
 * 一次真实事故里同时暴露的三件事:
 *
 *   1. 用户在 UI 里选了 deepseek-v4-flash(0.6× 计费),
 *      一个 network error 触发故障转移,而 mimo provider 没有这个模型名,
 *      于是回落到 provider.models[0] = mimo-v2.5 —— 换了**另一个厂商的
 *      另一个模型**跑完并按它的价格扣费。用户看到的是「我选的 flash,
 *      账单却不是 flash」。
 *   2. 同一轮里思考了 167644 字(≈84000 token),全部按输出计费。
 *   3. 最后以 network error 收场,前面 30+ 步工具调用的成果全部静默作废。
 */

const ENV = {
  MODEL_PROVIDERS: 'deepseek,mimo',
  MODEL_PROVIDER_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  MODEL_PROVIDER_DEEPSEEK_API_KEY: 'sk-d',
  MODEL_PROVIDER_DEEPSEEK_MODELS: 'deepseek-v4-pro,deepseek-v4-flash',
  MODEL_PROVIDER_MIMO_BASE_URL: 'https://api.xiaomimimo.com/v1',
  MODEL_PROVIDER_MIMO_API_KEY: 'sk-m',
  MODEL_PROVIDER_MIMO_MODELS: 'mimo-v2.5,mimo-v2.5-pro',
  MODEL_NAME: 'deepseek-v4-pro',
}

test('★ 默认不跨模型转移 —— 选了 flash 就绝不会跑成别家的模型', () => {
  const configs = resolveModelFailoverConfigs({ modelName: 'deepseek-v4-flash', env: ENV })
  const models = configs.map((c) => c.modelName)
  assert.deepEqual(models, ['deepseek-v4-flash'], `不该出现别的模型，实际: ${models.join(', ')}`)
})

test('同名模型在多个 provider 之间转移是安全的,要保留', () => {
  // 两个 provider 都提供 deepseek-v4-flash(镜像/中转站场景)
  const env = {
    ...ENV,
    MODEL_PROVIDER_MIMO_MODELS: 'deepseek-v4-flash,mimo-v2.5',
  }
  const configs = resolveModelFailoverConfigs({ modelName: 'deepseek-v4-flash', env })
  assert.equal(configs.length, 2, '同名模型的备用 provider 应保留')
  for (const c of configs) {
    assert.equal(c.modelName, 'deepseek-v4-flash', '转移后模型名必须一致')
  }
})

test('严格粘滞关闭且显式开跨模型开关时才允许跨模型', () => {
  const configs = resolveModelFailoverConfigs({
    modelName: 'deepseek-v4-flash',
    env: { ...ENV, MODEL_STRICT_SELECTION: '0', MODEL_FAILOVER_CROSS_MODEL: '1' },
  })
  assert.equal(configs.length, 2)
  assert.equal(configs[1].modelName, 'mimo-v2.5')
})

test('严格粘滞优先级最高：即使遗留配置允许 failover 也不能换模型', () => {
  const configs = resolveModelFailoverConfigs({
    modelName: 'deepseek-v4-flash',
    env: { ...ENV, MODEL_STRICT_SELECTION: '1', MODEL_FAILOVER_CROSS_MODEL: '1' },
  })
  assert.deepEqual(configs.map((c) => c.modelName), ['deepseek-v4-flash'])
})

test('思考失控不触发故障转移 —— 换个 provider 只会再烧一次钱', () => {
  const error = new Error('思考超限')
  error.code = 'REASONING_RUNAWAY'
  assert.equal(isProviderFailoverError(error), false)
})

test('思考失控也不重试 —— 问题不在网络层', () => {
  const error = new Error('思考超限')
  error.code = 'REASONING_RUNAWAY'
  assert.equal(isRetryableError(error), false)
})

test('超时依然不触发转移(既有行为没被破坏)', () => {
  const error = new Error('超时')
  error.code = 'MODEL_TIMEOUT'
  assert.equal(isProviderFailoverError(error), false)
  assert.equal(isRetryableError(error), false)
})

test('真正的上游 5xx 仍然可以转移(没有误伤正常的故障转移)', () => {
  const error = new Error('bad gateway')
  error.status = 502
  assert.equal(isProviderFailoverError(error), true)
})
