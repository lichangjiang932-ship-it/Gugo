import assert from 'node:assert/strict'
import test from 'node:test'

import {
  artifactTypeForSkill,
  buildChatFailureDisplayKey,
  buildChatFailureMessage,
  getVisibleModelErrorMessage,
  isModelPreExecutionFailure,
  isModelSetupFailure,
  isPreExecutionFailure,
  isRuntimeInterruptionFailure,
  isRuntimeUnavailableFailure,
} from '../src/lib/chatFlowGuards.js'
import { translations } from '../src/i18n/translations.js'

const COPY = {
  'errors.chatFailure': '任务执行遇到问题，尚未完成。',
  'errors.runtimeUnavailable': '本地运行时正在启动或重启，消息尚未发出。请稍后重试。',
  'errors.runtimeInterrupted': '本地运行时在任务执行期间停止或重启。本次执行已中断，已完成的进度会保留；请等待运行时就绪后继续。',
  'errors.modelConfigurationFailure': '模型服务尚未正确配置。',
  'errors.modelProviderUnverified': '所选模型服务尚未完成可用性测试。',
  'errors.modelProviderChatOnly': '所选模型仅支持普通聊天。',
  'errors.modelProviderChanged': '任务绑定的模型配置已变更。',
  'errors.modelAuthenticationFailed': '模型服务拒绝了访问凭证。',
  'errors.modelEndpointNotFound': '找不到所选模型。',
  'errors.modelEndpointTimeout': '连接模型服务超时。',
  'errors.modelEndpointUnavailable': '当前无法连接模型服务。',
  'errors.modelConfigurationAction': '请前往“设置 → 模型”检查配置。',
  'errors.emptyModelResponse': 'translated:errors.emptyModelResponse',
  'errors.emptyModelResponseLength': 'translated:errors.emptyModelResponseLength',
}
const t = (key) => COPY[key] || key

test('chat failure copy does not blame env config for a generic invalid request', () => {
  const text = buildChatFailureMessage('请求参数无效：请检查消息内容或当前模型兼容性。', t)
  assert.match(text, /任务执行遇到问题/)
  assert.doesNotMatch(text, /Model call failed/i)
  assert.doesNotMatch(text, /MODEL_BASE_URL/)
  assert.doesNotMatch(text, /MODEL_API_KEY/)
})

test('chat failure copy never exposes internal artifact errors or incomplete-file handoff copy', () => {
  const text = buildChatFailureMessage(
    'Model call failed: The requested file was not created. The model must successfully call: create_html_app.',
    t,
  )
  assert.match(text, /任务执行遇到问题/)
  assert.doesNotMatch(text, /Model call failed|requested file|create_html_app|任务未完全完成|已保留生成的文件/i)
})

test('deterministic loop failures show their sanitized reason instead of a generic retry nudge', () => {
  const detail = '同一工具调用在最近 8 次调用中已重复 3 次，未取得实质进展'
  const failure = {
    role: 'assistant',
    message: detail,
    meta: {
      failed: true,
      serverFailure: {
        code: 'repeated_tool_call_window',
        message: detail,
        retryable: false,
      },
    },
  }

  assert.equal(buildChatFailureMessage(failure, t), `\n\n${detail}`)
  assert.equal(getVisibleModelErrorMessage(failure, t), detail)

  const unknown = {
    ...failure,
    meta: {
      ...failure.meta,
      serverFailure: { code: 'UNKNOWN_INTERNAL_FAILURE', message: detail, retryable: false },
    },
  }
  assert.equal(getVisibleModelErrorMessage(unknown, t), COPY['errors.chatFailure'])

  const exhausted = {
    message: '本任务已经执行过一次断点续写但仍未完成。请调整条件后发送新消息。',
    code: 'TURN_FAILED_RETRY_LIMIT_REACHED',
    retryable: false,
  }
  assert.match(getVisibleModelErrorMessage(exhausted, t), /执行过一次断点续写/)
})

