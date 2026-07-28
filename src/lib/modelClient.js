import { getAuthToken } from './accountClient.js'
import { z } from 'zod'

// ★ #18: SSE chunk schema — 后端可能返回畸形 JSON,先验证再消费
// 后端发的所有 chunk 形态:
//   { ok: false, error }                       — 错误
//   { done: true, billing?, injectedMemoryIds? } — 流结束
//   { toolCalls: [...], finishReason? }        — 工具调用帧
//   { delta: string }                          — 文本增量
const SSE_CHUNK_SCHEMA = z.union([
  z.object({ ok: z.literal(false), error: z.string().optional() }),
  z.object({
    done: z.literal(true),
    billing: z.any().optional(),
    injectedMemoryIds: z.array(z.string()).optional(),
  }),
  z.object({ toolCalls: z.array(z.any()).min(1), finishReason: z.string().optional() }),
  z.object({ delta: z.string() }),
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
    throw new Error(data?.error?.message || data?.error || `HTTP ${response.status}`)
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
  return data
}

/**
 * ★ #8: 异步生成会话标题 — 用首句喂模型 8 字内总结。
 * 失败/空返回时返回 null,让调用方 fallback 到截断。
 * 不计入工具调用 / 计费(后端可按需 free pass,本期前端只做调用)。
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
        purpose: 'title', // 给后端一个标记,可按需做计费豁免
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
export async function* callModelThroughProxyStream({ messages, modelName, agentId, fetchImpl = fetch, signal, tools, toolChoice }) {
  const body = { messages, modelName, agentId, stream: true }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools
    if (toolChoice) body.tool_choice = toolChoice
  }
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
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel()
        throw new Error('已停止生成')
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
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
        if (chunk.ok === false) throw new Error(chunk.error || '流式响应错误')
        if (chunk.done) {
          // done 帧可能带 billing / memory ids,让上层在 return 前完成收尾 meta.
          if (chunk.billing || chunk.injectedMemoryIds) {
            yield {
              type: 'billing',
              billing: chunk.billing,
              injectedMemoryIds: chunk.injectedMemoryIds || [],
            }
          }
          return
        }
        if (chunk.toolCalls) {
          yield { type: 'tool_calls', toolCalls: chunk.toolCalls, finishReason: chunk.finishReason }
        } else if (chunk.delta !== undefined) {
          yield { type: 'text', delta: chunk.delta }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
