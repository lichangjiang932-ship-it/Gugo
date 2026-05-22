import test from 'node:test'
import assert from 'node:assert/strict'

import {
  artifactTypeForSkill,
  buildAssistantToolCallsMessage,
  buildChatFailureMessage,
  filterToolNamesForSkill,
  shouldStopAfterArtifactTool,
} from '../src/lib/chatFlowGuards.js'

test('/htmlppt keeps model on single-file HTML path instead of file-generation tools', () => {
  const enabled = ['web_search', 'create_pptx', 'create_docx', 'create_xlsx', 'create_html_app', 'manage_todos']
  assert.deepEqual(
    filterToolNamesForSkill(enabled, 'htmlppt'),
    ['web_search', 'manage_todos'],
  )
})

test('file skills still keep their matching generation tools', () => {
  const enabled = ['create_pptx', 'create_docx', 'create_xlsx', 'manage_todos']
  assert.deepEqual(filterToolNamesForSkill(enabled, 'ppt'), enabled)
})

test('assistant tool-call context uses null content for OpenAI-compatible providers', () => {
  const msg = buildAssistantToolCallsMessage([
    { id: 'call_1', name: 'create_pptx', arguments: '{"title":"Deck"}' },
  ])

  assert.equal(msg.role, 'assistant')
  assert.equal(msg.content, null)
  assert.deepEqual(msg.tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'create_pptx', arguments: '{"title":"Deck"}' },
    },
  ])
})

test('artifact-producing tool calls end the tool loop without a second model round', () => {
  assert.equal(shouldStopAfterArtifactTool({ type: 'pptx', title: 'Deck', source: '# Deck' }), true)
  assert.equal(shouldStopAfterArtifactTool({ type: 'html', title: 'Deck', source: '<html></html>' }), true)
  assert.equal(shouldStopAfterArtifactTool(null), false)
})

test('chat failure copy does not blame env config for generic invalid request', () => {
  const text = buildChatFailureMessage('请求参数无效：请检查消息内容、工具调用上下文或当前模型的 OpenAI 兼容性。')
  assert.match(text, /模型调用失败/)
  assert.doesNotMatch(text, /MODEL_BASE_URL/)
  assert.doesNotMatch(text, /MODEL_API_KEY/)
})

test('chat failure copy keeps admin env hint for real configuration failures', () => {
  const text = buildChatFailureMessage('后端模型未配置：缺少 MODEL_BASE_URL。请管理员检查 .env。')
  assert.match(text, /MODEL_BASE_URL/)
  assert.match(text, /请联系管理员/)
})

test('artifact type mapping keeps htmlppt as html', () => {
  assert.equal(artifactTypeForSkill('htmlppt'), 'html')
  assert.equal(artifactTypeForSkill('ppt'), 'pptx')
})
