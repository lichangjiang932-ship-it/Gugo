import { getAuthToken } from './accountClient.js'
import { z } from 'zod'

// ★ #18: SSE chunk schema — 后端可能返回畸形 JSON,先验证再消费
// 后端发的所有 chunk 形态:
//   { ok: false, error }                       — 错误
//   { done: true, injectedMemoryIds?, finishReason? } — 流结束
//   { toolCalls: [...], finishReason? }        — 工具调用帧
//   { delta: string }                          — 文本增量
const SSE_CHUNK_SCHEMA = z.union([
  z.object({
    ok: z.literal(false),
    error: z.string().optional(),
    // 后端区分「我们判定超时」和「上游拒绝」,前端据此给不同的补救提示
    code: z.string().nullable().optional(),
    timeoutPhase: z.string().nullable().optional(),
    partial: z.boolean().optional(),
  }),
  z.object({
    done: z.literal(true),
    injectedMemoryIds: z.array(z.string()).optional(),
    // 'length' = 被 max_tokens 截断;'stop' = 模型自己说完了
    finishReason: z.string().nullable().optional(),
  }),
  z.object({ toolCalls: z.array(z.any()).min(1), finishReason: z.string().optional() }),
  z.object({ toolCallReady: z.any(), toolCallIndex: z.number().int().nonnegative().optional() }),
  z.object({ delta: z.string() }),
  z.object({ reasoning: z.string() }),
  // 连接/加载阶段帧:首 token 之前告诉前端「已连上,模型正在加载」
  z.object({ phase: z.string(), firstTokenLatency: z.number().nullable().optional() }).passthrough(),
  // 未来兼容:任意带 ok=true 的状态帧
  z.object({ ok: z.literal(true) }).passthrough(),
])

async function parseProxyResponse(response) {
  let data
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `本地模型代理请求失败：HTTP ${response.status}`)
  }

  return data
}

export async function testModelEndpoint({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/model/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  return parseProxyResponse(response)
}

function authHeaders() {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

export async function getModelStatus({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/model/status', { headers: authHeaders() })
  return parseProxyResponse(response)
}

export async function getSystemDiagnostics({ check = false, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(
    `/api/system/diagnostics${check ? '?check=1' : ''}`,
    { headers: authHeaders() },
  )
  return parseProxyResponse(response)
}

async function modelProviderRequest(path = '', init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/model/providers${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(authHeaders() || {}),
      ...(init.headers || {}),
    },
  })
  let data
  try { data = await response.json() } catch { data = null }
  if (!response.ok || data?.ok === false || data?.error) {
    const error = new Error(data?.error?.message || data?.error || `HTTP ${response.status}`)
    // ★ 带上响应体。诊断接口失败时会返回逐项检查结果(steps / profile)——
    // 那正是「连不上」时用户唯一需要看的东西,不能因为抛异常就丢掉。
    error.payload = data
    error.status = response.status
    throw error
  }
  return data
}

export async function listModelProviders({ fetchImpl = fetch } = {}) {
  return modelProviderRequest('', {}, fetchImpl)
}

export async function saveModelProvider(provider, { fetchImpl = fetch } = {}) {
  return modelProviderRequest('', { method: 'POST', body: JSON.stringify(provider) }, fetchImpl)
}

export async function deleteModelProvider(id, { fetchImpl = fetch } = {}) {
  return modelProviderRequest(`/${encodeURIComponent(id)}`, { method: 'DELETE' }, fetchImpl)
}

export async function testModelProvider(id, { fetchImpl = fetch } = {}) {
  return modelProviderRequest(`/${encodeURIComponent(id)}/test`, { method: 'POST' }, fetchImpl)
}

export async function discoverModelProvider({ id, baseUrl, apiKey = '', headers = {} }, { fetchImpl = fetch } = {}) {
  return modelProviderRequest('/discover', {
    method: 'POST',
    body: JSON.stringify({ id, baseUrl, apiKey, headers }),
  }, fetchImpl)
}

export async function callModelThroughProxy({ messages, modelName, agentId, fetchImpl = fetch }) {
  const response = await fetchImpl('/api/model/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ messages, modelName, agentId }),
  })
  const data = await parseProxyResponse(response)
  if (!data?.reply) throw new Error('模型返回为空。')
  return { reply: data.reply }
}

/**
 * ★ #8: 异步生成会话标题 — 用首句喂模型 8 字内总结。
 * 失败/空返回时返回 null,让调用方 fallback 到截断。
 * 不计入用户发起的工具调用统计（本期前端只负责调用）。
 */
export async function summarizeSessionTitle({ firstUserContent, modelName, fetchImpl = fetch, signal }) {
  const text = String(firstUserContent || '').trim()
  if (!text) return null
  // 内容已经很短就不用 AI 了
  if (text.length <= 12) return text
  try {
    const response = await fetchImpl('/api/model/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: '你是会话标题生成器。读完用户首句后,用 8 个汉字以内总结主题,只返回标题文本,不要引号、不要句号、不要解释。',
          },
          { role: 'user', content: text.slice(0, 600) },
        ],
        modelName,
      purpose: 'title', // 给后端一个标记，便于区分标题摘要与普通对话
      }),
      signal,
    })
    if (!response.ok) return null
    const data = await response.json()
    const reply = String(data?.reply || '').trim()
    if (!reply) return null
    // 清理常见噪声
    const cleaned = reply
      .replace(/^["『「【]+|["』」】]+$/g, '')
      .replace(/[。！？.!?]+$/u, '')
      .trim()
    if (!cleaned) return null
    // 限长 — 8 字 / 16 字符兜底
    return cleaned.length > 16 ? cleaned.slice(0, 16) : cleaned
  } catch {
    return null
  }
}

