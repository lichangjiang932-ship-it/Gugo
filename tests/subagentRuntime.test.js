import test from 'node:test'
import assert from 'node:assert/strict'
import '../server/services/loop/index.js'
import { issueTestSession } from './helpers/testAuth.js'
import {
  SUBAGENT_TYPES,
  getSubagentRun,
  recoverInterruptedSubagentRuns,
  runSubagentBatch as runSubagentBatchRuntime,
  runSubagent as runSubagentRuntime,
  listSubagentTypes,
  _testing,
} from '../server/services/subagentRuntime.js'
import { createJobBudget } from '../server/utils/jobBudget.js'
import { getDb } from '../server/db.js'
import { createSqliteSubagentRunPersistenceAdapter } from '../server/adapters/sqliteSubagentRunPersistenceAdapter.js'
import {
  recordModelProviderReadiness,
  upsertModelProvider,
} from '../server/services/modelProviderStore.js'
import { resolveAgentModelRuntimeBinding } from '../server/services/modelReadinessService.js'
import { resolveUnknownSideEffect } from '../server/services/sideEffectRecoveryService.js'
import { revalidateToolPermission } from '../server/services/approvalGate.js'

const previousCredentialEncryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY
process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64')
test.after(() => {
  if (previousCredentialEncryptionKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY
  else process.env.CREDENTIAL_ENCRYPTION_KEY = previousCredentialEncryptionKey
})

const { userId } = issueTestSession({ email: 'subagent-test@example.com' })
const persistencePort = createSqliteSubagentRunPersistenceAdapter({ getDb })

function resolveTestModelBinding({ modelName, requirePersistedBinding } = {}) {
  const selectedModel = String(modelName || '').trim()
  if (requirePersistedBinding && !selectedModel) {
    throw Object.assign(new Error('persisted model snapshot is missing'), {
      code: 'MODEL_PROVIDER_BINDING_MISSING',
      statusCode: 409,
    })
  }
  return {
    providerId: null,
    modelName: selectedModel || 'test-subagent-model',
    configRevision: null,
    env: {
      MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
      MODEL_NAME: selectedModel || 'test-subagent-model',
      MODEL_NAMES: selectedModel || 'test-subagent-model',
      MODEL_STRICT_SELECTION: '1',
    },
  }
}

function runSubagent(options) {
  return runSubagentRuntime({
    persistencePort,
    resolveModelBinding: resolveTestModelBinding,
    ...options,
  })
}

function runSubagentBatch(options) {
  return runSubagentBatchRuntime({
    persistencePort,
    resolveModelBinding: resolveTestModelBinding,
    ...options,
  })
}

function readSubagentRun(input) {
  return getSubagentRun(input, { persistencePort })
}

function approveMutationForTest({ userId: approvalUserId, origin, toolName, args }) {
  const gate = revalidateToolPermission({
    userId: approvalUserId,
    origin,
    toolName,
    args,
    allowAsk: true,
  })
  assert.equal(gate.proceed, true, gate.reason)
  return { ...gate, approvalId: `subagent-runtime-test-${toolName}` }
}

test('listSubagentTypes returns explore, plan, general', () => {
  const types = listSubagentTypes()
  const ids = types.map((t) => t.id).sort()
  assert.deepEqual(ids, ['explore', 'general', 'plan'])
})

test('SUBAGENT_TYPES have system prompts and tool specs', () => {
  for (const [id, type] of Object.entries(SUBAGENT_TYPES)) {
    assert.ok(type.label, `${id} should have a label`)
    assert.ok(type.system, `${id} should have a system prompt`)
    assert.ok(Array.isArray(type.tools), `${id} should have tools array`)
    assert.ok(type.tools.length > 0, `${id} should have at least one tool`)
  }
})

test('subagent model calls consume the shared hard budget and still return a wrap-up', async () => {
  const budget = createJobBudget({
    maxModelCalls: 1,
    maxModelTokens: 100,
  })
  let providerCalls = 0
  const result = await _testing.subagentToolsLoop({
    messages: [
      { role: 'system', content: 'Test subagent.' },
      { role: 'user', content: 'Inspect one item.' },
    ],
    tools: [SUBAGENT_TYPES.explore.tools.find((tool) => tool.function.name === 'read_file')],
    maxIters: 3,
    userId,
    budget,
    approveTool: async ({ args }) => ({ proceed: true, args }),
    executeTool: async () => ({ ok: true, content: 'evidence' }),
    callModel: async () => {
      providerCalls += 1
      if (providerCalls === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'read-1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
          usage: { promptTokens: 10, completionTokens: 5 },
          costUsd: 0.01,
        }
      }
      return {
        content: 'Budget wrap-up with evidence.',
        toolCalls: [],
        usage: { promptTokens: 5, completionTokens: 5 },
        costUsd: 0.01,
      }
    },
  })
  assert.equal(result.budgetExceeded, true)
  assert.equal(result.incomplete, true)
  assert.match(result.text, /Budget wrap-up with evidence\./)
  assert.equal(providerCalls, 2, 'one normal request plus one explicit wrap-up')
  assert.equal(budget.snapshot().modelCalls, 2)
  assert.equal(budget.snapshot().modelTokens, 25)
  assert.equal(budget.snapshot().costUsd, 0.02)
})

