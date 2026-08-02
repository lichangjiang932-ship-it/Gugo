import test from 'node:test'
import assert from 'node:assert/strict'

import { buildOpenAICompatibleRequest, loadModelConfig } from '../server/adapters/modelProxy.js'
import { createJobBudget } from '../server/utils/jobBudget.js'
import { clipChatToolContent } from '../src/lib/chatFlowGuards.js'
import { DEFAULT_TOOL_OUTPUT_CHARS } from '../server/utils/toolCallHarness.js'

/* ------------------------------------------------------------------ *
 * max_tokens：不限制 = 不发字段
 * ------------------------------------------------------------------ */

test('MODEL_MAX_TOKENS 未设置时不发 max_tokens —— 交给模型自己的上限', () => {
  const config = loadModelConfig({
    MODEL_BASE_URL: 'https://api.example.com/v1',
    MODEL_NAME: 'm',
  })
  assert.equal(config.maxTokens, 0, '未设置应解析为 0(不限制)')

  const request = buildOpenAICompatibleRequest({
    config: { ...config, baseUrl: 'https://api.example.com/v1', modelName: 'm' },
    messages: [{ role: 'user', content: 'hi' }],
    env: {},
  })
  const body = JSON.parse(request.init.body)
  // ★ 关键:发一个大数字不如不发 —— 各家真实上限不同,填超了有些 provider 直接 400
  assert.equal('max_tokens' in body, false, '不限制时不该出现 max_tokens 字段')
})

test('显式写 0 / unlimited 也是不限制', () => {
  for (const value of ['0', 'unlimited', 'none', 'INF']) {
    const config = loadModelConfig({
      MODEL_BASE_URL: 'https://api.example.com/v1',
      MODEL_NAME: 'm',
      MODEL_MAX_TOKENS: value,
    })
    assert.equal(config.maxTokens, 0, `${value} 应解析为不限制`)
  }
})

test('显式配了正数仍然生效 —— 需要控成本的人不受影响', () => {
  const config = loadModelConfig({
    MODEL_BASE_URL: 'https://api.example.com/v1',
    MODEL_NAME: 'm',
    MODEL_MAX_TOKENS: '2048',
  })
  assert.equal(config.maxTokens, 2048)

  const body = JSON.parse(buildOpenAICompatibleRequest({
    config: { ...config, baseUrl: 'https://api.example.com/v1', modelName: 'm' },
    messages: [{ role: 'user', content: 'hi' }],
    env: {},
  }).init.body)
  assert.equal(body.max_tokens, 2048)
})

test('非法值当作不限制,不会退回一个小默认值把正文卡死', () => {
  const config = loadModelConfig({
    MODEL_BASE_URL: 'https://api.example.com/v1',
    MODEL_NAME: 'm',
    MODEL_MAX_TOKENS: '不是数字',
  })
  assert.equal(config.maxTokens, 0)
})

/* ------------------------------------------------------------------ *
 * 预算：墙钟可以完全关掉
 * ------------------------------------------------------------------ */

test('maxWallMs=0 = 不限时间,只靠调用次数收敛', () => {
  let clock = 0
  const budget = createJobBudget({ maxTotalCalls: 10, maxWallMs: 0, now: () => clock })
  clock += 10 * 60 * 60 * 1000 // 过去 10 小时
  const result = budget.consume(1)
  assert.equal(result.ok, true, '不限时间时不该因为墙钟被拒')
})

test('调用次数上限仍然是硬收敛点', () => {
  const budget = createJobBudget({ maxTotalCalls: 2, maxWallMs: 0 })
  assert.equal(budget.consume(1).ok, true)
  assert.equal(budget.consume(1).ok, true)
  assert.equal(budget.consume(1).ok, false, '次数用完必须停')
})

/* ------------------------------------------------------------------ *
 * 工具结果截断：放宽但仍然保护 JSON 结构
 * ------------------------------------------------------------------ */

test('工具结果上限已放宽到 24000 —— 读个大文件不再被砍掉大半', () => {
  assert.ok(DEFAULT_TOOL_OUTPUT_CHARS >= 24_000, `实际 ${DEFAULT_TOOL_OUTPUT_CHARS}`)
  // 一个 20000 字符的文件内容应该完整通过
  const content = 'x'.repeat(20_000)
  assert.equal(clipChatToolContent(content), content)
})

test('超过上限时仍然截断,且结果仍是合法 JSON(不切成语法残片)', () => {
  const huge = 'y'.repeat(60_000)
  const clipped = clipChatToolContent(huge)
  assert.ok(clipped.length < huge.length, '超长内容仍要截断')
  const parsed = JSON.parse(clipped)
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.originalChars, 60_000)
})
