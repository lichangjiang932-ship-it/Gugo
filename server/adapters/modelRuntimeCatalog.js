import { resolveEndpointProfile } from '../utils/endpointProfile.js'
import { buildVisibleModelCatalog } from '../utils/modelCatalog.js'
import { maskOutboundUrl } from '../utils/urlDisplay.js'
import {
  MODEL_CONFIG_MISSING_CODE,
  MODEL_CONFIG_MISSING_MESSAGE,
} from './modelProxyErrors.js'
import {
  getModelProviders,
  loadModelConfig,
  parseModelList,
  resolveModelConfigForModel,
} from './modelProviderConfig.js'

function profileForRuntimeConfig(config = {}, env = process.env) {
  return resolveEndpointProfile({
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    env,
    overrides: config.profileOverrides || {},
    modelProfiles: config.modelProfiles || null,
  })
}

export function getToolMaxRounds(env = process.env) {
  // 工具调用轮数上限。★ 默认 0 = 不限制。
  //
  // 循环本来就会在模型停止调工具时自然退出,想让它停随时点「停止生成」。
  // 以前默认 5,读一个中等项目光探索就吃满,模型被硬切在半路只留一句
  // 「让我继续」—— 用户消耗了上游资源却拿不到结论。Claude Code / Codex / openworker
  // 都不设这种硬顶。
  //
  // 仍然允许显式配一个正数(1..1000)来封顶,给受控/演示环境用;
  // 设 0 或不设 = 无限制。前端另有一个极高的死循环护栏。
  const raw = Number(env.TOOL_MAX_ROUNDS)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  if (raw > 1000) return 0
  return Math.floor(raw)
}

export function hasVisionContent(messages = []) {
  return messages.some((message) =>
    Array.isArray(message?.content) &&
    message.content.some((part) => part?.type === 'image_url' || part?.type === 'input_image' || part?.image_url)
  )
}

// ★ DEFAULT_MODEL_CONTEXT_WINDOW / parseContextWindowMap 已移入
// server/utils/endpointProfile.js —— 上下文窗口的解析(含按模型映射、
// 本地/云端默认值、下限)现在只有那一处实现,避免两边漂移。

export function getModelContextWindow({ modelName, modelProviderId = '', env = process.env } = {}) {
  const runtimeEnv = env && typeof env === 'object' ? env : process.env
  const selectedModel = String(modelName || runtimeEnv.MODEL_NAME || '').trim()
  const requestedProviderId = String(modelProviderId || '').trim()
  const config = resolveModelConfigForModel({
    modelName: selectedModel,
    providerId: requestedProviderId,
    env: runtimeEnv,
  })
  if (requestedProviderId && !config.configured) {
    throw Object.assign(
      new Error('所选模型 Provider 无法从当前运行时环境解析。'),
      {
        code: 'MODEL_PROVIDER_BINDING_MISSING',
        statusCode: 409,
        retryable: false,
        providerId: requestedProviderId,
        modelName: selectedModel || null,
      },
    )
  }
  // ★ 交给端点画像统一解析。
  //
  // 原来默认值是 1_000_000 —— 用户没配 MODEL_CONTEXT_WINDOWS 时,压缩阈值
  // 被算成 80 万 token,对着一个 8k 窗口的本地模型**主动压缩永远不会触发**,
  // 直接一头撞进上游的 400。而且原来还有 `>= 4096` 的硬下限,
  // 真有 2k/4k 窗口的小模型也配不下去。
  // 现在本地默认 8192、云端默认 128k,且允许配到 1024。
  return resolveEndpointProfile({
    baseUrl: config.baseUrl,
    modelName: selectedModel,
    env: runtimeEnv,
    overrides: config.profileOverrides || {},
  }).contextWindow
}

export function supportsVisionModel(modelName = '', env = process.env, baseUrl = '', overrides = {}) {
  return resolveEndpointProfile({ baseUrl, modelName, env, overrides }).supportsVision
}

/**
 * 这个模型能不能用 function calling。
 * 口径和 supportsVisionModel 对齐:白名单一旦设置就是精确名单,
 * 没设置则回落到端点画像的推断(见 endpointProfile.js 的 KIND_CAPABILITIES)。
 */
export function supportsToolsModel(modelName = '', env = process.env, baseUrl = '') {
  return resolveEndpointProfile({ baseUrl, modelName, env }).supportsTools
}

export function getModelStatus(env = process.env) {
  const config = loadModelConfig(env)
  if (!config.configured) {
    return {
      ok: true,
      configured: false,
      code: MODEL_CONFIG_MISSING_CODE,
      message: MODEL_CONFIG_MISSING_MESSAGE,
      toolMaxRounds: getToolMaxRounds(env),
    }
  }

  const status = {
    ok: true,
    configured: true,
    modelName: config.modelName,
    baseUrlMasked: maskOutboundUrl(config.baseUrl),
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    toolMaxRounds: getToolMaxRounds(env),
  }

  const models = getVisibleModels(env, config.modelName)
  if (models.length) {
    status.models = models
    const activeModel = models.find((model) => model.active) || models[0]
    status.contextWindow = activeModel.contextWindow
    status.contextWindowSource = activeModel.contextWindowSource
    status.contextWindowEstimated = activeModel.contextWindowEstimated
    if (activeModel.contextWindowSourceUrl) status.contextWindowSourceUrl = activeModel.contextWindowSourceUrl
    if (activeModel.contextWindowVerifiedAt) status.contextWindowVerifiedAt = activeModel.contextWindowVerifiedAt
    if (activeModel.maxOutputTokens) status.maxOutputTokens = activeModel.maxOutputTokens
  }
  return status
}

let diagnosticsRuntimePromise = null

async function loadDiagnosticsRuntime() {
  diagnosticsRuntimePromise ||= Promise.all([
    import('./modelSystemDiagnostics.js'),
    import('./modelRequestBuilder.js'),
  ]).then(([diagnostics, requestBuilder]) => diagnostics.createModelSystemDiagnostics({
    loadModelConfig,
    getModelStatus,
    supportsStreamUsage: requestBuilder.supportsStreamUsage,
  }))
  return diagnosticsRuntimePromise
}

export async function getSystemDiagnostics(options = {}) {
  const runDiagnostics = await loadDiagnosticsRuntime()
  return runDiagnostics(options)
}

export function getVisibleModels(env = process.env, defaultModel = '') {
  const providers = getModelProviders(env)
  const providerModelEntries = providers.flatMap((provider) => provider.models.map((name) => ({
    name,
    provider: provider.id,
    providerLabel: provider.label,
  })))
  const names = providerModelEntries.length
    ? providerModelEntries.map((entry) => entry.name)
    : parseModelList(env.MODEL_NAMES || defaultModel)
  return buildVisibleModelCatalog({
    names,
    defaultModel,
    providerModelEntries,
    resolveProfile: (name, providerId) => profileForRuntimeConfig(
      resolveModelConfigForModel({ modelName: name, providerId, env }),
      env,
    ),
  })
}

export function pickAllowedModel({ requestedModel, requestedProviderId = '', config, env }) {
  const models = getVisibleModels(env, config.modelName)
  const normalizedProviderId = String(requestedProviderId || '').trim()
  if (!requestedModel) return config.modelName
  const allowed = models.some((item) => (
    item.name === requestedModel
    && (!normalizedProviderId || item.provider === normalizedProviderId)
  ))
  if (!allowed) {
    const providerHint = normalizedProviderId ? `（Provider: ${normalizedProviderId}）` : ''
    throw new Error(`模型 ${requestedModel}${providerHint} 不在后端允许列表中`)
  }
  return requestedModel
}