/* ── 流式输出（SSE）── */
/**
 * 注意:旧版 yield 字符串(text delta);新版 yield event 对象 { type, ... },
 * 让上层能区分文本增量和工具调用。
 *   { type: 'text', delta: string }
 *   { type: 'tool_calls', toolCalls: [{id,name,arguments}], finishReason }
 */
/**
 * 流被截断 —— 连接断了但从没收到 done 帧。
 *
 * ★ 必须和「正常结束」区分开。原来 `if (done) break` 让两者完全一样,
 * 于是本地模型跑一半崩了,前端表现成「模型正常回答完了,只是话说了一半」:
 * 没有错误、没有提示、没有重试入口,用户只能自己发现不对劲。
 */
export class StreamTruncatedError extends Error {
  constructor(message, { partialText = '', reason = 'truncated' } = {}) {
    super(message)
    this.name = 'StreamTruncatedError'
    this.code = 'STREAM_TRUNCATED'
    this.partialText = partialText
    this.reason = reason
  }
}

/** 客户端 idle 超时。服务端每 15s 发心跳,所以正常情况下永远不会触发。 */
const CLIENT_IDLE_TIMEOUT_MS = 120_000

/** 给 reader.read() 套一个超时,避免 socket 半开时永远挂着。 */
function readWithIdleTimeout(reader, timeoutMs) {
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new StreamTruncatedError('与模型的连接已中断（超时没有收到任何数据）。', { reason: 'idle' }))
    }, timeoutMs)
  })
  return Promise.race([reader.read(), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export async function* callModelThroughProxyStream({ messages, modelName, agentId, sessionId, fetchImpl = fetch, signal, tools, toolChoice, idleTimeoutMs = CLIENT_IDLE_TIMEOUT_MS, maxTokensBoost = 0 }) {
  const body = { messages, modelName, agentId, sessionId, stream: true }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    if (toolChoice) body.tool_choice = toolChoice
  }
  // 收尾调用要更大的输出预算 —— 推理模型的「思考」会把默认额度吃光
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
    throw new Error(data?.error || `模型请求失败：HTTP ${response.status}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('无法读取流式响应')

  const decoder = new TextDecoder()
  let buffer = ''
  // ★ 跟踪是否真的收到过 done 帧 —— 这是「正常结束」的唯一凭据。
  let sawDone = false
  // done 只能证明协议结束，不能证明模型真的回答了。正文或工具调用至少要有一个。
  let sawUsableOutput = false
  let readerEnded = false
  // 已经吐出去的正文,截断时随错误一起交给上层,用于「继续生成」。
  let partialText = ''
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel()
        // ★ 用标准的 AbortError 而不是中文 message。
        // 上层原来比对 err.message === '已停止生成',而真实的 AbortController
        // 抛的是 DOMException("The user aborted a request.") —— 两边对不上,
        // 于是用户按「停止」会走到失败分支:弹错误 toast、把「模型调用失败」
        // 塞进消息里、写一条 FAILED 历史。
        const abortError = new Error('已停止生成')
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
        // ': keepalive' 这类 SSE 注释帧按规范忽略 —— 它们只是用来保持连接活着
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
        // ★ #18: schema 校验 — 不符合任何已知形态的 chunk 跳过 (但保留 ok:false 错误抛出路径)
        const validated = SSE_CHUNK_SCHEMA.safeParse(chunk)
        if (!validated.success) {
          if (typeof console !== 'undefined') {
            console.warn('[modelClient] 跳过畸形 SSE chunk:', validated.error.issues?.[0]?.message)
          }
          continue
        }
        chunk = validated.data
        if (chunk.ok === false) {
          const error = new Error(chunk.error || '流式响应错误')
          error.code = chunk.code || null
          error.timeoutPhase = chunk.timeoutPhase || null
          error.partialText = partialText
          throw error
        }
        if (chunk.done) {
          sawDone = true
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
          // done 帧可能带 memory ids / finishReason,让上层在 return 前完成收尾 meta.
          if (chunk.injectedMemoryIds || chunk.finishReason) {
            yield {
              type: 'complete',
              injectedMemoryIds: chunk.injectedMemoryIds || [],
              // ★ 'length' 说明是被 token 上限砍断的,不是模型不想说。
              finishReason: chunk.finishReason || null,
            }
          }
          return
        }
        // ★ 服务端在首 token 之前会先发 phase 帧。
        // 本地模型加载权重要几十秒,没有这个帧的话界面是完全空白的,
        // 用户唯一的判断就是「大概卡死了」。
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
          // 推理模型的思考过程,和正文分开传,前端折叠显示
          yield { type: 'reasoning', delta: chunk.reasoning }
        }
      }
    }
    // ★ 走到这里说明 reader 结束了但从没见过 done 帧 = 连接被截断。
    // 绝不能静默 return —— 那样上层会以为模型好好地说完了。
    if (!sawDone) {
      throw new StreamTruncatedError(
        partialText
          ? '模型回复中断了（连接提前关闭）。已保留上面的内容，可以点「继续生成」接着写。'
          : '模型没有返回任何内容，连接就中断了。请检查本地模型服务是否仍在运行。',
        { partialText, reason: 'closed' },
      )
    }
  } finally {
    // 解析错误、空回复或用户取消时主动 cancel reader，把断连传到服务端，
    // 服务端再 abort 上游本地推理，避免 UI 已结束但 GPU 仍持续运行。
    if (!sawDone && !readerEnded) {
      try { await reader.cancel() } catch { /* best effort */ }
    }
    reader.releaseLock()
  }
}
