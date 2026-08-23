import { getAuthToken } from '../accountClient.js'
import { z } from 'zod'

const SSE_CHUNK_SCHEMA = z.union([
  z.object({
    ok: z.literal(false),
    error: z.string().optional(),
    // \u540e\u7aef\u533a\u5206\u300c\u6211\u4eec\u5224\u5b9a\u8d85\u65f6\u300d\u548c\u300c\u4e0a\u6e38\u62d2\u7edd\u300d,\u524d\u7aef\u636e\u6b64\u7ed9\u4e0d\u540c\u7684\u8865\u6551\u63d0\u793a
    code: z.string().nullable().optional(),
    timeoutPhase: z.string().nullable().optional(),
    partial: z.boolean().optional(),
  }),
  z.object({
    done: z.literal(true),
    injectedMemoryIds: z.array(z.string()).optional(),
    // 'length' = \u88ab max_tokens \u622a\u65ad;'stop' = \u6a21\u578b\u81ea\u5df1\u8bf4\u5b8c\u4e86
    finishReason: z.string().nullable().optional(),
  }),
  z.object({ toolCalls: z.array(z.any()).min(1), finishReason: z.string().optional() }),
  z.object({ toolCallReady: z.any(), toolCallIndex: z.number().int().nonnegative().optional() }),
  z.object({ delta: z.string() }),
  z.object({ reasoning: z.string() }),
  // \u8fde\u63a5/\u52a0\u8f7d\u9636\u6bb5\u5e27:\u9996 token \u4e4b\u524d\u544a\u8bc9\u524d\u7aef\u300c\u5df2\u8fde\u4e0a,\u6a21\u578b\u6b63\u5728\u52a0\u8f7d\u300d
  z.object({ phase: z.string(), firstTokenLatency: z.number().nullable().optional() }).passthrough(),
  // \u672a\u6765\u517c\u5bb9:\u4efb\u610f\u5e26 ok=true \u7684\u72b6\u6001\u5e27
  z.object({ ok: z.literal(true) }).passthrough(),
])

export class StreamTruncatedError extends Error {
  constructor(message, { partialText = '', reason = 'truncated' } = {}) {
    super(message)
    this.name = 'StreamTruncatedError'
    this.code = 'STREAM_TRUNCATED'
    this.partialText = partialText
    this.reason = reason
  }
}

/** \u5ba2\u6237\u7aef idle \u8d85\u65f6\u3002\u670d\u52a1\u7aef\u6bcf 15s \u53d1\u5fc3\u8df3,\u6240\u4ee5\u6b63\u5e38\u60c5\u51b5\u4e0b\u6c38\u8fdc\u4e0d\u4f1a\u89e6\u53d1\u3002 */
const CLIENT_IDLE_TIMEOUT_MS = 120_000

