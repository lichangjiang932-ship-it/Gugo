import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { acquireCompactionArchivePort as acquireActiveCompactionArchivePort } from '../core/compactionArchivePort.js'
import { checkRateLimit } from '../db.js'
import { authenticateRequest } from '../middleware.js'
import { buildUserModelEnv, listModelProviders } from '../services/modelProviderStore.js'
import { readJson } from '../utils.js'
import { getRuntimeEnv } from '../utils/runtimeEnv.js'
import { profileForConfig } from './modelEndpoint.js'
import {
  loadModelConfig,
  resolveModelConfigForModel,
  resolveModelFailoverConfigs,
} from './modelProviderConfig.js'
import { createModelConfigMissingError, formatProxyError } from './modelProxyErrors.js'
import { prepareModelProxyRequest } from './modelProxyRequestPreparation.js'
import {
  handleNonStreamingModelProxyResponse,
  handleStreamingModelProxyResponse,
} from './modelProxyResponseCoordinator.js'
import {
  getModelStatus,
  getSystemDiagnostics,
  hasVisionContent,
  pickAllowedModel,
} from './modelRuntimeCatalog.js'
import { readUnavailableRuntimeHostDiagnostics } from './modelSystemDiagnostics.js'

const MESSAGE_SCHEMA = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.null(), z.array(z.any())]).optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
}).passthrough()
const MESSAGES_SCHEMA = z.array(MESSAGE_SCHEMA).min(1, 'messages 不能为空')
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function resolveRuntimeProviderId({ userId, requestedProviderId }) {
  const requested = String(requestedProviderId || '').trim()
  if (!requested) return ''
  const provider = listModelProviders({ userId }).find((candidate) => (
    candidate.id === requested || candidate.key === requested
  ))
  return provider?.key || requested
}

function authorizeModelProxyRequest(req, res, testMode) {
  const userId = authenticateRequest(req)
  if (!userId) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' })
    return null
  }
  if (!testMode) return userId
  const maxRequests = Math.max(1, Math.min(60, Number(process.env.MODEL_TEST_RATE_MAX) || 10))
  const rate = checkRateLimit({
    key: `model_test:${userId}`,
    windowMs: 60 * 1000,
    maxRequests,
  })
  res.setHeader('X-RateLimit-Limit', String(maxRequests))
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining))
  if (rate.allowed) return userId
  sendJson(res, 429, { ok: false, error: 'Too many model test requests' })
  return null
}

function validateModelMessages(res, messages, testMode) {
  if (testMode) return true
  const validated = MESSAGES_SCHEMA.safeParse(messages)
  if (validated.success) return true
  const issues = validated.error.issues.map((issue) => (
    `${issue.path.join('.')}: ${issue.message}`
  )).join('; ')
  sendJson(res, 400, { ok: false, error: `messages 格式无效: ${issues}` })
  return false
}

async function handleModelProxyRequestRuntime(req, res, {
  createBackgroundModelCaller, compactionArchivePort, acquireCompactionArchivePort = acquireActiveCompactionArchivePort,
} = {}) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '仅支持 POST 请求。' })
      return
    }

    let compactionArchiveLease = null
    let requestCompactionArchivePort = compactionArchivePort
    try {
      const testMode = req.url?.startsWith('/api/model/test')
      const requestUserId = authorizeModelProxyRequest(req, res, testMode)
      if (!requestUserId) return
      const body = await readJson(req)
      const idempotencyHeader = req.headers?.['idempotency-key']
      const hookRequestId = String(
        (Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader)
          || body.requestId
          || randomUUID(),
      ).trim()
      const runtimeEnv = buildUserModelEnv({ userId: requestUserId, env: getRuntimeEnv() })
      const config = loadModelConfig(runtimeEnv)
      if (!config.configured) {
        const error = createModelConfigMissingError(config)
        sendJson(res, error.statusCode, {
          ok: false,
          code: error.code,
          error: error.message,
        })
        return
      }

      const useStream = body.stream === true
      let messages = testMode
        ? [{ role: 'user', content: 'Reply with only: pong' }]
        : body.messages
      let autoMemorySourceMessages = []

      if (!validateModelMessages(res, messages, testMode)) return
      if (!requestCompactionArchivePort) {
        compactionArchiveLease = acquireCompactionArchivePort()
        requestCompactionArchivePort = compactionArchiveLease.port
      }
      let session = null
      const requestedProviderId = resolveRuntimeProviderId({
        userId: requestUserId,
        requestedProviderId: body.modelProviderId,
      })
      const selectedModel = pickAllowedModel({
        requestedModel: body.modelName,
        requestedProviderId,
        config,
        env: runtimeEnv,
      })
      const requestConfig = resolveModelConfigForModel({
        modelName: selectedModel,
        providerId: requestedProviderId,
        env: runtimeEnv,
      })
      const requestProfile = profileForConfig(requestConfig, runtimeEnv)
      const resolvedCandidates = resolveModelFailoverConfigs({
        modelName: selectedModel,
        providerId: requestedProviderId,
        env: runtimeEnv,
      })
      let injectedMemoryIds = []
      let injectedAgentId = null
      let compilerFingerprints = null
      let requestCandidates = []
      try {
        const preparation = await prepareModelProxyRequest({
          req,
          res,
          body,
          testMode,
          runtimeEnv,
          selectedModel,
          requestConfig,
          requestProfile,
          resolvedCandidates,
          compactionArchivePort: requestCompactionArchivePort,
          hookRequestId,
          messages,
          hasVisionContent,
        })
        messages = preparation.messages
        autoMemorySourceMessages = preparation.autoMemorySourceMessages
        session = preparation.session
        injectedMemoryIds = preparation.injectedMemoryIds
        injectedAgentId = preparation.injectedAgentId
        compilerFingerprints = preparation.compilerFingerprints
        requestCandidates = preparation.requestCandidates
      } catch (error) {
        if (error?.code === 'PROMPT_HOOK_REJECTED') {
          sendJson(res, 403, { ok: false, error: error.message })
          return
        }
        throw error
      }
      if (useStream && !testMode) {
        await handleStreamingModelProxyResponse({
          req,
          res,
          body,
          requestUserId,
          runtimeEnv,
          selectedModel,
          requestCandidates,
          messages,
          session,
          hookRequestId,
          injectedMemoryIds,
          injectedAgentId,
          autoMemorySourceMessages,
          createBackgroundModelCaller,
        })
        return
      }

      await handleNonStreamingModelProxyResponse({
        res,
        body,
        testMode,
        requestUserId,
        runtimeEnv,
        requestCandidates,
        messages,
        session,
        hookRequestId,
        injectedMemoryIds,
        injectedAgentId,
        autoMemorySourceMessages,
        compilerFingerprints,
        createBackgroundModelCaller,
      })
    } catch (error) {
      let status
      if (error?.statusCode) status = error.statusCode
      else if (/请先登录/.test(error?.message || '')) status = 401
      else status = 502
      sendJson(res, status, {
        ok: false,
        error: formatProxyError(error),
        ...(error?.code ? { code: error.code } : {}),
      })
    } finally {
      compactionArchiveLease?.release()
    }
  }

