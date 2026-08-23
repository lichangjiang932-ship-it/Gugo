import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

import { isLocalEndpoint } from '../utils/endpointProfile.js'

const nativeFetch = globalThis.fetch

let proxyAgent = null
let proxySignature = ''

function envValue(env, ...names) {
  for (const name of names) {
    const value = String(env?.[name] || '').trim()
    if (value) return value
  }
  return ''
}

function currentProxySignature(env = process.env) {
  return [
    envValue(env, 'HTTP_PROXY', 'http_proxy'),
    envValue(env, 'HTTPS_PROXY', 'https_proxy'),
    envValue(env, 'NO_PROXY', 'no_proxy'),
  ].join('\u0000')
}

export function shouldUseEnvProxy(input, env = process.env) {
  const proxyUrl = envValue(env, 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy')
  if (!proxyUrl) return false
  return !isLocalEndpoint(String(input || ''))
}

function getProxyAgent(env = process.env) {
  const signature = currentProxySignature(env)
  if (proxyAgent && signature === proxySignature) return proxyAgent

  if (proxyAgent) {
    void proxyAgent.close().catch(() => {})
  }
  const httpProxy = envValue(env, 'HTTP_PROXY', 'http_proxy')
  const httpsProxy = envValue(env, 'HTTPS_PROXY', 'https_proxy') || httpProxy
  const noProxy = envValue(env, 'NO_PROXY', 'no_proxy')
  proxyAgent = new EnvHttpProxyAgent({
    httpProxy: httpProxy || undefined,
    httpsProxy: httpsProxy || undefined,
    noProxy,
  })
  proxySignature = signature
  return proxyAgent
}

/**
 * Server-side fetch that respects HTTP(S)_PROXY for public endpoints.
 * Local/private model servers always stay direct, and test/runtime fetch
 * overrides keep taking precedence over the native implementation.
 */
export function fetchWithEnvProxy(input, init = {}, env = process.env) {
  if (globalThis.fetch !== nativeFetch) {
    return globalThis.fetch(input, init)
  }
  // A caller-provided dispatcher carries a connection-level DNS pin from the
  // outbound guard. It must win over the environment proxy dispatcher or the
  // validated address would be resolved again at connect time.
  if (init?.dispatcher) {
    return undiciFetch(input, init)
  }
  if (!shouldUseEnvProxy(input, env)) {
    return nativeFetch(input, init)
  }
  return undiciFetch(input, {
    ...init,
    dispatcher: getProxyAgent(env),
  })
}