/** \u7ed9 reader.read() \u5957\u4e00\u4e2a\u8d85\u65f6,\u907f\u514d socket \u534a\u5f00\u65f6\u6c38\u8fdc\u6302\u7740\u3002 */
function readWithIdleTimeout(reader, timeoutMs) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new StreamTruncatedError('\u4e0e\u6a21\u578b\u7684\u8fde\u63a5\u5df2\u4e2d\u65ad\uff08\u8d85\u65f6\u6ca1\u6709\u6536\u5230\u4efb\u4f55\u6570\u636e\uff09\u3002', { reason: 'idle' }))
    }, timeoutMs)
  })
  return Promise.race([reader.read(), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export async function* callModelThroughProxyStream({ messages, modelName, modelProviderId, agentId, sessionId, fetchImpl = fetch, signal, tools, toolChoice, idleTimeoutMs = CLIENT_IDLE_TIMEOUT_MS, maxTokensBoost = 0 }) {
  const body = { messages, modelName, modelProviderId, agentId, sessionId, stream: true }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    if (toolChoice) body.tool_choice = toolChoice
  }
  // \u6536\u5c3e\u8c03\u7528\u8981\u66f4\u5927\u7684\u8f93\u51fa\u9884\u7b97 \u2014\u2014 \u63a8\u7406\u6a21\u578b\u7684\u300c\u601d\u8003\u300d\u4f1a\u628a\u9ed8\u8ba4\u989d\u5ea6\u5403\u5149
  if (Number(maxTokensBoost) > 0) body.maxTokensBoost = Number(maxTokensBoost)
  const response = await fetchImpl('/api/model/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    let data
    try { data = await response.json() } catch { data = null }
    throw new Error(data?.error || `\u6a21\u578b\u8bf7\u6c42\u5931\u8d25\uff1aHTTP ${response.status}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('\u65e0\u6cd5\u8bfb\u53d6\u6d41\u5f0f\u54cd\u5e94')

  const decoder = new TextDecoder()
  let buffer = ''
  // \u2605 \u8ddf\u8e2a\u662f\u5426\u771f\u7684\u6536\u5230\u8fc7 done \u5e27 \u2014\u2014 \u8fd9\u662f\u300c\u6b63\u5e38\u7ed3\u675f\u300d\u7684\u552f\u4e00\u51ed\u636e\u3002
  let sawDone = false
  // done \u53ea\u80fd\u8bc1\u660e\u534f\u8bae\u7ed3\u675f\uff0c\u4e0d\u80fd\u8bc1\u660e\u6a21\u578b\u771f\u7684\u56de\u7b54\u4e86\u3002\u6b63\u6587\u6216\u5de5\u5177\u8c03\u7528\u81f3\u5c11\u8981\u6709\u4e00\u4e2a\u3002
  let sawUsableOutput = false
  let readerEnded = false
  // \u5df2\u7ecf\u5410\u51fa\u53bb\u7684\u6b63\u6587,\u622a\u65ad\u65f6\u968f\u9519\u8bef\u4e00\u8d77\u4ea4\u7ed9\u4e0a\u5c42,\u7528\u4e8e\u300c\u7ee7\u7eed\u751f\u6210\u300d\u3002
  let partialText = ''
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel()
        // \u2605 \u7528\u6807\u51c6\u7684 AbortError \u800c\u4e0d\u662f\u4e2d\u6587 message\u3002
        // \u4e0a\u5c42\u539f\u6765\u6bd4\u5bf9 err.message === '\u5df2\u505c\u6b62\u751f\u6210',\u800c\u771f\u5b9e\u7684 AbortController
        // \u629b\u7684\u662f DOMException("The user aborted a request.") \u2014\u2014 \u4e24\u8fb9\u5bf9\u4e0d\u4e0a,
        // \u4e8e\u662f\u7528\u6237\u6309\u300c\u505c\u6b62\u300d\u4f1a\u8d70\u5230\u5931\u8d25\u5206\u652f:\u5f39\u9519\u8bef toast\u3001\u628a\u300c\u6a21\u578b\u8c03\u7528\u5931\u8d25\u300d
        // \u585e\u8fdb\u6d88\u606f\u91cc\u3001\u5199\u4e00\u6761 FAILED \u5386\u53f2\u3002
        const abortError = new Error('\u5df2\u505c\u6b62\u751f\u6210')
        abortError.name = 'AbortError'
        abortError.code = 'USER_STOPPED'
        throw abortError
      }
      const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs)
      if (done) {
        readerEnded = true
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        // ': keepalive' \u8fd9\u7c7b SSE \u6ce8\u91ca\u5e27\u6309\u89c4\u8303\u5ffd\u7565 \u2014\u2014 \u5b83\u4eec\u53ea\u662f\u7528\u6765\u4fdd\u6301\u8fde\u63a5\u6d3b\u7740
        if (trimmed.startsWith(':')) continue
        if (!trimmed.startsWith('data: ')) continue
        const payload = trimmed.slice(6)
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          // Ignore non-JSON keepalive/debug lines without hiding backend error events.
          continue
        }
        // \u2605 #18: schema \u6821\u9a8c \u2014 \u4e0d\u7b26\u5408\u4efb\u4f55\u5df2\u77e5\u5f62\u6001\u7684 chunk \u8df3\u8fc7 (\u4f46\u4fdd\u7559 ok:false \u9519\u8bef\u629b\u51fa\u8def\u5f84)
        const validated = SSE_CHUNK_SCHEMA.safeParse(chunk)
        if (!validated.success) {
          if (typeof console !== 'undefined') {
            console.warn('[modelClient] \u8df3\u8fc7\u7578\u5f62 SSE chunk:', validated.error.issues?.[0]?.message)
          }
          continue
        }
        chunk = validated.data
        if (chunk.ok === false) {
          const error = new Error(chunk.error || '\u6d41\u5f0f\u54cd\u5e94\u9519\u8bef')
          error.code = chunk.code || null
          error.timeoutPhase = chunk.timeoutPhase || null
          error.partialText = partialText
          throw error
        }
        if (chunk.done) {
          sawDone = true
          if (chunk.finishReason === 'length' && partialText.trim()) {
            throw new StreamTruncatedError(
              'The model response reached its output limit before completion.',
              { partialText, reason: 'length' },
            )
          }
          if (!sawUsableOutput) {
            const outputBudgetEnded = chunk.finishReason === 'length'
            const error = new Error(
              outputBudgetEnded
                ? 'The model exhausted its output budget before producing a visible reply.'
                : 'The model returned an empty reply.',
            )
            error.code = outputBudgetEnded ? 'EMPTY_MODEL_RESPONSE_LENGTH' : 'EMPTY_MODEL_RESPONSE'
            error.partialText = partialText
            throw error
          }
          // done \u5e27\u53ef\u80fd\u5e26 memory ids / finishReason,\u8ba9\u4e0a\u5c42\u5728 return \u524d\u5b8c\u6210\u6536\u5c3e meta.
          if (chunk.injectedMemoryIds || chunk.finishReason) {
            yield {
              type: 'complete',
              injectedMemoryIds: chunk.injectedMemoryIds || [],
              // \u2605 'length' \u8bf4\u660e\u662f\u88ab token \u4e0a\u9650\u780d\u65ad\u7684,\u4e0d\u662f\u6a21\u578b\u4e0d\u60f3\u8bf4\u3002
              finishReason: chunk.finishReason || null,
            }
          }
          return
        }
        // \u2605 \u670d\u52a1\u7aef\u5728\u9996 token \u4e4b\u524d\u4f1a\u5148\u53d1 phase \u5e27\u3002
        // \u672c\u5730\u6a21\u578b\u52a0\u8f7d\u6743\u91cd\u8981\u51e0\u5341\u79d2,\u6ca1\u6709\u8fd9\u4e2a\u5e27\u7684\u8bdd\u754c\u9762\u662f\u5b8c\u5168\u7a7a\u767d\u7684,
        // \u7528\u6237\u552f\u4e00\u7684\u5224\u65ad\u5c31\u662f\u300c\u5927\u6982\u5361\u6b7b\u4e86\u300d\u3002
        if (chunk.phase) {
          yield { type: 'phase', phase: chunk.phase, firstTokenLatency: chunk.firstTokenLatency ?? null }
          continue
        }
        if (chunk.toolCalls) {
          sawUsableOutput = true
          yield { type: 'tool_calls', toolCalls: chunk.toolCalls, finishReason: chunk.finishReason }
        } else if (chunk.toolCallReady) {
          yield { type: 'tool_call_ready', toolCall: chunk.toolCallReady, index: chunk.toolCallIndex }
        } else if (chunk.delta !== undefined) {
          partialText += chunk.delta
          if (chunk.delta.trim()) sawUsableOutput = true
          yield { type: 'text', delta: chunk.delta }
        } else if (chunk.reasoning !== undefined) {
          // \u63a8\u7406\u6a21\u578b\u7684\u601d\u8003\u8fc7\u7a0b,\u548c\u6b63\u6587\u5206\u5f00\u4f20,\u524d\u7aef\u6298\u53e0\u663e\u793a
          yield { type: 'reasoning', delta: chunk.reasoning }
        }
      }
    }
    // \u2605 \u8d70\u5230\u8fd9\u91cc\u8bf4\u660e reader \u7ed3\u675f\u4e86\u4f46\u4ece\u6ca1\u89c1\u8fc7 done \u5e27 = \u8fde\u63a5\u88ab\u622a\u65ad\u3002
    // \u7edd\u4e0d\u80fd\u9759\u9ed8 return \u2014\u2014 \u90a3\u6837\u4e0a\u5c42\u4f1a\u4ee5\u4e3a\u6a21\u578b\u597d\u597d\u5730\u8bf4\u5b8c\u4e86\u3002
    if (!sawDone) {
      throw new StreamTruncatedError(
        partialText
          ? '\u6a21\u578b\u56de\u590d\u4e2d\u65ad\u4e86\uff08\u8fde\u63a5\u63d0\u524d\u5173\u95ed\uff09\u3002\u5df2\u4fdd\u7559\u4e0a\u9762\u7684\u5185\u5bb9\uff0c\u53ef\u4ee5\u70b9\u300c\u7ee7\u7eed\u751f\u6210\u300d\u63a5\u7740\u5199\u3002'
          : '\u6a21\u578b\u6ca1\u6709\u8fd4\u56de\u4efb\u4f55\u5185\u5bb9\uff0c\u8fde\u63a5\u5c31\u4e2d\u65ad\u4e86\u3002\u8bf7\u68c0\u67e5\u672c\u5730\u6a21\u578b\u670d\u52a1\u662f\u5426\u4ecd\u5728\u8fd0\u884c\u3002',
        { partialText, reason: 'closed' },
      )
    }
  } finally {
    // \u89e3\u6790\u9519\u8bef\u3001\u7a7a\u56de\u590d\u6216\u7528\u6237\u53d6\u6d88\u65f6\u4e3b\u52a8 cancel reader\uff0c\u628a\u65ad\u8fde\u4f20\u5230\u670d\u52a1\u7aef\uff0c
    // \u670d\u52a1\u7aef\u518d abort \u4e0a\u6e38\u672c\u5730\u63a8\u7406\uff0c\u907f\u514d UI \u5df2\u7ed3\u675f\u4f46 GPU \u4ecd\u6301\u7eed\u8fd0\u884c\u3002
    if (!sawDone && !readerEnded) {
      try { await reader.cancel() } catch { /* best effort */ }
    }
    reader.releaseLock()
  }
}

