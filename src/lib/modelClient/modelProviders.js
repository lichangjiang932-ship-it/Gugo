import { authHeaders, parseProxyResponse } from './modelHttp.js'

export async function testModelEndpoint({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/model/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeaders() || {}),
    },
    body: JSON.stringify({}),
  })
  return parseProxyResponse(response)
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
    // \u2605 \u5e26\u4e0a\u54cd\u5e94\u4f53\u3002\u8bca\u65ad\u63a5\u53e3\u5931\u8d25\u65f6\u4f1a\u8fd4\u56de\u9010\u9879\u68c0\u67e5\u7ed3\u679c(steps / profile)\u2014\u2014
    // \u90a3\u6b63\u662f\u300c\u8fde\u4e0d\u4e0a\u300d\u65f6\u7528\u6237\u552f\u4e00\u9700\u8981\u770b\u7684\u4e1c\u897f,\u4e0d\u80fd\u56e0\u4e3a\u629b\u5f02\u5e38\u5c31\u4e22\u6389\u3002
    error.payload = data
    error.status = response.status
    const code = data?.error?.code || data?.code
    if (code) error.code = String(code)
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

export async function testModelProvider(id, modelName, { fetchImpl = fetch } = {}) {
  return modelProviderRequest(`/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: JSON.stringify({ modelName: String(modelName || '').trim() }),
  }, fetchImpl)
}

export async function discoverModelProvider({
  id,
  baseUrl,
  apiKey = '',
  headers = {},
  clearApiKey = false,
  clearHeaders = false,
  removeHeaderKeys = [],
}, { fetchImpl = fetch } = {}) {
  return modelProviderRequest('/discover', {
    method: 'POST',
    body: JSON.stringify({
      id,
      baseUrl,
      apiKey,
      headers,
      clearApiKey,
      clearHeaders,
      removeHeaderKeys,
    }),
  }, fetchImpl)
}

