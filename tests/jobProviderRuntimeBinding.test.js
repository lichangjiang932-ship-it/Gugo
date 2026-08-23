import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(
  os.tmpdir(),
  'gugo-job-provider-runtime-binding-tests',
  String(process.pid),
)
delete process.env.MODEL_BASE_URL
delete process.env.MODEL_API_KEY
delete process.env.MODEL_NAME
delete process.env.MODEL_NAMES
delete process.env.MODEL_PROVIDERS

const { JobRuntime } = await import('../server/services/jobRuntime.js')
const {
  recordModelProviderReadiness,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test('background jobs use the saved Provider when process model environment is empty', async () => {
  const { userId } = issueTestSession()
  const provider = upsertModelProvider({
    userId,
    provider: {
      key: 'saved-job-provider',
      label: 'Saved Job Provider',
      baseUrl: 'https://saved-job-provider.example.test/v1',
      apiKey: 'saved-job-secret',
      models: ['saved-job-model'],
      defaultModel: 'saved-job-model',
      enabled: true,
      isDefault: true,
    },
  })
  recordModelProviderReadiness({
    userId,
    id: provider.id,
    modelName: 'saved-job-model',
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })

  let plannerBinding = null
  const executionBindings = []
  const runtime = new JobRuntime({
    planner: (prompt, options) => {
      plannerBinding = options
      return {
        title: prompt,
        steps: [{ kind: 'execute', title: 'Use the saved Provider' }],
      }
    },
    executeStep: async ({ modelEnv, step }) => {
      executionBindings.push({ modelEnv, step: step.kind })
      return { ok: true, output: { text: step.title, complete: true } }
    },
  })

  const job = await runtime.createJob('Run without model environment variables', {
    userId,
    modelProviderId: provider.id,
    modelName: 'saved-job-model',
    env: {},
  })

  assert.equal(job.modelProviderId, provider.id)
  assert.equal(job.modelConfigRevision, provider.configRevision)
  assert.equal(plannerBinding.modelName, 'saved-job-model')
  assert.equal(plannerBinding.modelProviderId, provider.id)
  assert.equal(plannerBinding.modelConfigRevision, provider.configRevision)
  assert.deepEqual({
    baseUrl: plannerBinding.modelEnv.MODEL_BASE_URL,
    apiKey: plannerBinding.modelEnv.MODEL_API_KEY,
    modelName: plannerBinding.modelEnv.MODEL_NAME,
    providers: plannerBinding.modelEnv.MODEL_PROVIDERS,
  }, {
    baseUrl: 'https://saved-job-provider.example.test/v1',
    apiKey: 'saved-job-secret',
    modelName: 'saved-job-model',
    providers: 'saved-job-provider',
  })

  await runtime.drain()
  assert.equal(runtime.getJob(job.id, { userId }).status, 'completed')
  assert.ok(executionBindings.length > 0)
  for (const { modelEnv } of executionBindings) {
    assert.equal(modelEnv.MODEL_BASE_URL, 'https://saved-job-provider.example.test/v1')
    assert.equal(modelEnv.MODEL_API_KEY, 'saved-job-secret')
    assert.equal(modelEnv.MODEL_NAME, 'saved-job-model')
    assert.equal(modelEnv.MODEL_PROVIDERS, 'saved-job-provider')
  }
})
