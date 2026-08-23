import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveTaskModelPreflight,
  shouldClearTaskErrorAfterJobRefresh,
  taskRunErrorRecovery,
  taskRunJobFailureRecovery,
} from '../src/pages/taskRun/useTaskRunController.js'

test('task run errors keep model configuration, manual verification, and recreation distinct', () => {
  assert.deepEqual(
    taskRunErrorRecovery({
      code: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
      action: 'verify_model_request',
      modelRequestId: 'mr_job_1',
      stepId: 'step-1',
      unsafeToReplay: true,
      requiresUserVerification: true,
    }, { jobId: 'job-1' }),
    {
      action: 'verify_model_request',
      target: {
        scopeKind: 'job',
        jobId: 'job-1',
        stepId: 'step-1',
        modelRequestId: 'mr_job_1',
      },
    },
  )
  assert.deepEqual(
    taskRunErrorRecovery({
      code: 'MODEL_REQUEST_CONTEXT_DRIFT',
      action: 'recreate_job',
    }, { jobId: 'job-1', stepId: 'step-1' }),
    { action: 'recreate_job', target: null },
  )
  assert.deepEqual(
    taskRunErrorRecovery({
      code: 'MODEL_PROVIDER_UNVERIFIED',
      action: 'test_provider',
    }),
    { action: 'configure_model', target: null },
  )
  assert.deepEqual(
    taskRunErrorRecovery({ code: 'MODEL_HTTP_ERROR' }),
    { action: '', target: null },
  )
})

test('manual model verification is not given an unsafe partial recovery target', () => {
  assert.deepEqual(
    taskRunErrorRecovery({
      action: 'verify_model_request',
      modelRequestId: 'mr_job_1',
    }, { jobId: 'job-1' }),
    { action: 'verify_model_request', target: null },
  )
})

test('a refreshed failed job restores its persisted model configuration action', () => {
  assert.deepEqual(taskRunJobFailureRecovery({
    id: 'job-refresh',
    status: 'failed',
    error: '端点不可达',
    events: [
      { type: 'started', message: 'started' },
      {
        type: 'failed',
        stepId: 'step-refresh',
        message: '端点不可达，请确认本地模型服务或代理已启动。',
        payload: {
          code: 'MODEL_ENDPOINT_UNREACHABLE',
          action: 'test_provider',
          providerId: 'provider-refresh',
          modelName: 'local-model',
          configRevision: 4,
        },
      },
    ],
  }), {
    message: '端点不可达，请确认本地模型服务或代理已启动。',
    failure: {
      code: 'MODEL_ENDPOINT_UNREACHABLE',
      action: 'test_provider',
      providerId: 'provider-refresh',
      modelName: 'local-model',
      configRevision: 4,
    },
    action: 'configure_model',
    target: null,
  })
  assert.equal(taskRunJobFailureRecovery({
    id: 'job-running',
    status: 'running',
    events: [{ type: 'failed', payload: { action: 'test_provider' } }],
  }), null)
})

test('a refreshed failed job never revives recovery from an older failed attempt', () => {
  assert.equal(taskRunJobFailureRecovery({
    id: 'job-retried',
    status: 'failed',
    error: '工具执行失败',
    events: [
      {
        type: 'failed',
        message: '旧模型配置失败',
        payload: {
          code: 'MODEL_CONFIG_MISSING',
          action: 'configure_model',
        },
      },
      { type: 'retry_requested', message: 'retrying' },
      {
        type: 'failed',
        message: '最新一次是普通工具失败',
        payload: { toolName: 'write_file' },
      },
    ],
  }), null)
})

test('local task errors clear only when the same failed job recovers elsewhere', () => {
  assert.equal(shouldClearTaskErrorAfterJobRefresh(
    { id: 'job-1', status: 'failed' },
    { id: 'job-1', status: 'running' },
  ), true)
  assert.equal(shouldClearTaskErrorAfterJobRefresh(
    { id: 'job-1', status: 'failed' },
    { id: 'job-1', status: 'completed' },
  ), true)
  assert.equal(shouldClearTaskErrorAfterJobRefresh(
    { id: 'job-1', status: 'running' },
    { id: 'job-1', status: 'completed' },
  ), false)
  assert.equal(shouldClearTaskErrorAfterJobRefresh(
    { id: 'job-1', status: 'failed' },
    { id: 'job-2', status: 'running' },
  ), false)
})

test('task model preflight selects the server default before job creation', () => {
  const result = resolveTaskModelPreflight({
    status: { configured: true, modelName: 'local-agent' },
    selection: {},
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.selection, { modelName: 'local-agent', providerId: '' })
})

test('task model preflight blocks missing and chat-only models with actionable errors', () => {
  const missing = resolveTaskModelPreflight({
    status: { configured: false },
    selection: {},
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'MODEL_CONFIG_MISSING')
  assert.equal(missing.error.action, 'configure_model')

  const chatOnly = resolveTaskModelPreflight({
    status: {
      configured: true,
      models: [{
        name: 'chat-only',
        provider: 'provider-1',
        providerKey: 'provider-key',
        configRevision: 3,
        readiness: { configRevision: 3, mode: 'chat_only', chat: true, tools: false, agent: false },
      }],
    },
    selection: { modelName: 'chat-only', providerId: 'provider-1' },
  })
  assert.equal(chatOnly.ok, false)
  assert.equal(chatOnly.error.code, 'MODEL_PROVIDER_CHAT_ONLY')
  assert.equal(chatOnly.error.action, 'choose_agent_provider')
})
