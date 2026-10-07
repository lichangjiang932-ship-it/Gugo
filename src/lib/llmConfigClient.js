import { getAuthToken } from './accountClient.js'

async function request(path, { method = 'GET', body } = {}) {
  const token = getAuthToken()
  const response = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`)
    error.code = payload?.error?.code || 'LLM_CONFIG_FAILED'
    throw error
  }
  return payload
}

export const listLlmProviders = () => request('/api/llm/providers')
export const listLlmCatalog = () => request('/api/llm/catalog')
export const saveLlmProvider = (provider) => request('/api/llm/providers', { method: 'POST', body: provider })
export const removeLlmProvider = (id) => request(`/api/llm/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const saveLlmCredential = (id, apiKey) => request(`/api/llm/providers/${encodeURIComponent(id)}/credential`, { method: 'PUT', body: { apiKey } })
export const probeLlmDraft = (draft) => request('/api/llm/probe', { method: 'POST', body: draft })
export const probeLlmModels = (id) => request(`/api/llm/providers/${encodeURIComponent(id)}/probe`, { method: 'POST' })
export const addLlmModel = (id, model) => request(`/api/llm/providers/${encodeURIComponent(id)}/models`, { method: 'POST', body: { model } })
export const removeLlmModel = (id, model) => request(`/api/llm/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(model)}`, { method: 'DELETE' })
export const importLegacyLlmProviders = () => request('/api/llm/import', { method: 'POST' })
export const openLlmConfigFile = (target) => request('/api/llm/open-config', { method: 'POST', body: { target } })
export const refreshLlmModelsDev = () => request('/api/llm/models-dev', { method: 'POST' })
export const setLlmDefaultModel = ({ provider, model }) => request('/api/llm/default-model', { method: 'PUT', body: { provider, model } })
