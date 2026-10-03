import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildModelProviderRequest } from '../server/adapters/modelRequestBuilder.js'
import { parseModelProviderResponse } from '../server/adapters/modelProviderResponse.js'
import { snapshotModelResponse } from '../server/services/loop/modelInvocationCheckpoint.js'
import { buildAssistantToolCallsMessage, normalizeToolCalls } from '../server/utils/toolCallHarness.js'
import { callBackgroundModel, callBackgroundModelWithTools, callStreamingModelWithTools } from '../server/adapters/modelInvocationRuntime.js'
import { runToolLoop } from '../server/services/loop/index.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopRuntime.js'
import { synchronizeCheckpointToolCallMessages } from '../server/services/loop/runtimeState.js'
import { consumeNativeProviderStreamPayload, createNativeProviderStreamState } from '../server/adapters/nativeModelProviders.js'
import { PROVIDER_REPLAY_LIMITS, providerReplayContext } from '../server/adapters/providerReplayState.js'
import { modelAssistantHistoryMessage } from '../server/services/loop/modelAssistantHistory.js'

const CONFIG = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelName: 'gemini-3-pro-preview', providerId: 'fixture-google' }
const PROFILE = { kind: 'gemini', supportsTools: true, supportsVision: true }
const USER = { role: 'user', content: 'Read the fixture file.' }
const PARTS = [
  { text: '', thoughtSignature: 'SIGNED_EMPTY_TEXT' },
  { functionCall: { id: 'native-call-1', name: 'read_file', args: { path: 'fixture.txt' } }, thoughtSignature: 'SIGNED_TOOL_CALL' },
]

function parse(parts = PARTS) {
  const providerRequest = buildModelProviderRequest({ config: CONFIG, profile: PROFILE, messages: [USER] })
  return parseModelProviderResponse({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] }, PROFILE, { providerRequest })
}

function replay(response, config = CONFIG, profile = PROFILE) {
  const assistant = buildAssistantToolCallsMessage(normalizeToolCalls(response.toolCalls), response.content, { providerReplay: response.providerReplay })
  const messages = [USER, assistant, { role: 'tool', tool_call_id: response.toolCalls[0].id, content: 'fixture content' }]
  const original = structuredClone(messages)
  const body = JSON.parse(buildModelProviderRequest({ config, profile, messages }).init.body)
  assert.deepEqual(messages, original)
  return body
}

test('Gemini native part signatures and call ids survive parsing, checkpoint snapshots and replay', () => {
  const parsed = parse()
  assert.ok(parsed.providerReplay)
  const snapshot = snapshotModelResponse(parsed)
  assert.deepEqual(snapshot.providerReplay, parsed.providerReplay)
  const body = replay(snapshot)
  assert.deepEqual(body.contents.find((message) => message.role === 'model').parts, PARTS)
  const response = body.contents.flatMap((message) => message.parts).find((part) => part.functionResponse)?.functionResponse
  assert.equal(response.id, 'native-call-1')
  assert.equal(response.name, 'read_file')
})

