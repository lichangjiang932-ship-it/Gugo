import { getAuthToken } from './accountClient.js'

async function parse(response) {
  let data
  try { data = await response.json() } catch { data = null }
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败：HTTP ${response.status}`)
  }
  return data
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${getAuthToken()}`,
    ...extra,
  }
}

/* memories */

export async function listMemories({ fetchImpl = fetch } = {}) {
  return parse(await fetchImpl('/api/reasonix/memories', { headers: authHeaders() }))
}

export async function createMemory(payload, { fetchImpl = fetch } = {}) {
  return parse(await fetchImpl('/api/reasonix/memories', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }))
}

export async function updateMemory(id, patch, { fetchImpl = fetch } = {}) {
  return parse(await fetchImpl(`/api/reasonix/memories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  }))
}

export async function deleteMemory(id, { fetchImpl = fetch } = {}) {
  return parse(await fetchImpl(`/api/reasonix/memories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  }))
}

/* todos */

export async function listTodos(status, { fetchImpl = fetch } = {}) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  return parse(await fetchImpl(`/api/reasonix/todos${qs}`, { headers: authHeaders() }))
}

export async function createTodo(payload, { fetchImpl = fetch } = {}) {
  return parse(await fetchImpl('/api/reasonix/todos', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }))
}

export async function updateTodo(id, patch, { fetchImpl = fetch } = {}) {
  return parse(await fetchImpl(`/api/reasonix/todos/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(patch),
  }))
}

export async function deleteTodo(id, { fetchImpl = fetch } = {}) {
  return parse(await fetchImpl(`/api/reasonix/todos/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  }))
}

/* effort */

export async function getEffort({ fetchImpl = fetch } = {}) {
  return parse(await fetchImpl('/api/reasonix/effort', { headers: authHeaders() }))
}

export async function setEffort(effort, { fetchImpl = fetch } = {}) {
  return parse(await fetchImpl('/api/reasonix/effort', {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ effort }),
  }))
}

/* meters */

export async function listMeters(limit = 20, { fetchImpl = fetch } = {}) {
  return parse(await fetchImpl(`/api/reasonix/meters?limit=${limit}`, { headers: authHeaders() }))
}

export async function getMeter(sessionId, { fetchImpl = fetch } = {}) {
  return parse(await fetchImpl(`/api/reasonix/meters/${encodeURIComponent(sessionId)}`, { headers: authHeaders() }))
}
