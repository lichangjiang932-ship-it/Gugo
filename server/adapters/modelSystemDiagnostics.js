import { getMailDiagnostics } from './authAccount.js'
import { checkModelsEndpoint } from './modelEndpoint.js'
import { getUsageStats } from './modelUsage.js'
import { fetchWithEnvProxy } from './proxyFetch.js'
import { getPromptCompilerStats } from '../services/promptCompiler.js'

const UNAVAILABLE_RUNTIME_HOST_DIAGNOSTICS = Object.freeze({
  turnHost: Object.freeze({
    ready: false,
    persistenceConfigured: false,
    compactionArchiveConfigured: false,
  }),
  codexHost: Object.freeze({
    enabled: false,
    configured: false,
    discovered: false,
    signatureValid: false,
    version: null,
    ready: false,
    failureStage: null,
    reasonCode: 'CODEX_APP_SERVER_NOT_STARTED',
  }),
})

export function readUnavailableRuntimeHostDiagnostics() {
  return UNAVAILABLE_RUNTIME_HOST_DIAGNOSTICS
}

export function createModelSystemDiagnostics({
  loadModelConfig,
  getModelStatus,
  supportsStreamUsage,
} = {}) {
  if (![loadModelConfig, getModelStatus, supportsStreamUsage].every((value) => typeof value === 'function')) {
    throw new TypeError('model diagnostics dependencies must be functions')
  }

  return async function getSystemDiagnostics({
    env = process.env,
    fetchImpl = fetchWithEnvProxy,
    checkEndpoint = false,
    userId = null,
    readRuntimeDiagnostics = readUnavailableRuntimeHostDiagnostics,
  } = {}) {
    if (typeof readRuntimeDiagnostics !== 'function') {
      throw new TypeError('readRuntimeDiagnostics must be a function')
    }
    const config = loadModelConfig(env)
    const modelStatus = getModelStatus(env)
    const endpoint = checkEndpoint
      ? await checkModelsEndpoint({ config, fetchImpl })
      : { checked: false, ok: null, reason: '未执行端点探测' }

    return {
      ok: true,
      generatedAt: Date.now(),
      model: { ...modelStatus, apiKeyConfigured: !!config.apiKey },
      endpoint,
      mail: getMailDiagnostics(env),
      runtime: readRuntimeDiagnostics(),
      cache: {
        upstream: getUsageStats({ ownerId: userId }),
        promptBlocks: getPromptCompilerStats(),
        streamUsageEnabled: supportsStreamUsage(config, env),
      },
    }
  }
}
