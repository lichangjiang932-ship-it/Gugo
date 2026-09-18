import { readJson } from '../utils.js'
import { authenticateRequest } from '../middleware.js'
import {
  deleteModelProvider,
  getModelProvider,
  listModelProviders,
  normalizeModelProviderBaseUrl,
  normalizeModelProviderHeaderRemovalKeys,
  normalizeModelProviderHeaders,
  recordModelProviderReadiness,
  removeModelProviderHeaders,
  upsertModelProvider,
} from '../services/modelProviderStore.js'
import { getRuntimeEnv, getSystemDiagnostics } from '../adapters/modelProxy.js'
import { discoverOllamaEndpoint, looksLikeOllama } from '../adapters/ollamaNative.js'
import { resolveEndpointProfile } from '../utils/endpointProfile.js'
import {
  buildProviderProfileOverrides,
  buildProviderTestEnv,
  redactEndpointDiagnostics,
  runProviderDiagnosticSteps,
  validateProviderToolProbe,
} from '../services/modelProviderDiagnosticService.js'

// Compatibility re-exports: existing tests and callers import the probe
// helpers from this route, while the single implementation lives in the shared
// diagnostic service also used by the headless CLI preflight.
export { buildProviderProfileOverrides, validateProviderToolProbe }

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

async function discoverModelProvider(req, res, userId) {
  const body = await readJson(req)
  const existing = body?.id ? getModelProvider({ userId, id: body.id, includeSecrets: true }) : null
  const hasHeaders = Object.hasOwn(body || {}, 'headers')
  const hasHeaderUpdates = Object.hasOwn(body || {}, 'headerUpdates')
  if (hasHeaders && hasHeaderUpdates) {
    throw Object.assign(new Error('不能同时提交 headers 和 headerUpdates'), {
      code: 'MODEL_PROVIDER_HEADERS_CONFLICT', statusCode: 400, field: 'headers',
    })
  }
  const submittedHeaders = hasHeaders
    ? normalizeModelProviderHeaders(body.headers, { field: 'headers' })
    : hasHeaderUpdates
      ? normalizeModelProviderHeaders(body.headerUpdates, { field: 'headerUpdates' })
      : {}
  const removeHeaderKeys = Object.hasOwn(body || {}, 'removeHeaderKeys')
    ? normalizeModelProviderHeaderRemovalKeys(body.removeHeaderKeys)
    : []
  const headers = body?.clearHeaders === true
    ? {}
    : { ...removeModelProviderHeaders(existing?.headers || {}, removeHeaderKeys), ...submittedHeaders }
  const baseUrl = normalizeModelProviderBaseUrl(body?.baseUrl)
  const apiKey = body?.clearApiKey === true
    ? ''
    : (String(body?.apiKey || '').trim() || existing?.apiKey || '')
  if (looksLikeOllama(baseUrl)) {
    const native = await discoverOllamaEndpoint({
      baseUrl, modelName: String(body?.modelName || '').trim(), headers, apiKey,
    })
    if (native.ok) {
      return sendJson(res, 200, {
        ok: true, kind: 'ollama', endpoint: { checked: true, ok: true, url: baseUrl },
        models: native.models.map((model) => model.name), modelDetails: native.models,
        modelProfiles: native.modelProfiles || {}, detected: native.profile || null,
      })
    }
  }
  const env = {
    MODEL_PROVIDERS: 'probe',
    MODEL_PROVIDER_PROBE_BASE_URL: baseUrl,
    MODEL_PROVIDER_PROBE_API_KEY: apiKey,
    MODEL_PROVIDER_PROBE_MODELS: 'probe-model',
    MODEL_PROVIDER_PROBE_HEADERS: JSON.stringify(headers),
    MODEL_NAME: 'probe-model',
  }
  const diagnostics = await getSystemDiagnostics({ env, checkEndpoint: true, userId })
  const profile = resolveEndpointProfile({ baseUrl, env: getRuntimeEnv() })
  const endpoint = redactEndpointDiagnostics(diagnostics.endpoint, [
    env.MODEL_PROVIDER_PROBE_API_KEY,
    ...Object.values(headers),
  ])
  return sendJson(res, diagnostics.endpoint?.ok ? 200 : 502, {
    ok: !!diagnostics.endpoint?.ok,
    kind: profile.kind,
    endpoint,
    models: diagnostics.endpoint?.remoteModels || [],
    modelProfiles: diagnostics.endpoint?.remoteModelProfiles || {},
  })
}

