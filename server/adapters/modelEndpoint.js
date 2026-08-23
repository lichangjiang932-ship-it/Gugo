import { isLocalEndpoint, resolveEndpointProfile } from '../utils/endpointProfile.js'
import { parseRemoteModelCatalog } from '../utils/modelCatalog.js'
import { fetchSafeOutbound, maskOutboundUrl } from '../utils/outboundNetworkGuard.js'
import { fetchWithEnvProxy } from './proxyFetch.js'
import {
  endpointProbeErrorCode,
  MODEL_CONFIG_MISSING_CODE,
  MODEL_CONFIG_MISSING_MESSAGE,
  redactModelConfigSecrets,
} from './modelProxyErrors.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/** Whether a configured model endpoint is local to the user's environment. */
export function isLocalModelEndpoint(baseUrl = '') {
  return isLocalEndpoint(baseUrl)
}

/** Resolve capability and timeout policy for a provider configuration. */
export function profileForConfig(config = {}, env = process.env) {
  return resolveEndpointProfile({
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    env,
    overrides: config.profileOverrides || {},
    modelProfiles: config.modelProfiles || null,
  })
}

/**
 * Apply the model-provider outbound policy without hard-coding global fetch.
 * Production transport performs DNS validation and pinning. Explicit test
 * transports skip real DNS unless they also inject a lookup implementation.
 */
export function fetchModelOutbound(url, init = {}, {
  config = {},
  fetchImpl = fetchWithEnvProxy,
  lookup,
  resolveDns,
  onRequestStart,
} = {}) {
  const shouldResolveDns = resolveDns ?? (typeof lookup === 'function' || fetchImpl === fetchWithEnvProxy)
  const outboundFetch = typeof onRequestStart === 'function'
    ? (...args) => {
        onRequestStart()
        return fetchImpl(...args)
      }
    : fetchImpl
  return fetchSafeOutbound(url, init, {
    fetchImpl: outboundFetch,
    allowLocal: isLocalModelEndpoint(config.baseUrl),
    resolveDns: shouldResolveDns,
    ...(typeof lookup === 'function' ? { lookup } : {}),
  })
}

/** Create an internal timeout error that cannot trigger HTTP-status failover. */
export function modelTimeoutError(message, { phase = 'request', timeoutMs = 0 } = {}) {
  const error = new Error(message)
  error.code = 'MODEL_TIMEOUT'
  error.timeoutPhase = phase
  error.timeoutMs = timeoutMs
  return error
}

export function ensureApiVersionPath(trimmed) {
  try {
    const url = new URL(trimmed)
    if (!LOCAL_HOSTS.has(url.hostname)) return trimmed
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '' || path === '/') {
      url.pathname = '/v1'
      return url.toString().replace(/\/+$/, '')
    }
    return trimmed
  } catch {
    return trimmed
  }
}

function normalizeModelsUrl(rawUrl = '') {
  const trimmed = rawUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed.replace(/\/chat\/completions$/i, '/models')
  }
  if (/\/models$/i.test(trimmed)) return trimmed
  return `${ensureApiVersionPath(trimmed)}/models`
}

function safeErrorMessage(error) {
  if (error?.status === 401 || error?.status === 403) return 'API Key 无效或权限不足'
  if (error?.status === 404) return '端点不支持 /models 或地址不存在'
  if (error?.name === 'AbortError') return '端点探测超时'
  return error?.message || '端点探测失败'
}

/** Probe a configured provider without leaking its URL credentials or headers. */
export async function checkModelsEndpoint({ config, fetchImpl = fetchWithEnvProxy, env = process.env }) {
  if (!config.configured) {
    return {
      checked: false,
      ok: false,
      code: MODEL_CONFIG_MISSING_CODE,
      reason: MODEL_CONFIG_MISSING_MESSAGE,
    }
  }

  const profile = profileForConfig(config, env)
  const url = normalizeModelsUrl(config.baseUrl)
  const controller = new AbortController()
  const started = Date.now()
  const timeout = setTimeout(() => controller.abort(), profile.timeouts.probeMs)
  try {
    const headers = { ...(config.headers || {}) }
    if (config.apiKey && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${config.apiKey}`
    }
    const response = await fetchModelOutbound(
      url,
      { headers, signal: controller.signal },
      { config, fetchImpl },
    )
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || response.statusText)
      error.status = response.status
      throw error
    }
    const { remoteModels, remoteModelProfiles } = parseRemoteModelCatalog(data)
    return {
      checked: true,
      ok: true,
      url,
      latency: Date.now() - started,
      remoteModels,
      remoteModelProfiles,
    }
  } catch (error) {
    const status = Number(error?.status)
    return {
      checked: true,
      ok: false,
      url: maskOutboundUrl(url),
      latency: Date.now() - started,
      error: redactModelConfigSecrets(safeErrorMessage(error), config),
      errorCode: endpointProbeErrorCode(error),
      ...(Number.isFinite(status) && status >= 400 ? { status } : {}),
    }
  } finally {
    clearTimeout(timeout)
  }
}
