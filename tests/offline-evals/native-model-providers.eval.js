import assert from 'node:assert/strict'

import {
  MODEL_PROVIDER_STOP_REASON_ERROR_CODE,
  buildNativeProviderRequest,
  createNativeProviderStreamState,
  consumeNativeProviderStreamPayload,
  parseNativeProviderResponse,
} from '../../server/adapters/nativeModelProviders.js'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'

const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read one workspace file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
}

function toolRoundMessages() {
  return [
    { role: 'system', content: 'Use workspace evidence before answering.' },
    { role: 'user', content: 'Read package.json and report the package name.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'read-package',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"package.json"}' },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'read-package',
      name: 'read_file',
      content: { ok: true, content: '{"name":"gugo"}' },
    },
  ]
}

const CASES = [
  defineOfflineEvalCase({
    id: 'PROVIDER-01',
    category: 'anthropic-task',
    title: 'an Anthropic tool round preserves system context, tool evidence, schema, and canonical result',
    async run(ctx) {
      const request = buildNativeProviderRequest({
        config: {
          baseUrl: 'https://api.anthropic.com',
          modelName: 'claude-offline-eval',
          apiKey: 'offline-eval-key',
          temperature: 0,
        },
        profile: { kind: 'anthropic', supportsTools: true },
        messages: toolRoundMessages(),
        tools: [READ_FILE_TOOL],
        toolChoice: 'auto',
        stream: false,
      })
      const body = JSON.parse(request.init.body)
      const toolResult = body.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === 'tool_result')
      const parsed = parseNativeProviderResponse({
        content: [{ type: 'text', text: 'The package name is gugo.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 18,
          cache_read_input_tokens: 6,
          output_tokens: 7,
        },
      }, 'anthropic')

      assert.equal(request.url, 'https://api.anthropic.com/v1/messages')
      assert.equal(body.system, 'Use workspace evidence before answering.')
      assert.equal(body.tools[0].name, 'read_file')
      assert.equal(JSON.parse(JSON.parse(toolResult.content).content).name, 'gugo')
      assert.deepEqual(parsed, {
        content: 'The package name is gugo.',
        toolCalls: [],
        usage: {
          promptTokens: 24,
          cacheHitTokens: 6,
          cacheCreationTokens: 0,
          uncachedInputTokens: 18,
          cacheMissTokens: 18,
          completionTokens: 7,
          totalTokens: 31,
        },
        finishReason: 'stop',
      })
      ctx.metric('tool_results_preserved', 1)
      ctx.metric('usage_fields_normalized', Object.keys(parsed.usage).length)
      ctx.metric('task_score', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'PROVIDER-02',
    category: 'gemini-task',
    title: 'a Gemini function task preserves the selected tool and normalizes its streamed call',
    async run(ctx) {
      const request = buildNativeProviderRequest({
        config: {
          baseUrl: 'https://generativelanguage.googleapis.com',
          modelName: 'gemini-offline-eval',
          apiKey: 'offline-eval-key',
          temperature: 0,
        },
        profile: { kind: 'gemini', supportsTools: true },
        messages: [{ role: 'user', content: 'Read package.json.' }],
        tools: [READ_FILE_TOOL],
        toolChoice: { type: 'function', function: { name: 'read_file' } },
        stream: true,
      })
      const body = JSON.parse(request.init.body)
      const state = createNativeProviderStreamState('gemini')
      const events = consumeNativeProviderStreamPayload({
        candidates: [{
          content: {
            parts: [{ functionCall: { id: 'gemini-read', name: 'read_file', args: { path: 'package.json' } } }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
      }, state)
      const ready = events.find((event) => event.type === 'tool_call_ready')
      const terminal = events.find((event) => event.type === 'tool_calls')

      assert.equal(
        request.url,
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-offline-eval:streamGenerateContent?alt=sse',
      )
      assert.deepEqual(
        body.toolConfig.functionCallingConfig.allowedFunctionNames,
        ['read_file'],
      )
      assert.equal(ready.toolCall.function.name, 'read_file')
      assert.equal(ready.toolCall.function.arguments, '{"path":"package.json"}')
      assert.equal(terminal.finishReason, 'tool_calls')
      assert.equal(terminal.usage.totalTokens, 13)
      ctx.metric('canonical_events_emitted', events.length)
      ctx.metric('tool_calls_ready', 1)
      ctx.metric('task_score', 1)
    },
  }),
  defineOfflineEvalCase({
    id: 'PROVIDER-03',
    category: 'provider-boundary',
    title: 'provider refusals and incompatible tool endpoints fail closed with stable diagnostic codes',
    async run(ctx) {
      const failures = []
      try {
        parseNativeProviderResponse({
          candidates: [],
          promptFeedback: { blockReason: 'SAFETY' },
        }, 'gemini')
      } catch (error) {
        failures.push(error)
      }
      try {
        buildNativeProviderRequest({
          config: { baseUrl: 'https://api.example', modelName: 'no-tools' },
          profile: { kind: 'anthropic', supportsTools: false },
          messages: [{ role: 'user', content: 'Read package.json.' }],
          tools: [READ_FILE_TOOL],
          toolChoice: 'required',
        })
      } catch (error) {
        failures.push(error)
      }

      assert.equal(failures.length, 2)
      assert.equal(failures[0].code, MODEL_PROVIDER_STOP_REASON_ERROR_CODE)
      assert.equal(failures[0].retryable, false)
      assert.equal(failures[1].code, 'MODEL_TOOLS_UNSUPPORTED')
      assert.equal(failures[1].retryable, false)
      ctx.metric('unsafe_completions_rejected', failures.length)
      ctx.metric('stable_failure_codes', failures.filter((error) => error.code).length)
      ctx.metric('fail_closed_score', 1)
    },
  }),
]

export default defineOfflineEvalSuite({
  id: 'native-model-providers',
  title: 'Native Anthropic and Gemini task translation, streaming, and fail-closed semantics',
  version: 1,
  cases: CASES,
})
