/**
 * Local, browser-free preflight for `gugo doctor --headless`.
 *
 * It reuses the same runtime config resolver, existing local identity, model readiness
 * service and provider diagnostic probe as the rest of the host. It must not
 * maintain a second model-selection path.
 *
 * By default it sends no model request: it only reads resolved config, the
 * local database and any already-persisted provider probe result. `probe: true`
 * explicitly refreshes that probe through the shared diagnostic service and
 * persists the readiness entry.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  buildUserModelEnv,
  getModelProvider,
  normalizeModelProviderBaseUrl,
  recordModelProviderReadiness,
  resolveUserModelProvider,
} from './modelProviderStore.js'
import {
  describeModelReadinessFailure,
  ModelReadinessError,
  resolveAgentModelRuntimeBinding,
} from './modelReadinessService.js'
import { getModelStatus } from '../adapters/modelRuntimeCatalog.js'
import { getModelProviders, parseModelList, resolveModelConfigForModel } from '../adapters/modelProviderConfig.js'
import { resolveEndpointProfile } from '../utils/endpointProfile.js'
import {
  buildProviderProfileOverrides,
  buildProviderTestEnv,
  runProviderDiagnosticSteps,
} from './modelProviderDiagnosticService.js'
import { bootstrapAuth, resolveAuthMode } from '../adapters/authAccount.js'
import { redactSensitiveText } from '../../shared/sensitiveText.js'
import { getDiagnosticRuntimeScope } from '../core/diagnosticRuntimeScope.js'
import { collectHeadlessDoctorDiagnostics, doctorDiagnosticsBlocking, inspectDoctorCache } from './headlessDoctorDiagnostics.js'

function readVersion() {
  try {
    return String(
      JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '',
    ) || null
  } catch {
    return null
  }
}

function storageOverrideKeys(env = {}) {
  return ['APP_DATA_DIR', 'APP_DB_PATH', 'ARTIFACT_DIR']
    .filter((key) => String(env?.[key] ?? '').trim())
}

function describeWorkspace(rawCwd, runtimeEnv) {
  const cwd = path.resolve(String(rawCwd || process.cwd()))
  let exists
  let isDirectory
  try {
    const stat = fs.statSync(cwd)
    exists = true
    isDirectory = stat.isDirectory()
  } catch {
    exists = false
    isDirectory = false
  }
  return {
    cwd,
    exists,
    isDirectory,
    // The headless host trusts the explicit --cwd as a read root for the turn.
    workspaceRoot: cwd,
    fsEnabled: true,
    shellEnabled: String(runtimeEnv?.WORKSPACE_SHELL_ENABLED ?? '0').trim() === '1',
    gitEnabled: String(runtimeEnv?.WORKSPACE_GIT_ENABLED ?? '0').trim() === '1',
    trustedShared: true,
  }
}

function probeStatus(readiness) {
  if (!readiness || typeof readiness !== 'object') return 'not_run'
  if (!(Number(readiness.checkedAt) > 0)) return 'not_run'
  if (readiness.agent === true && readiness.tools === true) return 'passed'
  return 'failed'
}

function compactSteps(steps) {
  if (!Array.isArray(steps)) return null
  return steps.map((step) => ({
    name: String(step?.name || ''),
    ok: step?.ok === true,
    advisory: step?.advisory === true,
    latencyMs: Number(step?.latency) || 0,
    code: String(step?.errorCode || '') || null,
    ...(step?.error ? { message: redactSensitiveText(String(step.error)).slice(0, 1_000) } : {}),
    ...(step?.hint ? { hint: redactSensitiveText(String(step.hint)).slice(0, 600) } : {}),
  }))
}

function declaredTools(provider, modelName, runtimeEnv) {
  if (!provider) return null
  try {
    const profile = resolveEndpointProfile({
      baseUrl: provider.baseUrl,
      modelName,
      env: runtimeEnv,
      overrides: buildProviderProfileOverrides(provider),
    })
    return profile.supportsTools === true
  } catch {
    return null
  }
}

function runtimeReport(runtimeCwd, runtimeEnv, env) {
  return {
    cwd: path.resolve(String(runtimeCwd)),
    dataDir: runtimeEnv.APP_DATA_DIR || null,
    dbPath: runtimeEnv.APP_DB_PATH || null,
    artifactDir: runtimeEnv.ARTIFACT_DIR || null,
    configPath: runtimeEnv.APP_CONFIG_PATH || null,
    storageOverrideKeys: storageOverrideKeys(env),
  }
}

async function resolveIdentity({ runtimeEnv, auth }) {
  const authenticate = auth || bootstrapAuth
  const session = await authenticate({ token: '', env: runtimeEnv })
  if (!session?.authenticated || !session?.user?.id) {
    return {
      ok: false,
      blocking: {
        code: 'AUTH_REQUIRED',
        action: 'login',
        message: '无法建立本地运行时身份；多用户部署需要先 gugo login / verify。',
      },
    }
  }
  return { ok: true, userId: String(session.user.id), authMode: resolveAuthMode(runtimeEnv) }
}

function assertLegacyEnvironmentTarget({ provider, providerId, modelName, runtimeEnv, userModelEnv, boundConfig }) {
  if (String(providerId || '').trim() || getModelProviders(runtimeEnv).length) return
  const requestedModel = String(modelName || '').trim()
  const legacyModels = [...parseModelList(runtimeEnv.MODEL_NAMES), String(runtimeEnv.MODEL_NAME || '').trim()]
  if (requestedModel && !legacyModels.includes(requestedModel)) return
  const declared = resolveModelConfigForModel({ modelName: requestedModel, env: runtimeEnv })
  if (!declared.configured) return
  const bound = boundConfig || resolveModelConfigForModel({
    modelName: requestedModel || provider?.defaultModel || '', providerId: provider?.id || '', env: userModelEnv,
  })
  // Saved providers intentionally take precedence in the shared runtime. The
  // doctor must expose a conflicting explicit legacy target, not silently
  // probe it with another endpoint's URL, credentials, or model. An explicit
  // --provider resolves the conflict without changing that global default.
  if (!bound.configured || declared.modelName !== bound.modelName
    || normalizeModelProviderBaseUrl(declared.baseUrl) !== normalizeModelProviderBaseUrl(bound.baseUrl)
    || declared.apiKey !== bound.apiKey || !isDeepStrictEqual(declared.headers || {}, bound.headers || {})) {
    throw new ModelReadinessError('MODEL_PROVIDER_BINDING_MISSING', {
      providerId: provider?.id, modelName: requestedModel || declared.modelName,
      details: { reason: 'legacy_environment_target_mismatch' },
    })
  }
}

function doctorReadinessFailure(error) {
  if (/^CREDENTIAL_VAULT_[A-Z_]+$/u.test(String(error?.code || ''))) return {
    code: error.code, action: 'check_credential_key',
    message: '只读诊断无法读取既有凭据密钥；未生成、迁移或替换任何密钥，请检查原运行时的数据路径与密钥备份。',
  }
  const failure = describeModelReadinessFailure(error).error || null
  if (error?.details?.reason !== 'legacy_environment_target_mismatch') return failure
  return { ...failure, action: 'choose_agent_provider',
    message: 'MODEL_* 环境配置与运行时实际选择的模型目标不一致，未发送探针。请用 --provider 明确选择已配置的 Provider，或将环境模型配置为命名 Provider 后重试。' }
}

function findProvider({ providerId, modelName, userId, runtimeEnv, userModelEnv, selectProvider }) {
  // Selection must not depend on a successful readiness check: the purpose of
  // --probe is precisely to verify an untested or previously failing target.
  const provider = selectProvider({ userId, providerId, modelName })
  assertLegacyEnvironmentTarget({ provider, providerId, modelName, runtimeEnv, userModelEnv })
  const requestedModel = String(modelName || '').trim()
  if (provider || String(providerId || '').trim() || !requestedModel) return provider

  // The legacy runtime accepts arbitrary model names on its default endpoint.
  // A diagnostic must not use that fallback for a mistyped saved/local model.
  // Leave actual environment binding to the shared resolver after confirming
  // that this model was explicitly declared in the environment configuration.
  const environmentProviders = getModelProviders(runtimeEnv)
  const declaredModels = environmentProviders.length
    ? environmentProviders.flatMap((item) => item.models)
    : [...parseModelList(runtimeEnv.MODEL_NAMES), String(runtimeEnv.MODEL_NAME || '').trim()]
  if (!declaredModels.includes(requestedModel)) {
    throw new ModelReadinessError('MODEL_PROVIDER_MODEL_INVALID', { modelName: requestedModel })
  }
  if (!resolveModelConfigForModel({ modelName: requestedModel, env: runtimeEnv }).configured) {
    throw new ModelReadinessError('MODEL_CONFIG_MISSING', { modelName: requestedModel })
  }
  return null
}

function environmentProbeTarget({ userId, providerId, modelName, runtimeEnv, resolveBinding }) {
  const binding = (resolveBinding || resolveAgentModelRuntimeBinding)({ userId, providerId, modelName, env: runtimeEnv })
  if (binding?.source !== 'environment') {
    throw Object.assign(new Error('The probe target could not be bound.'), { code: 'MODEL_PROVIDER_BINDING_MISSING' })
  }
  const env = binding.env || runtimeEnv
  const config = resolveModelConfigForModel({ modelName: binding.modelName, providerId: binding.providerId || '', env })
  if (!config.configured) throw Object.assign(new Error('The probe target is not configured.'), { code: 'MODEL_CONFIG_MISSING' })
  return { env, modelName: binding.modelName, provider: {
    ...config.profileOverrides, baseUrl: config.baseUrl, apiKey: config.apiKey || '',
    headers: config.headers || {}, models: [binding.modelName], modelProfiles: config.modelProfiles || {},
  } }
}

async function probeProvider({
  probe, provider, providerId, modelName, userId, getProvider, runSteps, recordReadiness, runtimeEnv, resolveBinding,
}) {
  if (!probe) return null
  try {
    const target = provider ? { provider: getProvider({ userId, id: provider.id, includeSecrets: true }),
      modelName: String(modelName || provider.defaultModel || provider.models?.[0] || '').trim(), env: runtimeEnv }
      : environmentProbeTarget({ userId, providerId, modelName, runtimeEnv, resolveBinding })
    const fullProvider = target.provider
    const resolvedModel = target.modelName
    const testEnv = buildProviderTestEnv(fullProvider, resolvedModel, target.env)
    assertLegacyEnvironmentTarget({ providerId, modelName, runtimeEnv,
      boundConfig: resolveModelConfigForModel({ modelName: resolvedModel, env: testEnv }) })
    const profile = resolveEndpointProfile({
      baseUrl: fullProvider.baseUrl,
      modelName: resolvedModel,
      env: testEnv,
      overrides: buildProviderProfileOverrides(fullProvider),
    })
    const steps = await runSteps({ provider: fullProvider, modelName: resolvedModel, userId, testEnv, profile })
    const completionOk = steps.find((step) => step.name === 'completion')?.ok === true
    const toolsOk = steps.find((step) => step.name === 'tools')?.ok === true
    const blockingStep = steps.find((step) => !step.ok && !step.advisory)
    if (provider) recordReadiness({
      userId,
      id: fullProvider.id,
      modelName: resolvedModel,
      expectedConfigRevision: fullProvider.configRevision,
      readiness: {
        chat: completionOk,
        tools: toolsOk,
        agent: completionOk && toolsOk,
        mode: completionOk && toolsOk ? 'agent' : completionOk ? 'chat_only' : 'unavailable',
        ...(blockingStep?.errorCode ? { errorCode: blockingStep.errorCode } : {}),
      },
    })
    return compactSteps(steps)
  } catch (error) {
    return [{ name: 'probe', ok: false, advisory: false, latencyMs: 0, code: String(error?.code || 'PROBE_FAILED') }]
  }
}

function buildModelReport({
  binding, readinessFailure, status, provider, modelName, runtimeEnv, probeSteps, probe,
}) {
  const configured = status?.configured === true
  const readiness = Array.isArray(probeSteps) ? measuredReadiness(probeSteps) : binding?.readiness || null
  const resolvedModel = binding?.modelName || modelName || status?.modelName
  return {
    configured,
    providerId: binding?.providerId || readinessFailure?.providerId || provider?.id || null,
    providerLabel: provider?.label || provider?.key || null,
    modelName: resolvedModel || null,
    configRevision: binding?.configRevision ?? readinessFailure?.configRevision ?? provider?.configRevision ?? null,
    source: binding?.source || null,
    readinessCode: binding ? null : (configured ? readinessFailure?.code || 'MODEL_READINESS_FAILED' : 'MODEL_CONFIG_MISSING'),
    readinessAction: binding ? null : (readinessFailure?.action || 'configure_model'),
    toolsDeclared: declaredTools(provider, resolvedModel, runtimeEnv),
    probe: {
      status: binding || probeSteps ? probeStatus(readiness) : 'not_run',
      requested: probe === true,
      source: probeSteps ? 'explicit_attempt' : Number(readiness?.checkedAt) > 0 ? 'cached_readiness' : 'not_run',
      mode: readiness?.mode || null,
      checkedAt: Number(readiness?.checkedAt) > 0 ? Number(readiness.checkedAt) : null,
    },
    contextWindow: status?.contextWindow ?? null,
    contextWindowSource: status?.contextWindowSource ?? null,
    toolMaxRounds: status?.toolMaxRounds ?? null,
  }
}

function measuredReadiness(steps) {
  const chat = steps.find((step) => step.name === 'completion')?.ok === true
  const tools = steps.find((step) => step.name === 'tools')?.ok === true
  return { chat, tools, agent: chat && tools, checkedAt: Date.now(),
    mode: chat && tools ? 'agent' : chat ? 'chat_only' : 'unavailable' }
}

function resolveBlocking({ configured, binding, readinessFailure, workspace, model }) {
  if (!configured) {
    return {
      code: 'MODEL_CONFIG_MISSING',
      action: 'configure_model',
      message: '没有可用模型配置；请配置 Provider 或设置 MODEL_* 环境变量。',
    }
  }
  if (!binding) {
    return {
      code: model.readinessCode,
      action: model.readinessAction,
      message: readinessFailure?.message || '模型未通过 Agent 就绪检查。',
    }
  }
  if (!workspace.exists || !workspace.isDirectory) {
    return {
      code: workspace.exists ? 'CLI_CWD_NOT_DIRECTORY' : 'CLI_CWD_NOT_FOUND',
      action: 'choose_workspace',
      message: `工作目录不可用：${workspace.cwd}`,
    }
  }
  return null
}

/**
 * @returns {Promise<object>} stable, secret-free preflight report.
 */