test('failure display keys collapse the same turn and failure code', () => {
  assert.equal(
    buildChatFailureDisplayKey('turn-1', { serverFailure: { code: 'ARTIFACT_NOT_CREATED' } }),
    'turn-1:ARTIFACT_NOT_CREATED',
  )
  assert.equal(
    buildChatFailureDisplayKey('turn-1', { code: 'ARTIFACT_NOT_CREATED' }),
    'turn-1:ARTIFACT_NOT_CREATED',
  )
})

test('chat failure copy directs users to model settings for configuration failures', () => {
  const error = Object.assign(new Error('后端模型未配置：缺少 MODEL_BASE_URL。'), {
    code: 'MODEL_CONFIG_MISSING',
  })
  const text = buildChatFailureMessage(error, t)
  assert.match(text, /模型服务尚未正确配置/)
  assert.match(text, /设置 → 模型/)
  assert.doesNotMatch(text, /MODEL_BASE_URL|MODEL_API_KEY/)
  assert.doesNotMatch(text, /请联系管理员/)
})

test('runtime host preflight failures explain that the message was not sent', () => {
  for (const code of [
    'RUNTIME_NOT_READY',
    'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
    'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
    'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
    'TURN_ENGINE_SHUTTING_DOWN',
    'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
    'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
    'TURN_ENGINE_HOST_CLEANUP_FAILED',
  ]) {
    const error = Object.assign(new Error('internal runtime detail'), { code })
    assert.equal(isRuntimeUnavailableFailure(error), true, code)
    assert.equal(
      getVisibleModelErrorMessage(error, t),
      '本地运行时正在启动或重启，消息尚未发出。请稍后重试。',
      code,
    )
    const text = buildChatFailureMessage(error, t)
    assert.match(text, /消息尚未发出/)
    assert.doesNotMatch(text, /internal runtime detail|任务执行遇到问题/)
  }
  const rejectedShutdown = {
    role: 'assistant',
    meta: {
      failed: true,
      executionStarted: false,
      serverFailure: { code: 'TURN_ENGINE_SHUTDOWN', action: 'retry' },
    },
  }
  assert.equal(isRuntimeUnavailableFailure(rejectedShutdown), true)
  assert.equal(isRuntimeInterruptionFailure(rejectedShutdown), false)
  assert.equal(isPreExecutionFailure(rejectedShutdown), true)
  assert.equal(isModelPreExecutionFailure(rejectedShutdown), true)
  assert.equal(getVisibleModelErrorMessage(rejectedShutdown, t), COPY['errors.runtimeUnavailable'])

  const interruption = Object.assign(new Error('internal runtime detail'), {
    code: 'TURN_ENGINE_SHUTDOWN',
  })
  assert.equal(isRuntimeUnavailableFailure(interruption), false)
  assert.equal(isRuntimeInterruptionFailure(interruption), true)
  assert.equal(
    getVisibleModelErrorMessage(interruption, t),
    COPY['errors.runtimeInterrupted'],
  )
  assert.match(buildChatFailureMessage(interruption, t), /执行已中断/)
  assert.doesNotMatch(buildChatFailureMessage(interruption, t), /消息尚未发出/)
  assert.equal(isRuntimeUnavailableFailure({ code: 'TURN_FAILED' }), false)
})

test('runtime restart actions are diagnostic-only and execution phase controls visible copy', () => {
  const preflight = {
    role: 'assistant',
    meta: {
      failed: true,
      executionStarted: false,
      serverFailure: {
        code: 'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
        action: 'restart_runtime',
      },
    },
  }
  assert.equal(isModelPreExecutionFailure(preflight), false)
  assert.equal(isPreExecutionFailure(preflight), true)
  assert.equal(getVisibleModelErrorMessage(preflight, t), COPY['errors.runtimeUnavailable'])

  const interrupted = {
    ...preflight,
    meta: { ...preflight.meta, executionStarted: true },
  }
  assert.equal(getVisibleModelErrorMessage(interrupted, t), COPY['errors.runtimeInterrupted'])

  const retryable = {
    ...preflight,
    meta: {
      ...preflight.meta,
      serverFailure: { code: 'TURN_ENGINE_SHUTTING_DOWN', action: 'retry' },
    },
  }
  assert.equal(isModelPreExecutionFailure(retryable), true)
})

