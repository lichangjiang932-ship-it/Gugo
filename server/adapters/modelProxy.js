import {
  callBackgroundModel,
  callBackgroundModelWithTools,
  callStreamingModelWithTools,
  createBoundBackgroundModelCaller,
} from './modelInvocationRuntime.js'
import { createModelProxyHttpAdapter } from './modelProxyHttp.js'

export {
  callBackgroundModel,
  callBackgroundModelWithTools,
  callStreamingModelWithTools,
  createBoundBackgroundModelCaller,
}
export {
  extractUsage,
  parseModelProviderResponse,
  parseOpenAICompatibleResponse,
  stripEmbeddedReasoning,
} from './modelProviderResponse.js'
export { getUsageStats, recordUsage, resetUsageStats } from './modelUsage.js'
export {
  createModelConfigMissingError,
  MODEL_CONFIG_MISSING_CODE,
  MODEL_CONFIG_MISSING_MESSAGE,
} from './modelProxyErrors.js'
export { formatProxyError, isContextLengthError } from './modelProxyErrors.js'
export {
  fetchModelOutbound,
  isLocalModelEndpoint,
  modelTimeoutError,
  profileForConfig,
} from './modelEndpoint.js'
export {
  buildModelProviderRequest,
  buildOpenAICompatibleRequest,
  normalizeOpenAICompatibleUrl,
  supportsStreamUsage,
} from './modelRequestBuilder.js'
export {
  getModelProviders,
  loadModelConfig,
  resolveModelConfigForModel,
  resolveModelFailoverConfigs,
} from './modelProviderConfig.js'
export {
  isProviderFailoverError,
  runWithProviderFailover,
  streamWithProviderFailover,
} from './modelFailover.js'
export {
  shouldScheduleStreamAutoMemory,
  streamOpenAICompatible,
} from './modelProxyResponseCoordinator.js'
export {
  getModelContextWindow,
  getModelStatus,
  getSystemDiagnostics,
  getToolMaxRounds,
  getVisibleModels,
  hasVisionContent,
  supportsToolsModel,
  supportsVisionModel,
} from './modelRuntimeCatalog.js'
export { getRuntimeEnv } from '../utils/runtimeEnv.js'

const modelProxyHttpAdapter = createModelProxyHttpAdapter({
  createBackgroundModelCaller: createBoundBackgroundModelCaller,
})

export const handleModelProxyRequest = modelProxyHttpAdapter.handleModelProxyRequest
export const handleModelStatusRequest = modelProxyHttpAdapter.handleModelStatusRequest
export const handleSystemDiagnosticsRequest = modelProxyHttpAdapter.handleSystemDiagnosticsRequest
export const modelProxyPlugin = modelProxyHttpAdapter.modelProxyPlugin