test('explore and plan types have read-only tools', () => {
  const readonly = ['explore', 'plan']
  for (const typeId of readonly) {
    const names = SUBAGENT_TYPES[typeId].tools.map((t) => t.function.name)
    assert.ok(names.includes('web_search'), `${typeId} should have web_search`)
    assert.ok(names.includes('fetch_url'), `${typeId} should have fetch_url`)
    assert.ok(names.includes('read_file'), `${typeId} should have read_file`)
    assert.ok(!names.includes('write_file'), `${typeId} should NOT have write_file`)
  }
})

test('general type has full read-write tools', () => {
  const names = SUBAGENT_TYPES.general.tools.map((t) => t.function.name)
  assert.ok(names.includes('web_search'))
  assert.ok(names.includes('write_file'))
  assert.ok(names.includes('edit_file'))
  assert.ok(names.includes('Agent'))
})

test('subagent custom executors persist durable file mutations in the side-effect ledger', async () => {
  const runId = `subagent-side-effect-${Date.now()}-${Math.random()}`
  const toolCallId = `${runId}-write`
  const writeSpec = SUBAGENT_TYPES.general.tools.find((tool) => tool.function.name === 'write_file')
  let modelCalls = 0
  let executions = 0

  const result = await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: 'write the requested file' }],
    tools: [writeSpec],
    userId,
    sessionId: `subagent:${runId}`,
    runId,
    approveTool: approveMutationForTest,
    callModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: toolCallId,
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'subagent-ledger.txt', content: 'durable' }),
            },
          }],
        }
      }
      return { content: 'done', toolCalls: [] }
    },
    executeTool: async (name, args) => {
      executions += 1
      assert.equal(name, 'write_file')
      assert.equal(args.path, 'subagent-ledger.txt')
      return { ok: true, path: args.path, bytes: args.content.length }
    },
  })

  assert.match(result.text, /subagent-ledger\.txt/)
  assert.equal(executions, 1)
  const record = getDb().prepare(`
    SELECT owner_id, scope_kind, job_id, step_id, tool_call_id, tool_name, status
    FROM side_effect_executions
    WHERE owner_id = ? AND job_id = ? AND step_id = ? AND tool_call_id = ?
  `).get(userId, runId, runId, toolCallId)
  assert.deepEqual(record, {
    owner_id: userId,
    scope_kind: 'job',
    job_id: runId,
    step_id: runId,
    tool_call_id: toolCallId,
    tool_name: 'write_file',
    status: 'committed',
  })
})