test('all model readiness, authentication, and endpoint failures retain one settings action', () => {
  const codes = [
    'MODEL_CONFIG_MISSING',
    'MODEL_PROVIDER_UNVERIFIED',
    'MODEL_PROVIDER_CHAT_ONLY',
    'MODEL_PROVIDER_UNAVAILABLE',
    'MODEL_PROVIDER_CONFIG_CHANGED',
    'MODEL_PROVIDER_BINDING_MISSING',
    'MODEL_PROVIDER_AMBIGUOUS',
    'MODEL_AUTH_FAILED',
    'MODEL_ENDPOINT_NOT_FOUND',
    'MODEL_ENDPOINT_TIMEOUT',
    'MODEL_ENDPOINT_UNREACHABLE',
    'MODEL_ENDPOINT_HTTP_ERROR',
    'MODEL_ENDPOINT_PROBE_FAILED',
  ]
  for (const code of codes) {
    const error = Object.assign(new Error('raw provider failure'), { code })
    assert.equal(isModelSetupFailure(error), true, code)
    const text = buildChatFailureMessage(error, t)
    assert.equal(text.match(/设置 → 模型/g)?.length, 1, code)
    assert.doesNotMatch(text, /raw provider failure|MODEL_/i, code)
  }
})

test('only local readiness failures without execution evidence are safe to resend', () => {
  const preflight = {
    role: 'assistant',
    content: 'Configure a model before sending.',
    meta: {
      failed: true,
      serverFailure: { code: 'MODEL_CONFIG_MISSING' },
    },
  }
  assert.equal(isModelPreExecutionFailure(preflight), true)
  for (const code of [
    'MODEL_CONFIG_MISSING',
    'MODEL_PROVIDER_UNVERIFIED',
    'MODEL_PROVIDER_CHAT_ONLY',
    'MODEL_PROVIDER_UNAVAILABLE',
    'MODEL_PROVIDER_CONFIG_CHANGED',
    'MODEL_PROVIDER_BINDING_MISSING',
    'MODEL_PROVIDER_AMBIGUOUS',
    'RUNTIME_NOT_READY',
    'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
    'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
    'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
    'TURN_ENGINE_SHUTTING_DOWN',
    'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
    'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
    'TURN_ENGINE_HOST_CLEANUP_FAILED',
  ]) {
    assert.equal(isModelPreExecutionFailure({
      ...preflight,
      meta: { ...preflight.meta, serverFailure: { code } },
    }), true, code)
  }
  for (const code of [
    'MODEL_AUTH_FAILED',
    'MODEL_ENDPOINT_NOT_FOUND',
    'MODEL_ENDPOINT_TIMEOUT',
    'MODEL_ENDPOINT_UNREACHABLE',
    'MODEL_ENDPOINT_HTTP_ERROR',
    'MODEL_ENDPOINT_PROBE_FAILED',
    'MODEL_NOT_FOUND',
    'MODEL_TOOLS_UNSUPPORTED',
    'MODEL_TIMEOUT',
    'MODEL_UPSTREAM_ERROR',
    'MODEL_REQUEST_OUTCOME_UNKNOWN',
    'MODEL_REQUEST_CONTEXT_DRIFT',
    'STREAM_TRUNCATED',
    'TURN_STREAM_TRUNCATED',
    'TURN_RECONNECT_EXHAUSTED',
    'TURN_INTERRUPTED',
    'TURN_ENGINE_SHUTDOWN',
    'TURN_FAILED',
  ]) {
    assert.equal(isModelPreExecutionFailure({
      ...preflight,
      meta: { ...preflight.meta, serverFailure: { code } },
    }), false, code)
  }
  assert.equal(isModelPreExecutionFailure({
    ...preflight,
    meta: {
      ...preflight.meta,
      serverFailure: null,
    },
    content: 'model endpoint unreachable before any visible output',
  }), false, 'message heuristics must never authorize a replay')
  assert.equal(isModelPreExecutionFailure({
    ...preflight,
    meta: {
      ...preflight.meta,
      serverFailure: null,
      serverFailureDisplayKey: 'turn-1:MODEL_CONFIG_MISSING',
    },
  }), false, 'a display key is not execution evidence')
  assert.equal(isModelPreExecutionFailure({
    ...preflight,
    meta: { ...preflight.meta, failed: false },
  }), false, 'only an explicit failed assistant message may be replayed')
  assert.equal(isModelPreExecutionFailure({
    ...preflight,
    role: 'user',
  }), false, 'a user message can never authorize a replay')
  assert.equal(isModelPreExecutionFailure({
    ...preflight,
    meta: { ...preflight.meta, serverPartialText: 'partial answer' },
  }), false)
  assert.equal(isModelPreExecutionFailure({
    ...preflight,
    meta: { ...preflight.meta, toolCalls: [{ id: 'call-1', name: 'write_file' }] },
  }), false)
  assert.equal(isModelPreExecutionFailure({
    ...preflight,
    meta: { ...preflight.meta, verifiedLocalFiles: [{ path: 'result.txt' }] },
  }), false)
  for (const recoveryEvidence of [
    { serverRecoveryBlocked: true },
    { serverRecoveryKind: 'model_request_outcome_unknown' },
    { serverRecoveryModelRequestId: 'mr_persisted' },
    { modelRequestId: 'mr_dispatched' },
    { modelInvocation: { id: 'mr_checkpoint', status: 'in_flight' } },
    { unsafeToReplay: true },
    { requiresUserVerification: true },
  ]) {
    assert.equal(isModelPreExecutionFailure({
      ...preflight,
      meta: { ...preflight.meta, ...recoveryEvidence },
    }), false, JSON.stringify(recoveryEvidence))
  }
  assert.equal(isModelPreExecutionFailure({
    ...preflight,
    meta: { ...preflight.meta, serverFailure: { code: 'TURN_FAILED' } },
  }), false)
})

