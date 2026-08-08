import assert from 'node:assert/strict'
import test from 'node:test'

import { createTextToolCallDeltaFilter, extractTextToolCalls } from '../server/utils/textToolCalls.js'

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
