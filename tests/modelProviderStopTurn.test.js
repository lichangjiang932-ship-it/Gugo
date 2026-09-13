import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { callBackgroundModelWithTools } from '../server/adapters/modelInvocationRuntime.js'
import { createUser } from '../server/db.js'
import { TurnEngine } from '../server/services/TurnEngine.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { grantLocalPath } from '../server/services/localFileAccessService.js'
import { setApprovalMode } from '../server/services/approvalSettingsStore.js'
import { getTurnCheckpoint } from '../server/services/turnCheckpointStore.js'
import { listTurnEvents } from '../server/services/turnEventStore.js'
import { listMessages, upsertSession } from '../server/services/sessionStore.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopRuntime.js'
import { projectTurnEventForClient } from '../shared/turnEventProjection.js'
import { normalizeTurnFailurePayload } from '../src/lib/turnClient/turnFailurePayload.js'
import { buildIncompleteTaskPresentation } from '../src/pages/ChatSplit/chatMessages/messageRow/incompleteTaskPresentation.js'
import { createTestTurnEnginePersistence } from './helpers/turnEnginePersistence.js'
import { activateTestCompactionArchivePort } from './helpers/testCompactionArchivePort.js'

const archive = activateTestCompactionArchivePort({ source: 'test.provider-stop-turn' })
test.after(() => archive.release())
const userId = 'provider-stop-turn-user'
createUser({ id: userId, email: 'provider-stop-turn@example.com' })
setApprovalMode({ userId, mode: 'normal' })
const fixtureDirectory = process.env.YMA_TEST_DEFAULT_OUTPUT_DIR
grantLocalPath({ userId, rootPath: fixtureDirectory, accessMode: 'read_only' })
const readPath = path.join(fixtureDirectory, 'fixture.txt')
const toolSpecs = SERVER_TOOL_SPECS.filter((tool) => ['read_file', 'write_file'].includes(tool.function.name))
const EXPLANATION = '无法继续这项请求，但先前已完成的读取仍然保留。'
const API_KEY = 'opaque-provider-diagnostic-fixture-key'
const env = { MODEL_BASE_URL: 'https://provider-stop.example.invalid/v1', MODEL_NAME: 'provider-stop-fixture', MODEL_API_KEY: API_KEY }

function response(content, toolCalls, finishReason) {
  return { choices: [{ message: { content, tool_calls: toolCalls }, finish_reason: finishReason }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }
}

function call(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

for (const hasPriorTool of [false, true]) {
  test(`compatible refusal ${hasPriorTool ? 'after completed work' : 'on the first call'} keeps a durable non-retryable Turn failure`, async () => {
    const scope = { userId, sessionId: `provider-stop-session-${hasPriorTool}`, turnId: `provider-stop-turn-${hasPriorTool}` }
    upsertSession({ id: scope.sessionId, userId, title: 'Provider stop diagnostic' })
    let providerCalls = 0
    const executedTools = []
    const retryEvents = []
    const engine = new TurnEngine({
      persistence: createTestTurnEnginePersistence(),
      runLoop: runToolLoop,
      toolSpecs,
      resolveToolSpecs: async () => toolSpecs,
      preparePromptContext: () => ({ messages: [], skillIds: [], memoryIds: [] }),
      resolveModelBinding: () => ({ providerId: null, modelName: env.MODEL_NAME, configRevision: null, env }),
      getContextWindow: () => 128_000,
      scheduleMemoryExtraction: () => assert.fail('a rejected turn must not call a memory model'),
      runModel: (request) => callBackgroundModelWithTools({
        ...request, env, userId: null,
        fetchImpl: async (_url, init) => {
          providerCalls += 1
          assert.equal(JSON.parse(init.body).stream, false)
          const data = hasPriorTool && providerCalls === 1
            ? response('Previously inspected the authorized fixture.', [call('prior-read', 'read_file', { path: readPath })], 'tool_calls')
            : response(`<think>PRIVATE_STOP_THOUGHT</think>${EXPLANATION} ${API_KEY}`, [
                call('never-execute', 'write_file', { path: 'never.txt', content: 'PRIVATE_REJECTED_TOOL_BODY' }),
              ], 'content_filter')
          return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
        },
        onRetry: (event) => retryEvents.push(event),
      }),
      executeTool: async ({ name, args }) => {
        executedTools.push({ name, args })
        assert.equal(name, 'read_file', 'the rejected provider tool batch must never dispatch')
        return { ok: true, content: 'PERSISTED_READ_RESULT', data: 'PERSISTED_READ_RESULT' }
      },
    })

    await engine.startTurn({ ...scope, content: `Read ${readPath} and explain its contents.` })
    await engine.waitForTurn(scope)
    const events = listTurnEvents({ ...scope, limit: 2000 })
    const terminal = events.at(-1)
    assert.equal(terminal.type, 'turn.failed', JSON.stringify(terminal.payload))
    assert.equal(terminal.payload.code, 'MODEL_PROVIDER_STOP_REASON_ERROR')
    assert.equal(terminal.payload.error.retryable, false)
    assert.equal(terminal.payload.error.reason, `${EXPLANATION} [REDACTED]`)
    assert.equal(providerCalls, hasPriorTool ? 2 : 1)
    assert.equal(executedTools.length, hasPriorTool ? 1 : 0)
    assert.deepEqual(retryEvents, [])
    assert.equal(events.some((event) => ['turn.completed', 'turn.interrupted', 'model.failover'].includes(event.type)), false)
    const checkpoint = getTurnCheckpoint(scope).state
    assert.equal(checkpoint.modelInvocation.status, 'failed')
    assert.equal(checkpoint.modelInvocation.response, undefined)
    if (hasPriorTool) {
      assert.ok(checkpoint.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'prior-read'))
      assert.match(JSON.stringify(checkpoint.messages), /PERSISTED_READ_RESULT/)
      assert.ok(events.some((event) => event.type === 'tool.completed'))
    }
    const storedMessage = listMessages({ userId, sessionId: scope.sessionId })
      .find((message) => message.id === `${scope.turnId}:assistant`)
    assert.equal(storedMessage.modelContext.evidenceState, 'failed')
    assert.equal(storedMessage.modelContext.error.reason, terminal.payload.error.reason)
    const clientEvent = projectTurnEventForClient(terminal)
    const clientFailure = normalizeTurnFailurePayload(clientEvent.payload)
    const presentation = buildIncompleteTaskPresentation({ meta: { failed: true, serverFailure: clientFailure.error } }, (key) => key)
    assert.equal(presentation.reason, terminal.payload.error.reason)
    assert.equal(presentation.retryable, false)
    assert.doesNotMatch(JSON.stringify(clientEvent), /PRIVATE_STOP_THOUGHT|PRIVATE_REJECTED_TOOL_BODY|opaque-provider-diagnostic-fixture-key/)
    await engine.resumeTurn(scope)
    assert.equal(providerCalls, hasPriorTool ? 2 : 1, 'an ordinary resume must not replay a rejected request')
    assert.equal(executedTools.length, hasPriorTool ? 1 : 0)
  })
}