test('model failure copy is present in every supported language', () => {
  const keys = [
    'chatFailure',
    'runtimeUnavailable',
    'runtimeInterrupted',
    'modelConfigurationFailure',
    'modelProviderUnverified',
    'modelProviderChatOnly',
    'modelProviderChanged',
    'modelAuthenticationFailed',
    'modelEndpointNotFound',
    'modelEndpointTimeout',
    'modelEndpointUnavailable',
    'modelConfigurationAction',
  ]
  for (const language of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    for (const key of keys) {
      assert.ok(String(translations[language]?.errors?.[key] || '').trim(), `${language}:${key}`)
    }
  }
})

test('artifact type mapping keeps current skill previews', () => {
  for (const skillId of ['ppt', 'htmlppt', 'axippt', 'ppt-master', 'guizang-ppt']) {
    assert.equal(artifactTypeForSkill(skillId), 'pptx')
  }
  assert.equal(artifactTypeForSkill('doc'), 'docx')
  assert.equal(artifactTypeForSkill('webpage'), 'html')
  assert.equal(artifactTypeForSkill('unknown'), undefined)
})

test('visible model errors retain translated empty-response messages and sanitize raw provider errors', () => {
  assert.equal(
    getVisibleModelErrorMessage({ code: 'EMPTY_MODEL_RESPONSE' }, t),
    'translated:errors.emptyModelResponse',
  )
  assert.equal(
    getVisibleModelErrorMessage(new Error('upstream failed'), t),
    '任务执行遇到问题，尚未完成。',
  )
})
