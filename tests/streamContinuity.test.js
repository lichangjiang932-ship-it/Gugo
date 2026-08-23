import test from 'node:test'
import assert from 'node:assert/strict'

import { StreamTruncatedError, callModelThroughProxyStream } from '../src/lib/modelClient.js'

/** 造一个假的 SSE 响应。frames 是要下发的原始行。 */
function fakeSseFetch(frames, { ok = true, status = 200 } = {}) {
  return async () => {
    if (!ok) {
      return { ok: false, status, json: async () => ({ error: '上游拒绝' }) }
    }
    let index = 0
    const encoder = new TextEncoder()
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= frames.length) return { done: true, value: undefined }
            const frame = frames[index]
            index += 1
            return { done: false, value: encoder.encode(frame) }
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    }
  }
}

function dataFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

async function collect(stream) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}

test('收到 done 帧 = 正常结束,不报错', async () => {
  const events = await collect(callModelThroughProxyStream({
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: fakeSseFetch([
      dataFrame({ ok: true, delta: '你好' }),
      dataFrame({ ok: true, delta: '世界' }),
      dataFrame({ ok: true, done: true }),
    ]),
  }))
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('')
  assert.equal(text, '你好世界')
})

test('★ done 帧没有正文或工具调用不能伪装成成功', async () => {
  await assert.rejects(
    () => collect(callModelThroughProxyStream({
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeSseFetch([
        dataFrame({ ok: true, phase: 'connecting' }),
        dataFrame({ ok: true, done: true, finishReason: 'stop' }),
      ]),
    })),
    (error) => {
      assert.equal(error.code, 'EMPTY_MODEL_RESPONSE')
      assert.match(error.message, /empty reply/i)
      return true
    },
  )
})

test('只有思考过程且预算耗尽时给出明确错误', async () => {
  await assert.rejects(
    () => collect(callModelThroughProxyStream({
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeSseFetch([
        dataFrame({ ok: true, reasoning: '仍在思考' }),
        dataFrame({ ok: true, done: true, finishReason: 'length' }),
      ]),
    })),
    (error) => {
      assert.equal(error.code, 'EMPTY_MODEL_RESPONSE_LENGTH')
      assert.match(error.message, /output budget/i)
      return true
    },
  )
})

test('★ 没有 done 帧就断开 = 截断,必须报错而不是静默结束', async () => {
  // 这是原实现最危险的行为:`if (done) break` 让「连接被掐断」和
  // 「模型正常说完了」完全无法区分 —— 用户看到半句话,没有任何提示。
  await assert.rejects(
    () => collect(callModelThroughProxyStream({
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeSseFetch([
        dataFrame({ ok: true, delta: '我正要说' }),
        // 流到此为止,没有 done 帧
      ]),
    })),
    (error) => {
      assert.equal(error.code, 'STREAM_TRUNCATED')
      assert.equal(error.name, 'StreamTruncatedError')
      // 已经生成的内容必须保留下来,供「继续生成」使用
      assert.equal(error.partialText, '我正要说')
      return true
    },
  )
})

test('一个字都没收到就断开,给出「检查本地模型服务」的提示', async () => {
  await assert.rejects(
    () => collect(callModelThroughProxyStream({
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeSseFetch([]),
    })),
    (error) => {
      assert.equal(error.code, 'STREAM_TRUNCATED')
      assert.equal(error.partialText, '')
      assert.match(error.message, /本地模型服务/)
      return true
    },
  )
})

test('心跳注释帧被忽略,不影响正文,也不算畸形 chunk', async () => {
  const events = await collect(callModelThroughProxyStream({
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: fakeSseFetch([
      ': keepalive\n\n',
      dataFrame({ ok: true, delta: 'A' }),
      ': keepalive\n\n',
      dataFrame({ ok: true, delta: 'B' }),
      dataFrame({ ok: true, done: true }),
    ]),
  }))
  const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('')
  assert.equal(text, 'AB')
})

test('phase 帧透传给上层 —— 前端据此显示「模型加载中」', async () => {
  const events = await collect(callModelThroughProxyStream({
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: fakeSseFetch([
      dataFrame({ ok: true, phase: 'connecting' }),
      dataFrame({ ok: true, phase: 'streaming', firstTokenLatency: 42000 }),
      dataFrame({ ok: true, delta: '终于' }),
      dataFrame({ ok: true, done: true }),
    ]),
  }))
  const phases = events.filter((e) => e.type === 'phase')
  assert.equal(phases.length, 2)
  assert.equal(phases[0].phase, 'connecting')
  assert.equal(phases[1].firstTokenLatency, 42000)
})

test('后端错误帧带上 code/timeoutPhase,前端能区分超时和上游拒绝', async () => {
  await assert.rejects(
    () => collect(callModelThroughProxyStream({
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeSseFetch([
        dataFrame({ ok: true, delta: '半句' }),
        dataFrame({ ok: false, error: '模型 600 秒内没有返回第一个字', code: 'MODEL_TIMEOUT', timeoutPhase: 'first_token' }),
      ]),
    })),
    (error) => {
      assert.equal(error.code, 'MODEL_TIMEOUT')
      assert.equal(error.timeoutPhase, 'first_token')
      assert.equal(error.partialText, '半句')
      return true
    },
  )
})

test('用户中止抛 AbortError 而不是中文 message —— 上层靠 name 判断', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => collect(callModelThroughProxyStream({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      fetchImpl: fakeSseFetch([dataFrame({ ok: true, delta: 'x' })]),
    })),
    (error) => {
      // 原来上层比对 err.message === '已停止生成',而真实 abort 抛的是
      // DOMException("The user aborted a request.") —— 对不上就走失败分支。
      assert.equal(error.name, 'AbortError')
      assert.equal(error.code, 'USER_STOPPED')
      return true
    },
  )
})

test('tool_calls 帧仍然正常工作(没有回归)', async () => {
  const events = await collect(callModelThroughProxyStream({
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: fakeSseFetch([
      dataFrame({ ok: true, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }], finishReason: 'tool_calls' }),
      dataFrame({ ok: true, done: true }),
    ]),
  }))
  const toolEvent = events.find((e) => e.type === 'tool_calls')
  assert.ok(toolEvent)
  assert.equal(toolEvent.toolCalls[0].name, 'read_file')
})

test('StreamTruncatedError 可被 instanceof 识别', () => {
  const error = new StreamTruncatedError('断了', { partialText: 'abc' })
  assert.ok(error instanceof StreamTruncatedError)
  assert.ok(error instanceof Error)
  assert.equal(error.partialText, 'abc')
})

test('★ 有正文时 finish_reason=length 抛出带 partialText 的截断错误', async () => {
  await assert.rejects(
    () => collect(callModelThroughProxyStream({
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: fakeSseFetch([
        dataFrame({ ok: true, delta: '正文开头' }),
        dataFrame({ ok: true, done: true, finishReason: 'length' }),
      ]),
    })),
    (error) => {
      assert.equal(error.code, 'STREAM_TRUNCATED')
      assert.equal(error.reason, 'length')
      assert.equal(error.partialText, '正文开头')
      return true
    },
  )
})

test('正常结束时 finishReason 是 stop,不误报截断', async () => {
  const events = await collect(callModelThroughProxyStream({
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: fakeSseFetch([
      dataFrame({ ok: true, delta: '说完了' }),
      dataFrame({ ok: true, done: true, finishReason: 'stop' }),
    ]),
  }))
  const complete = events.find((e) => e.type === 'complete')
  assert.equal(complete?.finishReason, 'stop')
})