test('subagent tool wrapper preserves write_file recovery identity and capability', async () => {
  const writeSpec = SUBAGENT_TYPES.general.tools.find((tool) => tool.function.name === 'write_file')
  const observed = []
  const executeTool = Object.assign(
    async (name, args, context) => {
      observed.push({ name, args, context })
      return { ok: true, path: args.path, idempotencyRecovered: true }
    },
    {
      supportsIdempotentResume: ({ name, idempotencyKey } = {}) => (
        name === 'write_file' && idempotencyKey === 'subagent-idempotency-key'
      ),
    },
  )

  const result = await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: 'resume a durable write' }],
    tools: [writeSpec],
    userId,
    sessionId: 'subagent:wrapper-recovery',
    runId: 'wrapper-recovery',
    executeTool,
    runToolLoop: async (options) => {
      assert.equal(options.executeTool.supportsIdempotentResume({
        name: 'write_file',
        idempotencyKey: 'subagent-idempotency-key',
      }), true)
      assert.equal(options.executeTool.supportsIdempotentResume({
        name: 'edit_file',
        idempotencyKey: 'subagent-idempotency-key',
      }), false)
      await options.executeTool({
        name: 'write_file',
        args: { path: 'resume.txt', content: 'committed' },
        signal: options.signal,
        budget: options.runtimeBudget,
        toolCallId: 'subagent-tool-call-id',
        idempotencyKey: 'subagent-idempotency-key',
        idempotentResume: true,
      })
      return { text: 'recovered', terminal: true }
    },
  })

  assert.equal(result.text, 'recovered')
  assert.equal(observed.length, 1)
  assert.equal(observed[0].name, 'write_file')
  assert.equal(observed[0].context.toolCallId, 'subagent-tool-call-id')
  assert.equal(observed[0].context.idempotencyKey, 'subagent-idempotency-key')
  assert.equal(observed[0].context.idempotentResume, true)
})

test('builtin subagent executor only declares idempotent resume for keyed write_file', () => {
  const supports = _testing.executeSubagentTool.supportsIdempotentResume
  assert.equal(supports({ name: 'write_file', idempotencyKey: 'stable-key' }), true)
  assert.equal(supports({ name: 'write_file', idempotencyKey: '' }), false)
  assert.equal(supports({ name: 'edit_file', idempotencyKey: 'stable-key' }), false)
  assert.equal(supports({ name: 'apply_patch', idempotencyKey: 'stable-key' }), false)
  assert.equal(supports({ name: 'batch_rename', idempotencyKey: 'stable-key' }), false)
})

test('runSubagent requires userId and prompt', async () => {
  await assert.rejects(runSubagent({ prompt: 'test' }), /userId is required/)
  await assert.rejects(runSubagent({ userId, prompt: '' }), /prompt is required/)
  await assert.rejects(runSubagent({ userId, prompt: 'test', type: 'invalid' }), /unknown subagent type/)
})

test('runSubagent creates a DB record', async () => {
  // Mock the model call by overriding — for now just test DB insertion
  // This test runs without a real model call, so it will throw on model connection.
  // We verify the DB record was created before the error happens.
  try {
    await runSubagent({ userId, type: 'general', prompt: '测试任务，不需要真实执行' })
  } catch {
    // Expected — no model configured in test env
  }
  // Check that records exist for this user
  const db = (await import('../server/db.js')).getDb()
  const rows = db.prepare('SELECT * FROM subagent_runs WHERE user_id = ?').all(userId)
  assert.ok(rows.length >= 1, 'at least 1 subagent run should be recorded')
  assert.equal(rows[0].agent_type, 'general')
})

test('subagent injects optional skill and memory context and degrades when preparation fails', async () => {
  let capturedMessages = []
  let capturedModel = null
  let contextInput = null
  const run = await runSubagent({
    userId,
    type: 'explore',
    prompt: 'inspect memory pipeline',
    modelName: 'subagent-context-model',
    agentId: 'agent-context',
    skillIds: ['review'],
    preparePromptContext: (input) => {
      contextInput = input
      return {
        messages: [
          { role: 'system', content: '# Skills\nreview carefully' },
          { role: 'system', content: '# Long-term memory\nknown constraint' },
        ],
      }
    },
    callModel: async ({ messages, modelName }) => {
      capturedMessages = messages
      capturedModel = modelName
      return { content: 'done', toolCalls: [] }
    },
  })
  assert.equal(run.status, 'completed')
  assert.equal(contextInput.agentId, 'agent-context')
  assert.deepEqual(contextInput.skillIds, ['review'])
  assert.equal(capturedModel, 'subagent-context-model')
  assert.ok(capturedMessages.some((message) => message.content.includes('review carefully')))
  assert.ok(capturedMessages.some((message) => message.content.includes('known constraint')))

  const degraded = await runSubagent({
    userId,
    type: 'explore',
    prompt: 'continue without memory',
    preparePromptContext: () => { throw new Error('context unavailable') },
    callModel: async () => ({ content: 'still completed', toolCalls: [] }),
  })
  assert.equal(degraded.status, 'completed')
  assert.equal(degraded.resultText, 'still completed')
})

