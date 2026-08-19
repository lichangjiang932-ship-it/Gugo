import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildModelProviderRequest,
  parseModelProviderResponse,
  streamOpenAICompatible,
} from '../server/adapters/modelProxy.js'
import {
  consumeNativeProviderStreamPayload,
  createNativeProviderStreamState,
  extractNativeProviderUsage,
} from '../server/adapters/nativeModelProviders.js'
import { resolveEndpointProfile } from '../server/utils/endpointProfile.js'

const TOOL = {
  type: 'function',
  function: {
    name: 'read_report',
    description: 'Read a report',
    parameters: { type: 'object', properties: { section: { type: 'string' } } },
  },
}

const PDF_MESSAGE = {
  role: 'user',
  content: [
    { type: 'text', text: 'Summarize this report.' },
    {
      type: 'yma_pdf',
      filename: 'report.pdf',
      file_data: 'data:application/pdf;base64,JVBERi0xLjQ=',
      fallback_text: 'local fallback',
    },
  ],
}

test('native stream preserves max-token truncation after a partial tool call', () => {
  const state = createNativeProviderStreamState('anthropic')
  consumeNativeProviderStreamPayload({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'partial', name: 'write_file' },
  }, state)
  consumeNativeProviderStreamPayload({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"path":"result' },
  }, state)
  consumeNativeProviderStreamPayload({
    type: 'message_delta',
    delta: { stop_reason: 'max_tokens' },
  }, state)
  const events = consumeNativeProviderStreamPayload({ type: 'message_stop' }, state)

  assert.equal(events[0].type, 'tool_calls')
  assert.equal(events[0].finishReason, 'length')
})

test('Anthropic 原生请求转换 system、PDF 与工具 schema', () => {
  const config = {
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'anthropic-key',
    modelName: 'claude-sonnet-4-5',
    temperature: 0.2,
    maxTokens: 0,
  }
  const profile = resolveEndpointProfile({ baseUrl: config.baseUrl, modelName: config.modelName, env: {} })
  const request = buildModelProviderRequest({
    config,
    profile,
    messages: [{ role: 'system', content: 'Be concise.' }, PDF_MESSAGE],
    tools: [TOOL],
    toolChoice: 'auto',
  })
  const body = JSON.parse(request.init.body)

  assert.equal(request.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(request.init.headers['x-api-key'], 'anthropic-key')
  assert.equal(body.system, 'Be concise.')
  assert.equal(body.max_tokens, 8192)
  assert.equal(body.messages[0].content[1].type, 'document')
  assert.equal(body.messages[0].content[1].source.media_type, 'application/pdf')
  assert.deepEqual(body.tools[0].input_schema, TOOL.function.parameters)
})

test('Anthropic 响应归一化文本、工具调用与缓存 usage', () => {
  const profile = { kind: 'anthropic' }
  const parsed = parseModelProviderResponse({
    content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_report', input: { section: 'summary' } },
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 100,
      output_tokens: 12,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 30,
    },
  }, profile)

  assert.equal(parsed.content, 'Checking.')
  assert.equal(parsed.toolCalls[0].id, 'toolu_1')
  assert.equal(parsed.toolCalls[0].function.arguments, '{"section":"summary"}')
  assert.equal(parsed.usage.promptTokens, 170)
  assert.equal(parsed.usage.cacheHitTokens, 40)
  assert.equal(parsed.usage.cacheCreationTokens, 30)
  assert.equal(parsed.usage.uncachedInputTokens, 100)
  assert.equal(parsed.usage.cacheMissTokens, 130)
  assert.equal(parsed.usage.totalTokens, 182)
  assert.equal(parsed.finishReason, 'tool_calls')
})

test('native usage rejects missing prompt counts but keeps a real zero', () => {
  for (const usage of [
    {},
    { input_tokens: null, output_tokens: 2 },
    { input_tokens: '', output_tokens: 2 },
    { input_tokens: false, output_tokens: 2 },
  ]) assert.equal(extractNativeProviderUsage({ usage }, 'anthropic'), null)
  for (const usageMetadata of [
    {},
    { promptTokenCount: null, candidatesTokenCount: 2 },
    { promptTokenCount: '', candidatesTokenCount: 2 },
    { promptTokenCount: false, candidatesTokenCount: 2 },
  ]) assert.equal(extractNativeProviderUsage({ usageMetadata }, 'gemini'), null)

  assert.equal(extractNativeProviderUsage({
    usage: { input_tokens: 0, output_tokens: 2 },
  }, 'anthropic').promptTokens, 0)
  assert.equal(extractNativeProviderUsage({
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 2 },
  }, 'gemini').promptTokens, 0)
})