test('provider-native replay state is excluded on a changed provider, endpoint or model', () => {
  const parsed = parse()
  assert.ok(parsed.providerReplay)
  for (const config of [
    { ...CONFIG, modelName: 'different-model' },
    { ...CONFIG, providerId: 'different-provider' },
    { ...CONFIG, baseUrl: 'https://different-provider.invalid/v1beta' },
    { ...CONFIG, baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-4.1' },
  ]) {
    const profile = config.baseUrl.includes('api.openai.com') ? { ...PROFILE, kind: 'openai-compatible' } : PROFILE
    const text = JSON.stringify(replay(parsed, config, profile))
    assert.equal(text.includes('SIGNED_EMPTY_TEXT'), false)
    assert.equal(text.includes('SIGNED_TOOL_CALL'), false)
  }
})

test('missing signatures are never fabricated and oversized or malformed metadata fails closed', () => {
  const unsigned = parse([{ functionCall: { name: 'read_file', args: { path: 'fixture.txt' } } }])
  assert.equal(unsigned.providerReplay, undefined)
  assert.equal(JSON.stringify(replay(unsigned)).includes('thoughtSignature'), false)
  for (const thoughtSignature of [{ valueOf: 'not a signature' }, 'x'.repeat(600_000)]) {
    assert.throws(() => parse([{ functionCall: { name: 'read_file', args: {} }, thoughtSignature }]),
      (error) => error.code === 'MODEL_PROVIDER_REPLAY_INVALID' && error.retryable === false)
  }
})

test('signed canonical call mutations fail closed instead of replaying different arguments', () => {
  const parsed = parse()
  parsed.toolCalls[0].function.arguments = JSON.stringify({ path: 'different.txt' })
  assert.throws(() => replay(parsed), (error) => error.code === 'MODEL_PROVIDER_REPLAY_INVALID')
})

function nativeToolLoopFixture({ firstParts = PARTS, laterParts = [{ text: 'The fixture file was read.' }], firstFinishReason = 'STOP', user = USER, frames = null } = {}) {
  const requests = []
  const errors = []
  const env = { MODEL_BASE_URL: CONFIG.baseUrl, MODEL_NAME: CONFIG.modelName, MODEL_API_KEY: 'offline-fixture-only' }
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)
    const frame = frames?.[requests.length - 1]
    const parts = frame?.parts || (requests.length === 1 ? firstParts : laterParts)
    const finishReason = frame?.finishReason || (requests.length === 1 ? firstFinishReason : 'STOP')
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason }] })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
  }
  let executions = 0
  const executionArgs = []
  const options = {
    job: { id: 'gemini-replay-loop', userId: 'gemini-replay-fixture-user', origin: 'chat', prompt: user.content, userPrompt: user.content },
    step: { id: 'gemini-replay-step', kind: 'chat' },
    messages: [user],
    toolSpecs: [SERVER_TOOL_SPECS.find((tool) => tool.function.name === 'read_file')],
    fallbackToolSpecs: [], intentMode: 'auto', maxIters: 5, enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'fixture-only-approval' }),
    runModel: async (request) => {
      try {
        return await callStreamingModelWithTools({ ...request, userId: null, usageOwnerId: 'gemini-replay-fixture-user', env, fetchImpl })
      } catch (error) {
        errors.push(`${error.code}: ${error.message}`)
        throw error
      }
    },
    executeTool: async ({ args }) => {
      executions += 1
      executionArgs.push(structuredClone(args))
      return { ok: true, content: 'fixture content' }
    },
  }
  return { options, requests, errors, executionArgs, executions: () => executions }
}

function assertNativeLoopReplay(fixture) {
  assert.equal(fixture.requests.length, 2)
  assert.equal(fixture.executions(), 1)
  assert.deepEqual(fixture.requests[1].contents.find((message) => message.role === 'model').parts, PARTS)
  const response = fixture.requests[1].contents.flatMap((message) => message.parts).find((part) => part.functionResponse)?.functionResponse
  assert.equal(response.id, 'native-call-1')
  assert.deepEqual(response.response.runtimeArguments.arguments, fixture.executionArgs[0])
}

test('the live streamed tool loop replays native signatures without any real provider call', async () => {
  const fixture = nativeToolLoopFixture()
  const result = await runToolLoop(fixture.options)
  assert.equal(result.text, 'The fixture file was read.', fixture.errors.join('\n'))
  assert.notEqual(result.incomplete, true)
  assertNativeLoopReplay(fixture)
})

test('a completed provider response checkpoint resumes with its opaque state and no duplicate request', async () => {
  const fixture = nativeToolLoopFixture()
  const controller = new AbortController()
  let checkpoint
  await assert.rejects(() => runToolLoop({
    ...fixture.options,
    signal: controller.signal,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      if (state.modelInvocation?.status === 'completed') controller.abort()
      return true
    },
  }), (error) => error.name === 'AbortError')
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.executions(), 0)
  assert.ok(checkpoint.modelInvocation.response.providerReplay)
  const original = structuredClone(checkpoint)
  const result = await runToolLoop({ ...fixture.options, loadCheckpoint: async () => structuredClone(checkpoint) })
  assert.equal(result.text, 'The fixture file was read.', fixture.errors.join('\n'))
  assertNativeLoopReplay(fixture)
  assert.deepEqual(checkpoint, original)
})

test('checkpoint execution defaults and explicit approval edits never rewrite the signed model call', async () => {
  const fixture = nativeToolLoopFixture()
  const approvedArgs = { path: 'approved-fixture.txt', offset: 4, limit: 2 }
  fixture.options.requestToolApproval = async () => ({ proceed: true, args: approvedArgs, approvalId: 'fixture-only-approval' })
  const result = await runToolLoop(fixture.options)
  assert.equal(result.text, 'The fixture file was read.', fixture.errors.join('\n'))
  assert.deepEqual(fixture.executionArgs, [approvedArgs])
  assertNativeLoopReplay(fixture)

  const parsed = parse()
  const assistant = buildAssistantToolCallsMessage(normalizeToolCalls(parsed.toolCalls), parsed.content, { providerReplay: parsed.providerReplay })
  const original = structuredClone(assistant)
  const synchronized = synchronizeCheckpointToolCallMessages([assistant], [{ id: 'native-call-1', argumentsText: JSON.stringify(approvedArgs) }])
  assert.deepEqual(synchronized, [original])
  assert.deepEqual(assistant, original)
})