test('subagent persists and revalidates the inherited Provider snapshot', async () => {
  const id = `subagent-binding-${Date.now()}`
  const bindingCalls = []
  let modelRequest = null
  let modelCalls = 0
  const resolveModelBinding = (request) => {
    bindingCalls.push(request)
    return {
      providerId: 'provider-pinned',
      modelName: 'model-pinned',
      configRevision: 5,
      env: {
        MODEL_PROVIDERS: 'pinned',
        MODEL_PROVIDER_PINNED_BASE_URL: 'http://127.0.0.1:11434/v1',
        MODEL_PROVIDER_PINNED_MODELS: 'model-pinned',
        MODEL_NAME: 'model-pinned',
      },
    }
  }
  const run = await runSubagent({
    id,
    userId,
    type: 'explore',
    prompt: 'inspect the pinned provider',
    modelName: 'model-pinned',
    modelProviderId: 'provider-pinned',
    modelConfigRevision: 5,
    resolveModelBinding,
    callModel: async (request) => {
      modelRequest ||= request
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'binding-read-1',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      throw Object.assign(new Error('temporary interruption'), { status: 503 })
    },
    executeTool: async () => ({ ok: true, content: 'durable provider-bound evidence' }),
  })

  assert.equal(run.status, 'interrupted')
  assert.equal(run.modelName, 'model-pinned')
  assert.equal(run.modelProviderId, 'provider-pinned')
  assert.equal(run.modelConfigRevision, 5)
  assert.equal(bindingCalls[0].requirePersistedBinding, false)
  assert.equal(modelRequest.userId, null)
  assert.equal(modelRequest.modelProviderId, undefined)
  assert.equal(modelRequest.env.MODEL_PROVIDERS, 'pinned')

  await assert.rejects(
    runSubagent({
      id,
      userId,
      type: 'explore',
      prompt: 'inspect the pinned provider',
      modelName: 'model-pinned',
      modelProviderId: 'provider-pinned',
      modelConfigRevision: 5,
      resolveModelBinding() {
        throw Object.assign(new Error('provider configuration changed'), {
          code: 'MODEL_PROVIDER_CONFIG_CHANGED',
        })
      },
    }),
    (error) => error?.code === 'MODEL_PROVIDER_CONFIG_CHANGED',
  )
})

test('subagent refuses to resume a legacy database Provider run without its persisted binding snapshot', async () => {
  const legacy = issueTestSession({
    email: `subagent-legacy-binding-${Date.now()}-${Math.random()}@example.com`,
  })
  const provider = upsertModelProvider({
    userId: legacy.userId,
    provider: {
      key: 'subagentlegacy',
      label: 'Subagent legacy',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      models: ['legacy-subagent-model'],
      defaultModel: 'legacy-subagent-model',
      enabled: true,
      isDefault: true,
      kind: 'openai-compatible',
    },
  })
  recordModelProviderReadiness({
    userId: legacy.userId,
    id: provider.id,
    expectedConfigRevision: provider.configRevision,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })
  const id = `subagent-legacy-binding-${Date.now()}`
  const prompt = 'resume without a silently selected Provider'
  getDb().prepare(`
    INSERT INTO subagent_runs
      (id, user_id, agent_type, prompt, model_name, model_provider_id,
       model_config_revision, status, trace_json, created_at, finished_at)
    VALUES (?, ?, 'explore', ?, 'legacy-subagent-model', NULL, NULL,
      'interrupted', '[]', ?, ?)
  `).run(id, legacy.userId, prompt, Date.now(), Date.now())
  let modelCalls = 0

  await assert.rejects(
    runSubagentRuntime({
      persistencePort,
      id,
      userId: legacy.userId,
      type: 'explore',
      prompt,
      modelName: 'legacy-subagent-model',
      modelProviderId: provider.id,
      modelConfigRevision: provider.configRevision,
      resolveModelBinding: resolveAgentModelRuntimeBinding,
      callModel: async () => {
        modelCalls += 1
        return { content: 'must not run', toolCalls: [] }
      },
    }),
    (error) => error?.code === 'MODEL_PROVIDER_BINDING_MISSING'
      && error?.statusCode === 409
      && error?.action === 'recreate_job'
      && error?.details?.reason === 'provider_snapshot_missing',
  )
  assert.equal(modelCalls, 0)
  assert.equal((await readSubagentRun({ userId: legacy.userId, id })).status, 'interrupted')
})