test('Gemini 原生请求转换 PDF、工具声明与指定工具选择', () => {
  const config = {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'gemini-key',
    modelName: 'gemini-2.5-pro',
    temperature: 0.3,
    maxTokens: 4096,
  }
  const profile = resolveEndpointProfile({ baseUrl: config.baseUrl, modelName: config.modelName, env: {} })
  const request = buildModelProviderRequest({
    config,
    profile,
    messages: [{ role: 'system', content: 'Be precise.' }, PDF_MESSAGE],
    tools: [TOOL],
    toolChoice: { type: 'function', function: { name: 'read_report' } },
  })
  const body = JSON.parse(request.init.body)

  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent')
  assert.equal(request.init.headers['x-goog-api-key'], 'gemini-key')
  assert.equal(body.systemInstruction.parts[0].text, 'Be precise.')
  assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'application/pdf')
  assert.equal(body.generationConfig.maxOutputTokens, 4096)
  assert.equal(body.tools[0].functionDeclarations[0].name, 'read_report')
  assert.deepEqual(body.toolConfig.functionCallingConfig.allowedFunctionNames, ['read_report'])
})

test('Gemini 官方裸域名自动补 v1beta', () => {
  const config = {
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'x',
    modelName: 'gemini-2.5-flash',
  }
  const profile = resolveEndpointProfile({ baseUrl: config.baseUrl, modelName: config.modelName, env: {} })
  const request = buildModelProviderRequest({
    config,
    profile,
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent')
})

test('native providers reject tool turns when function calling is unsupported', () => {
  for (const provider of [
    {
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      modelName: 'claude-without-tools',
    },
    {
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelName: 'gemini-without-tools',
    },
  ]) {
    assert.throws(
      () => buildModelProviderRequest({
        config: { baseUrl: provider.baseUrl, modelName: provider.modelName },
        profile: { kind: provider.kind, supportsTools: false },
        messages: [{ role: 'user', content: 'Read the report.' }],
        tools: [TOOL],
        toolChoice: 'required',
      }),
      (error) => {
        assert.equal(error?.code, 'MODEL_TOOLS_UNSUPPORTED')
        assert.equal(error?.type, 'configuration_error')
        assert.equal(error?.retryable, false)
        assert.match(error?.message || '', /function calling/)
        return true
      },
      provider.kind,
    )
  }
})

test('Gemini 响应归一化正文、函数调用与 usage', () => {
  const parsed = parseModelProviderResponse({
    candidates: [{
      content: { parts: [{ text: 'Done.' }, { functionCall: { id: 'g1', name: 'read_report', args: { section: 'all' } } }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25, cachedContentTokenCount: 4 },
  }, { kind: 'gemini' })

  assert.equal(parsed.content, 'Done.')
  assert.equal(parsed.toolCalls[0].function.name, 'read_report')
  assert.equal(parsed.usage.totalTokens, 25)
  assert.equal(parsed.usage.cacheHitTokens, 4)
})

test('native providers preserve structured tool results and approval authorization', () => {
  const approvalAuthorization = {
    approvalId: 'approval-1',
    scope: 'workspace',
    grantedAt: '2026-08-04T00:00:00.000Z',
  }
  const toolResult = { ok: true, rows: [{ id: 1 }], approvalAuthorization }
  const assistant = {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'call-1',
      type: 'function',
      function: { name: 'read_report', arguments: '{}' },
    }],
  }
  const tool = { role: 'tool', tool_call_id: 'call-1', name: 'read_report', content: toolResult }

  const anthropic = JSON.parse(buildModelProviderRequest({
    config: { baseUrl: 'https://api.anthropic.com', modelName: 'claude-sonnet-4-5' },
    profile: resolveEndpointProfile({ baseUrl: 'https://api.anthropic.com', modelName: 'claude-sonnet-4-5', env: {} }),
    messages: [assistant, tool],
  }).init.body)
  const anthropicResult = anthropic.messages[1].content.find((part) => part.type === 'tool_result')
  assert.deepEqual(JSON.parse(anthropicResult.content), toolResult)

  const gemini = JSON.parse(buildModelProviderRequest({
    config: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelName: 'gemini-2.5-pro' },
    profile: resolveEndpointProfile({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelName: 'gemini-2.5-pro', env: {} }),
    messages: [assistant, { ...tool, content: JSON.stringify(toolResult) }],
  }).init.body)
  const geminiResult = gemini.contents[1].parts.find((part) => part.functionResponse)
  assert.deepEqual(geminiResult.functionResponse.response, toolResult)
})

test('Anthropic SSE 转成统一文本、usage 与 finish 事件', async () => {
  const frames = [
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 8,
          output_tokens: 0,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 4,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  const events = []
  for await (const event of streamOpenAICompatible({
    config: { baseUrl: 'https://api.anthropic.com', apiKey: 'x', modelName: 'claude-sonnet-4-5' },
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => new Response(body, { status: 200 }),
    env: {},
  })) events.push(event)

  assert.equal(events.find((event) => event.type === 'text')?.delta, 'Hello')
  assert.equal(events.at(-1).type, 'finish')
  assert.equal(events.at(-1).usage.promptTokens, 32)
  assert.equal(events.at(-1).usage.completionTokens, 2)
  assert.equal(events.at(-1).usage.cacheHitTokens, 20)
  assert.equal(events.at(-1).usage.cacheCreationTokens, 4)
  assert.equal(events.at(-1).usage.cacheMissTokens, 12)
  assert.equal(events.at(-1).usage.totalTokens, 34)
})

test('Gemini SSE 转成统一工具调用事件', async () => {
  const frame = {
    candidates: [{
      content: { parts: [{ functionCall: { id: 'g-call', name: 'read_report', args: { section: 'summary' } } }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
  }
  const events = []
  for await (const event of streamOpenAICompatible({
    config: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'x', modelName: 'gemini-2.5-pro' },
    messages: [{ role: 'user', content: 'hi' }],
    tools: [TOOL],
    fetchImpl: async () => new Response(`data: ${JSON.stringify(frame)}\n\n`, { status: 200 }),
    env: {},
  })) events.push(event)

  const complete = events.find((event) => event.type === 'tool_calls')
  assert.equal(complete.toolCalls[0].id, 'g-call')
  assert.equal(complete.toolCalls[0].function.name, 'read_report')
  assert.equal(complete.usage.totalTokens, 13)
})

test('streaming request falls back to non-stream upstream while preserving stream events', async () => {
  let outboundBody = null
  const events = []
  for await (const event of streamOpenAICompatible({
    config: {
      baseUrl: 'https://example.test/v1',
      modelName: 'non-stream-model',
      profileOverrides: { supportsStreaming: false },
    },
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async (_url, init) => {
      outboundBody = JSON.parse(init.body)
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'complete response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }), { status: 200 })
    },
    env: {},
  })) events.push(event)

  assert.equal(outboundBody.stream, false)
  assert.equal(Object.hasOwn(outboundBody, 'stream_options'), false)
  assert.deepEqual(events.map((event) => event.type), ['usage', 'text', 'finish'])
  assert.equal(events[1].delta, 'complete response')
  assert.equal(events[2].usage.totalTokens, 5)
})

test('non-stream tool response is adapted to ready and terminal tool events', async () => {
  const toolCall = {
    id: 'call-non-stream',
    type: 'function',
    function: { name: 'read_report', arguments: '{"section":"summary"}' },
  }
  const events = []
  for await (const event of streamOpenAICompatible({
    config: {
      baseUrl: 'https://example.test/v1',
      modelName: 'non-stream-tools',
      profileOverrides: { supportsStreaming: false },
    },
    messages: [{ role: 'user', content: 'read it' }],
    tools: [TOOL],
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '', tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
    }), { status: 200 }),
    env: {},
  })) events.push(event)

  assert.deepEqual(events.map((event) => event.type), ['tool_call_ready', 'tool_calls'])
  assert.deepEqual(events[0].toolCall, toolCall)
  assert.deepEqual(events[1].toolCalls, [toolCall])
})

test('non-stream fallback remains cancellable while awaiting the upstream body', async () => {
  const controller = new AbortController()
  const stream = streamOpenAICompatible({
    config: {
      baseUrl: 'https://example.test/v1',
      modelName: 'non-stream-slow-body',
      profileOverrides: { supportsStreaming: false },
    },
    messages: [{ role: 'user', content: 'hi' }],
    externalSignal: controller.signal,
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('cancelled')
          error.name = 'AbortError'
          reject(error)
        }
        if (init.signal.aborted) rejectAbort()
        else init.signal.addEventListener('abort', rejectAbort, { once: true })
      }),
    }),
    env: {},
  })
  const pending = stream.next()

  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, (error) => error?.name === 'AbortError')
})