test('streamed signed text and multiple function calls retain distinct native and synthesized ids', () => {
  const state = createNativeProviderStreamState('gemini', null, providerReplayContext({ config: CONFIG, profile: PROFILE }))
  const chunks = [
    [{ text: 'Private fixture thought.', thought: true, thoughtSignature: 'SYNTHETIC_THOUGHT' }],
    [{ text: '', thoughtSignature: 'SYNTHETIC_EMPTY' }],
    [{ functionCall: { name: 'read_file', args: { path: 'first.txt' } }, thoughtSignature: 'SYNTHETIC_FIRST' }],
    [{ functionCall: { id: 'native-second', name: 'read_file', args: { path: 'second.txt' } }, thoughtSignature: 'SYNTHETIC_SECOND' }],
    [{ functionCall: { name: 'read_file', args: { path: 'third.txt' } }, thoughtSignature: 'SYNTHETIC_THIRD' }],
  ]
  const events = chunks.flatMap((parts, index) => consumeNativeProviderStreamPayload({
    candidates: [{ content: { role: 'model', parts }, ...(index === chunks.length - 1 ? { finishReason: 'STOP' } : {}) }],
  }, state))
  const terminal = events.find((event) => event.type === 'tool_calls')
  assert.deepEqual(terminal.toolCalls.map((call) => call.id), ['tool-0-read_file', 'native-second', 'tool-2-read_file'])
  const assistant = buildAssistantToolCallsMessage(normalizeToolCalls(terminal.toolCalls), '', { providerReplay: terminal.providerReplay })
  const messages = [USER, assistant, ...terminal.toolCalls.map((call) => ({ role: 'tool', tool_call_id: call.id, content: 'fixture content' }))]
  const body = JSON.parse(buildModelProviderRequest({ config: CONFIG, profile: PROFILE, messages }).init.body)
  assert.deepEqual(body.contents.find((entry) => entry.role === 'model').parts, chunks.flat())
  assert.deepEqual(body.contents.flatMap((entry) => entry.parts).filter((part) => part.functionResponse).map((part) => part.functionResponse.id),
    [undefined, 'native-second', undefined])
})

test('oversized, recursive and late-signed overflowing stream metadata is rejected', () => {
  const invalidReplay = (error) => error.code === 'MODEL_PROVIDER_REPLAY_INVALID' && error.retryable === false
  assert.throws(() => parse(Array.from({ length: PROVIDER_REPLAY_LIMITS.parts + 1 }, () => ({ text: '', thoughtSignature: 'FIXTURE' }))), invalidReplay)
  const recursive = {}
  recursive.self = recursive
  assert.throws(() => parse([{ functionCall: { name: 'fixture', args: recursive }, thoughtSignature: 'FIXTURE' }]), invalidReplay)
  const state = createNativeProviderStreamState('gemini', null, providerReplayContext({ config: CONFIG, profile: PROFILE }))
  consumeNativeProviderStreamPayload({ candidates: [{ content: { parts: [{ text: 'a'.repeat(PROVIDER_REPLAY_LIMITS.bytes + 1) }] } }] }, state)
  assert.throws(() => consumeNativeProviderStreamPayload({ candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'FIXTURE' }] }, finishReason: 'STOP' }] }, state), invalidReplay)
})

test('text-only signed history survives bounded continuation while the displayed answer is joined once', async () => {
  const firstParts = [{ text: 'First sentence. ', thoughtSignature: 'SYNTHETIC_PREFIX' }]
  const laterParts = [{ text: 'Second sentence.', thoughtSignature: 'SYNTHETIC_FINAL' }]
  const fixture = nativeToolLoopFixture({ firstParts, laterParts, firstFinishReason: 'MAX_TOKENS', user: { role: 'user', content: 'Tell a short story.' } })
  let checkpoint
  const result = await runToolLoop({ ...fixture.options, saveCheckpoint: async (state) => { checkpoint = structuredClone(state); return true } })
  assert.equal(result.text, 'First sentence. Second sentence.', fixture.errors.join('\n'))
  assert.equal(fixture.executions(), 0)
  assert.equal(fixture.requests.length, 2)
  assert.deepEqual(fixture.requests[1].contents.find((entry) => entry.role === 'model').parts, firstParts)
  const signed = checkpoint.messages.filter((message) => message.providerReplay)
  assert.deepEqual(signed.map((message) => message.content), ['First sentence. ', 'Second sentence.'])
  assert.deepEqual(signed[1].providerReplay.parts, laterParts)
})