test('subagent compiles an inherited inline skill with the shared quality contract', async () => {
  let capturedMessages = []
  const run = await runSubagent({
    userId,
    type: 'explore',
    prompt: 'review the local workflow',
    skillIds: ['local-inline-review'],
    skillDefinitions: [{
      id: 'local-inline-review',
      name: 'Local inline review',
      description: 'A browser-local review workflow.',
      systemPrompt: 'Use this exact inherited local workflow.',
    }],
    callModel: async ({ messages }) => {
      capturedMessages = messages
      return { content: 'done', toolCalls: [] }
    },
  })

  assert.equal(run.status, 'completed')
  const skillBlock = capturedMessages.find((message) => message.content.startsWith('# Skills'))?.content || ''
  assert.match(skillBlock, /Use this exact inherited local workflow\./)
  assert.match(skillBlock, /gugo-skill-quality:v1/)
})

test('subagent swarm exposes team members with isolated transcripts', async () => {
  const modelsByPrompt = new Map()
  const result = await runSubagentBatch({
    userId,
    request: {
      team_name: 'review swarm',
      model_name: 'swarm-default-model',
      tasks: [
        { type: 'explore', role: 'frontend', prompt: 'inspect frontend' },
        { type: 'plan', role: 'backend', prompt: 'inspect backend', modelName: 'backend-model' },
      ],
    },
    callModel: async ({ messages, modelName }) => {
      const prompt = messages.find((message) => message.role === 'user')?.content
      modelsByPrompt.set(prompt, modelName)
      return { content: `done:${prompt}`, toolCalls: [] }
    },
    resolveModelBinding: ({ modelName }) => ({
      providerId: null,
      modelName,
      configRevision: null,
      env: {
        MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
        MODEL_NAME: modelName,
      },
    }),
  })
  assert.equal(result.parallel, true)
  assert.equal(result.team.mode, 'swarm')
  assert.deepEqual(result.team.members.map((member) => member.role), ['frontend', 'backend'])
  const first = await readSubagentRun({ userId, id: result.runs[0].id })
  const second = await readSubagentRun({ userId, id: result.runs[1].id })
  assert.equal(first.team.id, result.team.id)
  assert.equal(second.team.id, result.team.id)
  assert.ok(first.transcript.some((event) => event.eventType === 'model_response'))
  assert.match(first.resultText, /frontend/)
  assert.doesNotMatch(first.resultText, /backend/)
  assert.match(second.resultText, /backend/)
  assert.equal(modelsByPrompt.get('inspect frontend'), 'swarm-default-model')
  assert.equal(modelsByPrompt.get('inspect backend'), 'backend-model')
})

test('runSubagent persists paused and interrupted loop terminals without claiming completion', async () => {
  for (const terminal of [
    { paused: true, expected: 'paused' },
    { interrupted: true, expected: 'interrupted' },
    { incomplete: true, expected: 'interrupted' },
    { budgetExceeded: true, expected: 'interrupted' },
    { noProgress: true, expected: 'interrupted' },
    { text: 'done', expected: 'completed' },
  ]) {
    assert.equal(_testing.subagentStatusForLoopResult(terminal), terminal.expected)
  }

  const paused = await runSubagent({
    id: `subagent-paused-${Date.now()}`,
    userId,
    type: 'explore',
    prompt: 'inspect the relevant area',
    callModel: async () => ({
      content: '',
      toolCalls: [{
        id: 'clarify-1',
        function: {
          name: 'request_clarification',
          arguments: JSON.stringify({ question: 'Which area should be inspected?' }),
        },
      }],
    }),
  })
  assert.equal(paused.status, 'paused')
  assert.match(paused.resultText, /需要澄清/)

  let modelCalls = 0
  const interrupted = await runSubagent({
    id: `subagent-interrupted-${Date.now()}`,
    userId,
    type: 'explore',
    prompt: 'inspect one file',
    callModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'read-1',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      throw Object.assign(new Error('provider interrupted'), { status: 503 })
    },
    executeTool: async () => ({ ok: true, content: 'evidence' }),
  })
  assert.equal(interrupted.status, 'interrupted')
  assert.match(interrupted.resultText, /探索中断/)
})

