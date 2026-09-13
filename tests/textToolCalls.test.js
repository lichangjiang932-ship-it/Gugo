import assert from 'node:assert/strict'
import test from 'node:test'

import { createTextToolCallDeltaFilter, extractTextToolCalls, salvageBareJsonToolCall } from '../server/utils/textToolCalls.js'

test('parses JSON text tool calls and removes protocol text from visible content', () => {
  const parsed = extractTextToolCalls('正在创建。\n<tool_call>{"name":"create_html_app","arguments":{"title":"Demo","html":"<html><body>ok</body></html>"}}</tool_call>')
  assert.equal(parsed.detected, true)
  assert.equal(parsed.content, '正在创建。')
  assert.equal(parsed.toolCalls[0].function.name, 'create_html_app')
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).title, 'Demo')
})

test('parses tagged apply_patch calls without weakening its downstream trust gate', () => {
  const parsed = extractTextToolCalls(`<tool_call>
<function=apply_patch>
<parameter=patch>*** Begin Patch
*** Add File: index.html
+<!doctype html><title>Demo</title>
*** End Patch</parameter>
</function>
</tool_call>`)
  assert.equal(parsed.toolCalls[0].function.name, 'apply_patch')
  assert.match(JSON.parse(parsed.toolCalls[0].function.arguments).patch, /Add File: index\.html/)
})

test('stream filter withholds a tool marker split across deltas', () => {
  const filter = createTextToolCallDeltaFilter()
  const visible = [
    filter.push('准备'),
    filter.push('<tool_'),
    filter.push('call>{"name":"read_file"}'),
    filter.finish(),
  ].join('')
  assert.equal(visible, '准备')
  assert.equal(filter.suppressing, true)
})

test('keeps a malformed protocol body visible instead of silently dropping it', () => {
  const parsed = extractTextToolCalls('好的。<tool_call>{"name": "read_file", "arguments": {"path": }</tool_call>')
  assert.equal(parsed.detected, true)
  assert.equal(parsed.toolCalls.length, 0)
  assert.match(parsed.content, /^好的。/)
  assert.match(parsed.content, /"path": \}/)
})

test('salvages a bare JSON tool call whose name matches the turn allowlist', () => {
  const parsed = salvageBareJsonToolCall(
    '{"name": "read_file", "arguments": {"path": "src/app.js"}}',
    { allowedToolNames: ['list_directory', 'read_file'] },
  )
  assert.equal(parsed.detected, true)
  assert.equal(parsed.content, '')
  assert.equal(parsed.toolCalls[0].function.name, 'read_file')
  assert.equal(JSON.parse(parsed.toolCalls[0].function.arguments).path, 'src/app.js')
})

test('salvages a fenced bare JSON tool call with provider-style arguments string', () => {
  const parsed = salvageBareJsonToolCall(
    '```json\n{"name": "list_directory", "arguments": "{\\"path\\": \\".\\"}"}\n```',
    { allowedToolNames: ['list_directory'] },
  )
  assert.equal(parsed.detected, true)
  assert.equal(parsed.toolCalls[0].function.name, 'list_directory')
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { path: '.' })
})

test('rejects bare JSON salvage when the name is not in the turn allowlist', () => {
  const text = '{"name": "bash_exec", "arguments": {"command": "rm -rf /"}}'
  const parsed = salvageBareJsonToolCall(text, { allowedToolNames: ['list_directory', 'read_file'] })
  assert.equal(parsed.detected, false)
  assert.equal(parsed.content, text)
  assert.deepEqual(parsed.toolCalls, [])
})

test('rejects bare JSON salvage without an allowlist or with mixed prose', () => {
  const allowlist = { allowedToolNames: ['read_file'] }
  for (const [value, allowed] of [
    ['{"name": "read_file", "arguments": {}}', true],
    ['', false],
  ]) {
    const parsed = salvageBareJsonToolCall(value, allowed ? allowlist : {})
    assert.equal(parsed.detected, allowed)
  }
  const mixed = '这是要写入的配置：{"name": "write_file", "arguments": {}}'
  const parsed = salvageBareJsonToolCall(mixed, allowlist)
  assert.equal(parsed.detected, false)
  assert.equal(parsed.content, mixed)
})

test('rejects bare JSON salvage for arrays, malformed JSON and reserved marker text', () => {
  const allowlist = { allowedToolNames: ['read_file'] }
  for (const text of [
    '[{"name": "read_file", "arguments": {}}]',
    '{"name": "read_file", "arguments": {}} extra',
    '{"name": "read_file"}',
    '<tool_call>{"name": "read_file"}</tool_call>',
  ]) {
    const parsed = salvageBareJsonToolCall(text, allowlist)
    assert.equal(parsed.detected, false)
    assert.equal(parsed.content, text)
  }
})