test('completion deferred for steering also preserves the text signature in durable history', async () => {
  const firstParts = [{ text: 'Hello.', thoughtSignature: 'SYNTHETIC_STEERING' }]
  const fixture = nativeToolLoopFixture({ firstParts, laterParts: [{ text: 'Follow-up complete.' }], user: { role: 'user', content: 'Say hello.' } })
  let attempts = 0
  const result = await runToolLoop({ ...fixture.options, beforeFinalCompletion: async () => ++attempts > 1 })
  assert.equal(result.text, 'Follow-up complete.', fixture.errors.join('\n'))
  assert.deepEqual(fixture.requests[1].contents.find((entry) => entry.role === 'model').parts, firstParts)
})

test('native thought cannot escape through an unbound reasoning_content field when changing provider', async () => {
  const firstParts = [{ text: 'SYNTHETIC_PRIVATE_THOUGHT', thought: true, thoughtSignature: 'SYNTHETIC_THOUGHT_SIGNATURE' }, ...PARTS]
  const fixture = nativeToolLoopFixture({ firstParts })
  let checkpoint
  await runToolLoop({ ...fixture.options, saveCheckpoint: async (state) => { checkpoint = structuredClone(state); return true } })
  const nativeAssistant = checkpoint.messages.find((message) => message.providerReplay)
  assert.equal(nativeAssistant.reasoning_content, undefined)
  const legacyAssistant = { ...nativeAssistant, reasoning_content: 'SYNTHETIC_PRIVATE_THOUGHT' }
  const compatibleAssistant = { role: 'assistant', content: 'Earlier compatible answer.', reasoning_content: 'COMPATIBLE_REASONING_RETAINED' }
  const request = buildModelProviderRequest({
    config: { baseUrl: 'https://openai-compatible.fixture/v1', modelName: 'fixture-model', providerId: 'different-provider' },
    profile: { kind: 'openai-compatible', supportsTools: true },
    messages: [USER, legacyAssistant, { role: 'tool', tool_call_id: 'native-call-1', content: 'fixture content' }, compatibleAssistant],
  })
  assert.equal(request.init.body.includes('SYNTHETIC_PRIVATE_THOUGHT'), false)
  assert.equal(request.init.body.includes('SYNTHETIC_THOUGHT_SIGNATURE'), false)
  assert.equal(request.init.body.includes('COMPATIBLE_REASONING_RETAINED'), true)
})

for (const literal of [
  'Literal parser example: </think> keep this whole explanation.',
  'A literal example: <think>this is quoted input</think> remains text.',
  'Example: <tool_call>{"name":"read_file","arguments":{"path":"not-a-command.txt"}}</tool_call>',
]) {
  test(`signed native literal text remains canonical in nonstream and live replay: ${literal.slice(0, 30)}`, async () => {
    const parts = [{ text: literal, thoughtSignature: 'SYNTHETIC_LITERAL_SIGNATURE' }]
    const parsed = parse(parts)
    assert.equal(parsed.content, literal)
    const response = await callBackgroundModelWithTools({
      messages: [USER], tools: [], userId: null,
      env: { MODEL_BASE_URL: CONFIG.baseUrl, MODEL_NAME: CONFIG.modelName, MODEL_API_KEY: 'offline-fixture-only' },
      fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] }), { headers: { 'content-type': 'application/json' } }),
    })
    assert.equal(response.content, literal)
    assert.deepEqual(response.toolCalls, [])
    const history = modelAssistantHistoryMessage(response.content, snapshotModelResponse(response))
    assert.equal(history.content, literal)
    const fixture = nativeToolLoopFixture({ firstParts: parts, laterParts: [{ text: 'Explanation complete.' }], user: { role: 'user', content: 'Explain the parser syntax.' } })
    let gates = 0
    const result = await runToolLoop({ ...fixture.options, beforeFinalCompletion: async () => ++gates > 1 })
    assert.equal(result.text, 'Explanation complete.', fixture.errors.join('\n'))
    assert.equal(fixture.executions(), 0)
    assert.deepEqual(fixture.requests[1].contents.find((entry) => entry.role === 'model').parts, parts)
  })
}