test('stale running subagent is marked interrupted and resumes completed tool outcomes from its checkpoint', async () => {
  let checkpoint = null
  let modelCalls = 0
  let toolCalls = 0
  const prompt = 'resume checkpoint evidence'
  const initial = await _testing.subagentToolsLoop({
    messages: [{ role: 'user', content: prompt }],
    tools: [SUBAGENT_TYPES.explore.tools.find((tool) => tool.function.name === 'read_file')],
    userId,
    callModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'checkpoint-read-1',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
          }],
        }
      }
      throw Object.assign(new Error('simulated restart'), { status: 503 })
    },
    executeTool: async () => {
      toolCalls += 1
      return { ok: true, content: 'durable evidence' }
    },
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return { state }
    },
  })
  assert.equal(initial.interrupted, true)
  assert.ok(checkpoint)
  assert.equal(toolCalls, 1)

  const id = `subagent-resume-${Date.now()}`
  const at = Date.now()
  getDb().prepare(`
    INSERT INTO subagent_runs
      (id, user_id, agent_type, prompt, model_name, status, trace_json, created_at)
    VALUES (?, ?, 'explore', ?, 'test-subagent-model', 'running', ?, ?)
  `).run(id, userId, prompt, JSON.stringify([
    { type: 'start', at },
    { type: 'runtime_checkpoint', state: checkpoint, at },
  ]), at)

  const pendingRecovery = getDb().prepare(
    "SELECT COUNT(*) AS count FROM subagent_runs WHERE status = 'running'",
  ).get().count
  assert.equal(await recoverInterruptedSubagentRuns({ at: at + 1, persistencePort }), pendingRecovery)
  const recovered = await readSubagentRun({ userId, id })
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.trace.some((event) => event.type === 'runtime_checkpoint'), false)
  assert.equal(recovered.trace.at(-1).resumable, true)

  let resumedModelCalls = 0
  const resumed = await runSubagent({
    id,
    userId,
    type: 'explore',
    prompt,
    callModel: async ({ messages }) => {
      resumedModelCalls += 1
      assert.ok(messages.some((message) => (
        message.role === 'tool' && String(message.content).includes('durable evidence')
      )))
      return { content: 'resumed and completed', toolCalls: [] }
    },
    executeTool: async () => {
      toolCalls += 1
      return { ok: true }
    },
  })
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.resultText, 'resumed and completed')
  assert.equal(resumedModelCalls, 1)
  assert.equal(toolCalls, 1, 'a completed checkpointed tool must not be replayed')
  assert.equal(resumed.trace.some((event) => event.type === 'runtime_checkpoint'), false)
  const persistedTrace = JSON.parse(getDb().prepare(`
    SELECT trace_json
    FROM subagent_runs
    WHERE user_id = ? AND id = ?
  `).get(userId, id).trace_json)
  assert.ok(
    persistedTrace.some((event) => event.type === 'runtime_checkpoint'),
    'completed runs must retain their internal checkpoint for terminal-write CAS validation',
  )
})

