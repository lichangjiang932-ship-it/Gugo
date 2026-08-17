import assert from 'node:assert/strict'
import test from 'node:test'

import {
  artifactTypeForSkill,
  buildChatFailureDisplayKey,
  buildChatFailureMessage,
  getVisibleModelErrorMessage,
} from '../src/lib/chatFlowGuards.js'

test('chat failure copy does not blame env config for a generic invalid request', () => {
  const text = buildChatFailureMessage('请求参数无效：请检查消息内容或当前模型兼容性。')
  assert.match(text, /请求参数无效/)
  assert.doesNotMatch(text, /Model call failed/i)
  assert.doesNotMatch(text, /MODEL_BASE_URL/)
  assert.doesNotMatch(text, /MODEL_API_KEY/)
})

test('chat failure copy never exposes internal artifact errors or incomplete-file handoff copy', () => {
  const text = buildChatFailureMessage(
    'Model call failed: The requested file was not created. The model must successfully call: create_html_app.',
  )
  assert.match(text, /任务执行遇到问题/)
  assert.doesNotMatch(text, /Model call failed|requested file|create_html_app|任务未完全完成|已保留生成的文件/i)
})

test('failure display keys collapse the same turn and failure code', () => {
  assert.equal(
    buildChatFailureDisplayKey('turn-1', { serverFailure: { code: 'ARTIFACT_NOT_CREATED' } }),
    'turn-1:ARTIFACT_NOT_CREATED',
  )
  assert.equal(
    buildChatFailureDisplayKey('turn-1', { code: 'ARTIFACT_NOT_CREATED' }),
    'turn-1:ARTIFACT_NOT_CREATED',
  )
})

test('chat failure copy directs users to model settings for configuration failures', () => {
  const text = buildChatFailureMessage('后端模型未配置：缺少 MODEL_BASE_URL。')
  assert.match(text, /模型服务尚未正确配置/)
  assert.match(text, /设置 → 模型/)
  assert.doesNotMatch(text, /MODEL_BASE_URL|MODEL_API_KEY/)
  assert.doesNotMatch(text, /请联系管理员/)
})

test('artifact type mapping keeps current skill previews', () => {
  for (const skillId of ['ppt', 'htmlppt', 'axippt', 'ppt-master', 'guizang-ppt']) {
    assert.equal(artifactTypeForSkill(skillId), 'pptx')
  }
  assert.equal(artifactTypeForSkill('doc'), 'docx')
  assert.equal(artifactTypeForSkill('webpage'), 'html')
  assert.equal(artifactTypeForSkill('unknown'), undefined)
})

test('visible model errors retain translated empty-response messages and sanitize raw provider errors', () => {
  const t = (key) => `translated:${key}`
  assert.equal(
    getVisibleModelErrorMessage({ code: 'EMPTY_MODEL_RESPONSE' }, t),
    'translated:errors.emptyModelResponse',
  )
  assert.equal(
    getVisibleModelErrorMessage(new Error('upstream failed'), t),
    '任务执行遇到问题，尚未完成。请重试；若仍失败，请检查所选模型是否支持当前工具。',
  )
})
