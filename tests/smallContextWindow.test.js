import test from 'node:test'
import assert from 'node:assert/strict'

import { isContextLengthError } from '../server/adapters/modelProxy.js'
import {
  callModelWithContextRecovery,
  getAutoCompactionThreshold,
} from '../server/services/contextCompactionRuntime.js'

/* ------------------------------------------------------------------ *
 * 上下文窗口:小模型的真实窗口不能被硬下限顶掉
 * ------------------------------------------------------------------ */

test('小窗口不再被硬下限换成默认值 —— 阈值必须跟着真实窗口走', () => {
  // ★ 原实现 `>= 4096` 的下限会把 2048 悄悄换成 DEFAULT_CONTEXT_WINDOW,
  // 算出来的阈值比实际窗口大好几倍,压缩永远不触发,每个请求必然溢出。
  assert.equal(getAutoCompactionThreshold(2048), Math.floor(2048 * 0.8))
  assert.equal(getAutoCompactionThreshold(4096), Math.floor(4096 * 0.8))
  assert.equal(getAutoCompactionThreshold(8192), Math.floor(8192 * 0.8))
})

test('非法窗口值仍然回落默认值,不会算出 0 阈值', () => {
  assert.ok(getAutoCompactionThreshold(0) > 0)
  assert.ok(getAutoCompactionThreshold(-1) > 0)
  assert.ok(getAutoCompactionThreshold(NaN) > 0)
  assert.ok(getAutoCompactionThreshold(undefined) > 0)
})

/* ------------------------------------------------------------------ *
 * 上下文溢出识别:本地推理服务器各说各话
 * ------------------------------------------------------------------ */

test('认得各家本地推理服务器的上下文溢出文案', () => {
  const cases = [
    // llama.cpp
    { status: 400, message: 'the request exceeds the available context size' },
    { status: 500, message: 'n_ctx exceeded for this request' },
    // vLLM
    { status: 400, message: "This model's maximum context length is 4096 tokens" },
    // 有些实现直接返 413 而不是 400
    { status: 413, message: 'prompt is too long' },
    // Ollama / 其它
    { status: 400, message: 'input is too long for the model' },
    { status: 400, message: 'KV cache is full' },
    // OpenAI 原本就认得的,不能回归
    { status: 400, message: 'context_length_exceeded' },
    { status: 400, message: 'Please reduce the length of the messages' },
  ]
  for (const error of cases) {
    assert.equal(isContextLengthError(error), true, `应识别: ${error.message}`)
  }
})

test('不把无关错误误判成上下文溢出', () => {
  const cases = [
    { status: 401, message: 'invalid api key' },
    { status: 404, message: 'model not found' },
    { status: 400, message: 'invalid tool_choice value' },
    { status: 429, message: 'rate limit exceeded' },
    { status: 500, message: 'internal server error' },
    {},
    null,
  ]
  for (const error of cases) {
    assert.equal(isContextLengthError(error), false, `不该识别: ${JSON.stringify(error)}`)
  }
})

/* ------------------------------------------------------------------ *
 * 三级恢复:每一级都要真的被走到,最后失败要给人话
 * ------------------------------------------------------------------ */

function contextError() {
  const error = new Error('the request exceeds the available context size')
  error.status = 400
  return error
}

test('第一次溢出后强制压缩重试,成功就正常返回', async () => {
  let attempts = 0
  const result = await callModelWithContextRecovery({
    messages: [
      { role: 'system', content: '系统指令' },
      ...Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `消息 ${i} `.repeat(50) })),
    ],
    tools: [],
    contextWindow: 4096,
    isContextLengthError,
    callModel: async () => {
      attempts += 1
      if (attempts === 1) throw contextError()
      return { content: '压缩之后就跑通了', toolCalls: [] }
    },
  })
  assert.ok(attempts >= 2, '第一次溢出后必须再试')
  assert.equal(result.response.content, '压缩之后就跑通了')
})

test('三级全部失败时给出可操作的说明,而不是上游原文', async () => {
  await assert.rejects(
    () => callModelWithContextRecovery({
      messages: [
        { role: 'system', content: '系统指令' },
        ...Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `消息 ${i} `.repeat(50) })),
      ],
      tools: [],
      contextWindow: 2048,
      isContextLengthError,
      // 无论压缩成什么样都塞不下 —— 模拟「工具 schema 本身就超窗」
      callModel: async () => { throw contextError() },
    }),
    (error) => {
      assert.equal(error.code, 'CONTEXT_UNRECOVERABLE')
      // ★ 原实现第三级没有 catch,冒上去的是 "the request exceeds..." 这种
      // 用户完全不知道该做什么的原文。
      assert.match(error.message, /上下文窗口|工具/)
      return true
    },
  )
})

test('非上下文错误不走恢复流程,原样上抛', async () => {
  await assert.rejects(
    () => callModelWithContextRecovery({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      contextWindow: 8192,
      isContextLengthError,
      callModel: async () => {
        const error = new Error('invalid api key')
        error.status = 401
        throw error
      },
    }),
    /invalid api key/,
  )
})