test('unknown subagent side effect requires exact resolution before same-run explicit resume', async () => {
  const runId = `subagent-unknown-${Date.now()}-${Math.random()}`
  const toolCallId = `${runId}-write`
  const verificationCallId = `${runId}-verify`
  const prompt = 'perform one durable write'
  const secretContent = `private-write-${Math.random()}`
  let modelCalls = 0
  let writeExecutions = 0
  let readExecutions = 0
  let resumedMessages = []
  const callModel = async ({ messages }) => {
    modelCalls += 1
    if (modelCalls === 1) {
      return {
        content: '',
        toolCalls: [{
          id: toolCallId,
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'unknown-side-effect.txt', content: secretContent }),
          },
        }],
      }
    }
    resumedMessages = messages
    if (modelCalls === 2) {
      return {
        content: '',
        toolCalls: [{
          id: verificationCallId,
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'unknown-side-effect.txt' }),
          },
        }],
      }
    }
    return { content: 'resumed and completed', toolCalls: [] }
  }
  const executeTool = async (name, args) => {
    if (name === 'write_file') {
      writeExecutions += 1
      throw new Error('transport failed after the durable write boundary')
    }
    assert.equal(name, 'read_file')
    assert.equal(args.path, 'unknown-side-effect.txt')
    readExecutions += 1
    return { ok: true, path: args.path, content: secretContent }
  }
  const options = {
    id: runId,
    userId,
    type: 'general',
    prompt,
    callModel,
    executeTool,
    approveTool: approveMutationForTest,
  }

  await assert.rejects(
    runSubagent(options),
    (error) => error?.code === 'SUBAGENT_SIDE_EFFECT_NEEDS_VERIFICATION'
      && error?.runId === runId
      && error?.toolCallId === toolCallId
      && error?.requiresUserVerification === true
      && error?.recoveryKind === 'side_effect_outcome_unknown'
      && !Object.hasOwn(error, 'sideEffectExecution'),
  )
  assert.equal(writeExecutions, 1)
  assert.equal(readExecutions, 0)
  assert.equal(modelCalls, 1)

  const blocked = await readSubagentRun({ userId, id: runId })
  assert.equal(blocked.status, 'needs_verification')
  assert.equal(blocked.runId, runId)
  assert.equal(blocked.toolCallId, toolCallId)
  assert.equal(blocked.requiresUserVerification, true)
  assert.equal(blocked.recoveryKind, 'side_effect_outcome_unknown')
  const publicBlocked = JSON.stringify(blocked)
  assert.doesNotMatch(publicBlocked, new RegExp(secretContent))
  assert.doesNotMatch(publicBlocked, /sideEffectExecution|outcomeJson|ownerId|owner_id|audit|note/u)

  await assert.rejects(
    runSubagent({ ...options, resumeBlocked: true }),
    (error) => error?.code === 'SUBAGENT_SIDE_EFFECT_NEEDS_VERIFICATION',
  )
  assert.equal(writeExecutions, 1, 'an unresolved unknown side effect must never be replayed')
  assert.equal(readExecutions, 0)
  assert.equal(modelCalls, 1, 'an unresolved unknown side effect must block before another model call')

  const ledgerRow = getDb().prepare(`
    SELECT scope_key, status
    FROM side_effect_executions
    WHERE owner_id = ? AND job_id = ? AND step_id = ? AND tool_call_id = ?
  `).get(userId, runId, runId, toolCallId)
  assert.equal(ledgerRow.status, 'unknown')
  resolveUnknownSideEffect({
    userId,
    scopeKey: ledgerRow.scope_key,
    toolCallId,
    verificationConfirmed: true,
    confirmToolCallId: toolCallId,
    resolution: 'committed',
    db: getDb(),
  })

  const resumed = await runSubagent({ ...options, resumeBlocked: true })
  assert.equal(resumed.status, 'completed', JSON.stringify({
    resultText: resumed.resultText,
    trace: resumed.trace,
    modelCalls,
    writeExecutions,
    readExecutions,
    resumedMessages,
  }))
  assert.equal(resumed.resultText, 'resumed and completed')
  assert.equal(writeExecutions, 1, 'a manually resolved side effect must be replayed from the ledger')
  assert.equal(readExecutions, 1, 'the resumed mutation must still be verified read-only')
  assert.equal(modelCalls, 3)
  assert.ok(resumedMessages.some((message) => (
    message.role === 'tool'
    && message.tool_call_id === toolCallId
    && String(message.content).includes('SIDE_EFFECT_USER_CONFIRMED_COMMITTED')
  )))
})

test('ordinary failed subagent runs cannot be reopened by blocked-resume intent', async () => {
  const runId = `subagent-failed-${Date.now()}-${Math.random()}`
  const prompt = 'fail normally'
  await assert.rejects(
    runSubagent({
      id: runId,
      userId,
      type: 'general',
      prompt,
      callModel: async () => { throw new Error('ordinary failure') },
    }),
    /ordinary failure/,
  )
  assert.equal((await readSubagentRun({ userId, id: runId })).status, 'failed')

  let resumedModelCalls = 0
  const unchanged = await runSubagent({
    id: runId,
    userId,
    type: 'general',
    prompt,
    resumeBlocked: true,
    callModel: async () => {
      resumedModelCalls += 1
      return { content: 'must not run', toolCalls: [] }
    },
  })
  assert.equal(unchanged.status, 'failed')
  assert.equal(resumedModelCalls, 0)
})