async function handleModelStatusRequestRuntime(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: '仅支持 GET 请求。' })
      return
    }
    const userId = authenticateRequest(req)
    if (!userId) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const status = getModelStatus(buildUserModelEnv({ userId, env: getRuntimeEnv() }))
    const persistedProvidersByKey = new Map(
      listModelProviders({ userId })
        .filter((provider) => provider.enabled)
        .map((provider) => [provider.key, provider]),
    )
    if (Array.isArray(status.models)) {
      status.models = status.models.map((model) => {
        const persisted = persistedProvidersByKey.get(String(model?.provider || '').trim())
        if (!persisted) return model
        return {
          ...model,
          provider: persisted.id,
          providerKey: persisted.key,
          configRevision: persisted.configRevision,
          readiness: persisted.modelReadiness?.[String(model?.name || '').trim()] || null,
        }
      })
    }
    sendJson(res, 200, status)
  }

async function handleSystemDiagnosticsRequestRuntime(req, res, {
    readRuntimeDiagnostics = readUnavailableRuntimeHostDiagnostics,
  } = {}) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: '仅支持 GET 请求。' })
      return
    }
    const userId = authenticateRequest(req)
    if (!userId) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }
    const url = new URL(req.url, 'http://localhost')
    const checkEndpoint = url.searchParams.get('check') === '1'
    const env = buildUserModelEnv({ userId, env: getRuntimeEnv() })
    sendJson(res, 200, await getSystemDiagnostics({
      env,
      checkEndpoint,
      userId,
      readRuntimeDiagnostics,
    }))
  }

function createModelProxyPlugin({
  handleModelProxyRequest,
  handleModelStatusRequest,
  handleSystemDiagnosticsRequest,
  readRuntimeDiagnostics,
}) {
  return {
    name: 'local-model-proxy',
    configureServer(server) {
      server.middlewares.use(
        '/api/system/diagnostics',
        (req, res) => handleSystemDiagnosticsRequest(req, res, { readRuntimeDiagnostics }),
      )
      server.middlewares.use('/api/model/status', handleModelStatusRequest)
      server.middlewares.use('/api/model/test', handleModelProxyRequest)
      server.middlewares.use('/api/model/chat', handleModelProxyRequest)
    },
  }
}

/** Bind facade-owned model execution without forming a reverse dependency. */
export function createModelProxyHttpAdapter({ createBackgroundModelCaller } = {}) {
  if (typeof createBackgroundModelCaller !== 'function') {
    throw new TypeError('createBackgroundModelCaller must be a function')
  }
  const handleModelProxyRequest = (req, res, options = {}) => (
    handleModelProxyRequestRuntime(req, res, { ...options, createBackgroundModelCaller })
  )
  const handleModelStatusRequest = handleModelStatusRequestRuntime
  const handleSystemDiagnosticsRequest = handleSystemDiagnosticsRequestRuntime
  const modelProxyPlugin = ({
    readRuntimeDiagnostics = readUnavailableRuntimeHostDiagnostics,
  } = {}) => createModelProxyPlugin({
    handleModelProxyRequest,
    handleModelStatusRequest,
    handleSystemDiagnosticsRequest,
    readRuntimeDiagnostics,
  })
  return Object.freeze({
    handleModelProxyRequest,
    handleModelStatusRequest,
    handleSystemDiagnosticsRequest,
    modelProxyPlugin,
  })
}
