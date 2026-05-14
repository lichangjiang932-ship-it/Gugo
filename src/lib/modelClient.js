import { getAuthToken } from './accountClient.js'

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

export async function getModelStatus({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/model/status')
  return parseProxyResponse(response)
}

export async function getSystemDiagnostics({ check = false, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`/api/system/diagnostics${check ? '?check=1' : ''}`)
  return parseProxyResponse(response)
}

export async function callModelThroughProxy({ messages, modelName, fetchImpl = fetch }) {
  const response = await fetchImpl('/api/model/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ messages, modelName }),
  })
  const data = await parseProxyResponse(response)
  if (!data?.reply) throw new Error('模型返回为空。')
  return data
}

/* ── 流式输出（SSE）── */

export async function* callModelThroughProxyStream({ messages, modelName, fetchImpl = fetch, signal }) {
  const response = await fetchImpl('/api/model/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ messages, modelName, stream: true }),
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
        try {
          const chunk = JSON.parse(payload)
          if (chunk.ok === false) throw new Error(chunk.error || '流式响应错误')
          if (chunk.done) return
          if (chunk.delta !== undefined) yield chunk.delta
        } catch (err) {
          if (err.message === '流式响应错误') throw err
          // 忽略无法解析的行
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
