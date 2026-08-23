/**
 * Agent REST 客户端
 */
import { getAuthToken } from './accountClient.js'

export function authHeaders() {
  const token = getAuthToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function jsonOk(resp) {
  const text = await resp.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!resp.ok || data?.ok === false) {
    const structured = data?.error && typeof data.error === 'object'
      ? data.error
      : null
    const err = new Error(
      structured?.message
      || (typeof data?.error === 'string' ? data.error : '')
      || `HTTP ${resp.status}`,
    )
    err.status = resp.status
    for (const field of [
      'code',
      'action',
      'providerId',
      'modelName',
      'configRevision',
      'retryable',
    ]) {
      const value = structured && Object.hasOwn(structured, field)
        ? structured[field]
        : data?.[field]
      if (value !== undefined) err[field] = value
    }
    if (structured) err.details = structured.details ?? structured
    else if (data?.details !== undefined) err.details = data.details
    throw err
  }
  return data
}

export async function listAgentsApi() {
  const resp = await fetch('/api/agents', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getDefaultAgentApi() {
  const resp = await fetch('/api/agents/default', { headers: authHeaders() })
  return jsonOk(resp)
}

export async function getAgentApi(id) {
  const resp = await fetch(`/api/agents/${encodeURIComponent(id)}`, { headers: authHeaders() })
  return jsonOk(resp)
}

export async function listAgentTemplatesApi({ lang = 'zh' } = {}) {
  const qs = lang ? `?lang=${encodeURIComponent(lang)}` : ''
  const resp = await fetch(`/api/agent-templates${qs}`)
  return jsonOk(resp)
}

export async function getAgentTemplateApi(id, { lang = 'zh' } = {}) {
  const qs = lang ? `?lang=${encodeURIComponent(lang)}` : ''
  const resp = await fetch(`/api/agent-templates/${encodeURIComponent(id)}${qs}`)
  return jsonOk(resp)
}

export async function createAgentApi(payload) {
  const resp = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  })
  return jsonOk(resp)
}

export async function updateAgentApi(id, patch) {
  const resp = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  })
  return jsonOk(resp)
}

export async function deleteAgentApi(id) {
  const resp = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return jsonOk(resp)
}

export function exportAgentUrl(id) {
  return `/api/agents/${encodeURIComponent(id)}/export`
}

export async function importAgentApi(source, { overrideName } = {}) {
  const resp = await fetch('/api/agents/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ source, overrideName }),
  })
  return jsonOk(resp)
}

// v0.9: 角色卡 zip
export function exportAgentZipUrl(id, { memories = true } = {}) {
  return `/api/agents/${encodeURIComponent(id)}/export.zip${memories ? '' : '?memories=0'}`
}

export async function importAgentZipApi(file, { overrideName } = {}) {
  const qs = overrideName ? `?overrideName=${encodeURIComponent(overrideName)}` : ''
  const resp = await fetch(`/api/agents/import.zip${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip', ...authHeaders() },
    body: file,
  })
  return jsonOk(resp)
}