test('per-request summary output limits reach real native stream and nonstream request bodies without changing model configuration', async () => {
  const env = { MODEL_BASE_URL: CONFIG.baseUrl, MODEL_NAME: CONFIG.modelName, MODEL_API_KEY: 'offline-fixture-only', MODEL_MAX_TOKENS: '2048' }
  for (const invoke of [callBackgroundModel, callBackgroundModelWithTools, callStreamingModelWithTools]) {
    let body
    await invoke({
      messages: [USER], tools: [], maxTokens: 256, userId: null, env,
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body)
        const data = { candidates: [{ content: { role: 'model', parts: [{ text: 'Short summary.' }] }, finishReason: 'STOP' }] }
        return invoke === callStreamingModelWithTools
          ? new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
          : new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
      },
    })
    assert.equal(body.generationConfig.maxOutputTokens, 256)
    assert.equal(env.MODEL_MAX_TOKENS, '2048')
  }
})

test('representative-read recovery keeps signed text intact and obtains a real signed model call before accepting a project review', async () => {
  const user = { role: 'user', content: 'Review the fixture project.' }
  const signedAnswer = [{ text: 'I have enough information.', thoughtSignature: 'SYNTHETIC_DIRECTORY_ANSWER' }]
  const signedRead = [{ functionCall: { id: 'real-native-read', name: 'read_file', args: { path: 'C:/fixture/README.md' } }, thoughtSignature: 'SYNTHETIC_DIRECTORY_READ' }]
  const fixture = nativeToolLoopFixture({ user, frames: [
    { parts: signedAnswer }, { parts: signedRead }, { parts: [{ text: 'Project reviewed using its README.' }] },
  ] })
  fixture.options.job.prompt = user.content + '\nPath: C:/fixture\nTool: list_directory\nSucceeded: yes\n'
    + JSON.stringify({ ok: true, path: 'C:/fixture', entries: [{ name: 'README.md', type: 'file' }] })
  const previousCall = { id: 'previous-read', name: 'read_file', args: { path: 'missing-fixture.txt' }, argumentsText: '{"path":"missing-fixture.txt"}', checkpointStatus: 'pending' }
  fixture.options.loadCheckpoint = async () => ({
    messages: [user, buildAssistantToolCallsMessage([previousCall])], toolCalls: [previousCall], iterations: 0,
  })
  const executed = []
  fixture.options.executeTool = async ({ args, toolCallId }) => {
    executed.push({ args, toolCallId })
    return args.path === 'missing-fixture.txt' ? { ok: false, code: 'file_not_found', error: 'fixture missing' }
      : { ok: true, path: args.path, content: 'Fixture project README.' }
  }
  const result = await runToolLoop(fixture.options)
  assert.equal(result.text, 'Project reviewed using its README.', fixture.errors.join('\n'))
  assert.ok(executed.some((call) => call.toolCallId === 'real-native-read'))
  assert.equal(executed.some((call) => call.toolCallId.startsWith('local-project-read-')), false)
  assert.ok(fixture.requests[1].contents.some((entry) => entry.parts.some((part) => part.thoughtSignature === 'SYNTHETIC_DIRECTORY_ANSWER')))
})

test('a native model that ignores the representative-read request stops incomplete at the existing iteration bound', async () => {
  const user = { role: 'user', content: 'Review the fixture project.' }
  const firstParts = [{ text: 'I have enough information.', thoughtSignature: 'SYNTHETIC_UNEVIDENCED_ANSWER' }]
  const fixture = nativeToolLoopFixture({ user, firstParts, laterParts: firstParts })
  fixture.options.maxIters = 3
  fixture.options.job.prompt = user.content + '\nPath: C:/fixture\nTool: list_directory\nSucceeded: yes\n'
    + JSON.stringify({ ok: true, path: 'C:/fixture', entries: [{ name: 'README.md', type: 'file' }] })
  const previous = { id: 'previous-read', name: 'read_file', args: { path: 'missing-fixture.txt' }, argumentsText: '{"path":"missing-fixture.txt"}', checkpointStatus: 'pending' }
  fixture.options.loadCheckpoint = async () => ({ messages: [user, buildAssistantToolCallsMessage([previous])], toolCalls: [previous], iterations: 0 })
  fixture.options.executeTool = async () => ({ ok: false, code: 'file_not_found', error: 'fixture missing' })
  const result = await runToolLoop(fixture.options)
  assert.equal(result.incomplete, true)
  assert.equal(result.code, 'DIRECTORY_REVIEW_EVIDENCE_MISSING')
  assert.equal(fixture.requests.length, 2)
})
