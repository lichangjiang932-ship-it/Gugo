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
