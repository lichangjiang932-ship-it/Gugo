import { getAuthToken } from './accountClient.js'

function configError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

async function responseError(response) {
  try {
    const data = await response.json()
    return data?.error?.message || data?.error || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

export async function openRuntimeConfigInBrowser({
  fetchImpl = fetch,
  windowRef = globalThis.window,
  urlApi = globalThis.URL,
  schedule = globalThis.setTimeout,
  authToken = getAuthToken(),
} = {}) {
  const previewWindow = windowRef?.open?.('about:blank', '_blank')
  if (!previewWindow) {
    throw configError('The browser blocked the configuration tab.', 'CONFIG_POPUP_BLOCKED')
  }
  previewWindow.opener = null

  try {
    const response = await fetchImpl('/api/system/runtime-config', {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      credentials: 'same-origin',
    })
    if (!response.ok) {
      throw configError(await responseError(response), 'CONFIG_OPEN_FAILED')
    }

    const blob = await response.blob()
    const objectUrl = urlApi.createObjectURL(blob)
    previewWindow.location.replace(objectUrl)
    schedule(() => urlApi.revokeObjectURL(objectUrl), 60_000)
    return { opened: true }
  } catch (error) {
    previewWindow.close()
    throw error
  }
}

function structuredErrorFromData(response, data, fallbackCode) {
  const details = data?.error
  const message = details && typeof details === 'object'
    ? details.message
    : details
  const code = details && typeof details === 'object' ? details.code : null
  const error = configError(message || `HTTP ${response.status}`, code || fallbackCode)
  if (details && typeof details === 'object') Object.assign(error, details)
  error.status = response.status
  return error
}

async function structuredResponseError(response, fallbackCode) {
  let data = null
  try { data = await response.json() } catch { /* use the HTTP fallback below */ }
  return structuredErrorFromData(response, data, fallbackCode)
}

async function parseStructuredJson(response, fallbackCode) {
  let data = null
  try { data = await response.json() } catch { /* handled below */ }
  if (!response.ok || data?.ok === false) {
    throw structuredErrorFromData(response, data, fallbackCode)
  }
  return data
}

export async function getOutboundNetworkPolicy({
  fetchImpl = fetch,
  authToken = getAuthToken(),
} = {}) {
  const response = await fetchImpl('/api/system/network-policy', {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    credentials: 'same-origin',
  })
  const data = await parseStructuredJson(response, 'OUTBOUND_NETWORK_POLICY_READ_FAILED')
  if (!data?.policy || typeof data.policy.pureLocal !== 'boolean') {
    throw configError('The server returned an invalid outbound network policy.', 'OUTBOUND_NETWORK_POLICY_INVALID')
  }
  return data.policy
}

export async function updateOutboundNetworkPolicy(pureLocal, {
  fetchImpl = fetch,
  authToken = getAuthToken(),
} = {}) {
  if (typeof pureLocal !== 'boolean') {
    throw configError('pureLocal must be a boolean', 'INVALID_OUTBOUND_NETWORK_POLICY')
  }
  const response = await fetchImpl('/api/system/network-policy', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    credentials: 'same-origin',
    body: JSON.stringify({ pureLocal }),
  })
  const data = await parseStructuredJson(response, 'OUTBOUND_NETWORK_POLICY_UPDATE_FAILED')
  if (!data?.policy || typeof data.policy.pureLocal !== 'boolean') {
    throw configError('The server returned an invalid outbound network policy.', 'OUTBOUND_NETWORK_POLICY_INVALID')
  }
  return data.policy
}

export const USER_DATA_CLEAR_CONFIRMATION = 'DELETE ALL MY GUGO DATA'

function responseFilename(response, fallback = 'gugo-local-data.zip') {
  const disposition = String(response?.headers?.get?.('content-disposition') || '')
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = disposition.match(/filename="([^"]+)"/i)?.[1]
  try {
    return decodeURIComponent(encoded || plain || fallback).replace(/[\\/:*?"<>|]/g, '_')
  } catch {
    return fallback
  }
}

export async function downloadAuthoritativeUserData({
  fetchImpl = fetch,
  documentRef = globalThis.document,
  urlApi = globalThis.URL,
  schedule = globalThis.setTimeout,
  authToken = getAuthToken(),
} = {}) {
  const response = await fetchImpl('/api/system/user-data/export', {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    credentials: 'same-origin',
  })
  if (!response.ok) throw await structuredResponseError(response, 'USER_DATA_EXPORT_FAILED')
  const blob = await response.blob()
  const objectUrl = urlApi.createObjectURL(blob)
  const anchor = documentRef.createElement('a')
  const filename = responseFilename(response)
  anchor.href = objectUrl
  anchor.download = filename
  anchor.hidden = true
  documentRef.body?.appendChild(anchor)
  anchor.click()
  anchor.remove()
  schedule(() => urlApi.revokeObjectURL(objectUrl), 60_000)
  return { downloaded: true, filename }
}

export async function clearAuthoritativeUserData({
  confirmation,
  previewToken,
  fetchImpl = fetch,
  authToken = getAuthToken(),
} = {}) {
  const response = await fetchImpl('/api/system/user-data', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    credentials: 'same-origin',
    body: JSON.stringify({ confirmation, previewToken }),
  })
  let data = null
  try { data = await response.json() } catch { /* handled below */ }
  if (!response.ok || data?.ok === false) {
    throw structuredErrorFromData(response, data, 'USER_DATA_CLEAR_FAILED')
  }
  return data
}

export async function previewAuthoritativeUserDataClear({
  fetchImpl = fetch,
  authToken = getAuthToken(),
} = {}) {
  const response = await fetchImpl('/api/system/user-data/preview', {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    credentials: 'same-origin',
  })
  let data = null
  try { data = await response.json() } catch { /* handled below */ }
  if (!response.ok || data?.ok === false || !data?.preview?.token) {
    throw structuredErrorFromData(response, data, 'USER_DATA_CLEAR_PREVIEW_FAILED')
  }
  return data.preview
}