export async function runHeadlessDoctor({
  runtimeCwd = process.cwd(),
  workspaceCwd = process.cwd(),
  providerId = '',
  modelName = '',
  probe = false,
  integrity = false,
  env = process.env,
  preflight = null,
  auth = null,
  resolveBinding = null,
  getStatus = null,
  selectProvider = resolveUserModelProvider,
  getProvider = getModelProvider,
  runSteps = runProviderDiagnosticSteps,
  recordReadiness = recordModelProviderReadiness,
  diagnosticDependencies = {},
} = {}) {
  probe = probe === true
  integrity = integrity === true
  if (!preflight) {
    const { runDefaultReadOnlyDoctor } = await import('./headlessDoctorReadOnly.js')
    const options = { runtimeCwd, workspaceCwd, providerId, modelName, probe, integrity, env, auth,
      resolveBinding, getStatus, selectProvider, getProvider, runSteps, recordReadiness, diagnosticDependencies }
    return runDefaultReadOnlyDoctor(options, (overrides) => runHeadlessDoctor({ ...options, ...overrides }))
  }
  const report = {
    ok: false,
    mode: 'headless',
    version: readVersion(),
    runtime: null,
    workspace: null,
    model: null,
    probeSteps: null,
    blocking: null,
    diagnostics: null,
  }

  const runPreflight = preflight
  let runtimeEnv
  try {
    runtimeEnv = runPreflight({ cwd: runtimeCwd, env }).runtimeEnv
  } catch (error) {
    report.runtime = {
      cwd: path.resolve(String(runtimeCwd)),
      dataDir: null,
      dbPath: null,
      artifactDir: null,
      configPath: null,
      storageOverrideKeys: storageOverrideKeys(env),
      errorCode: String(error?.code || 'RUNTIME_CONFIG_PREFLIGHT_FAILED'),
    }
    report.blocking = {
      code: String(error?.code || 'RUNTIME_CONFIG_PREFLIGHT_FAILED'),
      action: 'check_runtime_config',
      message: '运行时配置预检失败，无法解析数据目录或数据库路径。',
    }
    return report
  }

  report.runtime = runtimeReport(runtimeCwd, runtimeEnv, env)
  report.workspace = describeWorkspace(workspaceCwd, runtimeEnv)

  let identity
  try {
    identity = await resolveIdentity({ runtimeEnv, auth })
  } catch (error) {
    identity = {
      ok: false,
      blocking: {
        code: String(error?.code || 'AUTH_BOOTSTRAP_FAILED'),
        action: 'login',
        message: '建立本地运行时身份失败，无法读取该用户的模型配置。',
      },
    }
  }
  if (!identity.ok) {
    report.blocking = identity.blocking
    report.diagnostics = collectHeadlessDoctorDiagnostics({ env: runtimeEnv, runtimeCwd,
      db: getDiagnosticRuntimeScope()?.database || diagnosticDependencies?.database || null, integrity }, diagnosticDependencies)
    return report
  }
  report.runtime.authMode = identity.authMode

  const { userId } = identity
  report.diagnostics = collectHeadlessDoctorDiagnostics({ env: runtimeEnv, runtimeCwd, userId,
    db: getDiagnosticRuntimeScope()?.database || diagnosticDependencies?.database || null, integrity }, diagnosticDependencies)
  report.blocking = doctorDiagnosticsBlocking(report.diagnostics)
  if (report.blocking) return report
  let userModelEnv
  try { userModelEnv = buildUserModelEnv({ userId, env: runtimeEnv }) } catch (error) {
    report.blocking = { code: String(error?.code || 'MODEL_CONFIGURATION_UNAVAILABLE'), action: 'check_runtime_config',
      message: '无法读取既有模型配置；Doctor 不会初始化或重写模型凭据。' }
    return report
  }
  const status = (getStatus || getModelStatus)(userModelEnv)
  let provider = null
  let selectionFailure = null
  try {
    provider = findProvider({ providerId, modelName, userId, runtimeEnv, userModelEnv, selectProvider })
  } catch (error) {
    selectionFailure = error
  }
  if (!selectionFailure) report.probeSteps = await probeProvider({
    probe, provider, providerId, modelName, userId, getProvider, runSteps, recordReadiness, runtimeEnv, resolveBinding,
  })

  let binding = null
  let readinessFailure = null
  try {
    if (selectionFailure) throw selectionFailure
    binding = (resolveBinding || resolveAgentModelRuntimeBinding)({ userId, providerId, modelName, env: runtimeEnv })
  } catch (error) {
    readinessFailure = doctorReadinessFailure(error)
  }

  const boundStatus = binding?.env && !getStatus ? getModelStatus(binding.env) : status
  report.model = buildModelReport({ binding, readinessFailure, status: boundStatus, provider, modelName, runtimeEnv,
    probeSteps: report.probeSteps, probe })
  report.diagnostics.cache = inspectDoctorCache(binding?.env || userModelEnv, report.model)
  report.blocking = resolveBlocking({
    configured: report.model.configured,
    binding,
    readinessFailure,
    workspace: report.workspace,
    model: report.model,
  })
  if (!report.blocking && report.probeSteps && report.model.probe.status !== 'passed') {
    const failure = report.probeSteps.find((step) => step.name !== 'reachable' && !step.ok)
    report.blocking = { code: failure?.code || 'MODEL_READINESS_FAILED', action: 'test_provider',
      message: '本次模型探测未通过，不能用此前的就绪状态证明当前可用。请检查端点和模型后重新探测。' }
    report.model.readinessCode = report.blocking.code
    report.model.readinessAction = report.blocking.action
  }
  report.ok = report.blocking === null
  return report
}
