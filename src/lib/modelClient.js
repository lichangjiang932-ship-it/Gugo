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