function validateProviderTestModel(provider, rawModelName) {
  const modelName = typeof rawModelName === 'string' ? rawModelName.trim() : ''
  if (rawModelName == null || (typeof rawModelName === 'string' && !modelName)) {
    throw Object.assign(new Error('请选择要测试的模型'), {
      code: 'MODEL_PROVIDER_MODEL_REQUIRED', statusCode: 400, field: 'modelName',
    })
  }
  if (typeof rawModelName !== 'string' || !provider.models.includes(modelName)) {
    throw Object.assign(new Error('测试模型必须属于当前 Provider 的模型列表'), {
      code: 'MODEL_PROVIDER_MODEL_INVALID', statusCode: 400, field: 'modelName',
    })
  }
  return modelName
}
async function testModelProvider(req, res, userId, id) {
  const body = await readJson(req)
  const provider = getModelProvider({ userId, id, includeSecrets: true })
  if (!provider) {
    return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '模型 Provider 不存在' } })
  }
  const modelName = validateProviderTestModel(provider, body?.modelName)
  const testEnv = buildProviderTestEnv(provider, modelName)
  const profile = resolveEndpointProfile({
    baseUrl: provider.baseUrl,
    modelName,
    env: testEnv,
    overrides: buildProviderProfileOverrides(provider),
  })
  const steps = await runProviderDiagnosticSteps({ provider, modelName, userId, testEnv, profile })
  const ok = steps.every((step) => step.ok || step.advisory)
  const completionStep = steps.find((step) => step.name === 'completion')
  const toolStep = steps.find((step) => step.name === 'tools')
  const chatReady = completionStep?.ok === true
  const agentReady = chatReady && toolStep?.ok === true
  const capabilities = {
    chat: chatReady,
    tools: toolStep?.ok === true,
    agent: agentReady,
    mode: agentReady ? 'agent' : chatReady ? 'chat_only' : 'unavailable',
  }
  const blockingStep = steps.find((step) => !step.ok && !step.advisory)
  const testedProvider = recordModelProviderReadiness({
    userId,
    id: provider.id,
    modelName,
    expectedConfigRevision: provider.configRevision,
    readiness: {
      ...capabilities,
      ...(blockingStep?.errorCode ? { errorCode: blockingStep.errorCode } : {}),
    },
  })
  if (!testedProvider) {
    return sendJson(res, 409, {
      error: {
        code: 'MODEL_PROVIDER_CONFIG_CHANGED',
        message: 'Provider 配置在测试期间已变更，本次测试结果未保存；请重新测试最新配置。',
      },
    })
  }
  return sendJson(res, ok ? 200 : 502, {
    ok,
    steps,
    modelName,
    capabilities,
    readiness: testedProvider?.modelReadiness?.[modelName] || null,
    provider: testedProvider,
    profile: {
      kind: profile.kind,
      isLocal: profile.isLocal,
      contextWindow: profile.contextWindow,
      supportsTools: profile.supportsTools,
      supportsStreaming: profile.supportsStreaming,
      supportsVision: profile.supportsVision,
      supportsPdf: profile.supportsPdf,
      supportsParallelTools: profile.supportsParallelTools,
      failoverEligible: profile.failoverEligible,
      keepAlive: profile.keepAlive,
      firstTokenTimeoutMs: profile.timeouts.firstTokenMs,
      idleTimeoutMs: profile.timeouts.idleMs,
    },
    endpoint: {
      checked: true,
      ok,
      latency: steps.reduce((total, step) => total + (step.latency || 0), 0),
      model: modelName,
    },
    reply: completionStep?.reply || '',
    ...(ok ? {} : {
      error: { code: 'PROVIDER_TEST_FAILED', message: blockingStep?.error || '诊断未通过' },
    }),
  })
}

export async function handleModelProviderRequest(req, res) {
  const userId = authenticateRequest(req)
  if (!userId) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '请先登录' } })
  const url = new URL(req.url, 'http://localhost')
  const base = '/api/model/providers'
  const suffix = url.pathname.slice(base.length).replace(/^\//, '')
  const [id, action] = suffix.split('/')
  try {
    if (req.method === 'POST' && id === 'discover' && !action) {
      return await discoverModelProvider(req, res, userId)
    }
    if (req.method === 'GET' && !id) {
      return sendJson(res, 200, { ok: true, providers: listModelProviders({ userId }) })
    }
    if (req.method === 'POST' && !id) {
      const provider = upsertModelProvider({ userId, provider: await readJson(req), env: getRuntimeEnv() })
      return sendJson(res, 200, { ok: true, provider })
    }
    if (req.method === 'DELETE' && id && !action) {
      const deleted = deleteModelProvider({ userId, id })
      return sendJson(res, deleted ? 200 : 404, deleted
        ? { ok: true }
        : { error: { code: 'NOT_FOUND', message: '模型 Provider 不存在' } })
    }
    if (req.method === 'POST' && id && action === 'test') {
      return await testModelProvider(req, res, userId, id)
    }
    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' } })
  } catch (error) {
    const errorCode = String(error?.code || '')
    const code = errorCode.startsWith('MODEL_PROVIDER_') ? errorCode : 'INVALID_PROVIDER'
    return sendJson(res, error?.statusCode || 400, {
      error: {
        code,
        message: error?.message || String(error),
        ...(error?.field ? { field: error.field } : {}),
        ...(error?.action ? { action: error.action } : {}),
        ...(error?.providerId ? { providerId: error.providerId } : {}),
        ...(error?.details ? { details: error.details } : {}),
      },
    })
  }
}
