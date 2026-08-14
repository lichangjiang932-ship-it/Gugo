import assert from 'node:assert/strict'
import test from 'node:test'

import {
  artifactTypeForSkill,
  buildChatFailureMessage,
  getVisibleModelErrorMessage,
} from '../src/lib/chatFlowGuards.js'

test('chat failure copy does not blame env config for a generic invalid request', () => {
  const text = buildChatFailureMessage('请求参数无效：请检查消息内容或当前模型兼容性。')
  assert.match(text, /Model call failed/)
  assert.doesNotMatch(text, /MODEL_BASE_URL/)
  assert.doesNotMatch(text, /MODEL_API_KEY/)
})

test('chat failure copy directs users to model settings for configuration failures', () => {
  const text = buildChatFailureMessage('后端模型未配置：缺少 MODEL_BASE_URL。')
  assert.match(text, /MODEL_BASE_URL/)
  assert.match(text, /设置 → 模型/)
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

test('visible model errors retain translated empty-response messages', () => {
  const t = (key) => `translated:${key}`
  assert.equal(
    getVisibleModelErrorMessage({ code: 'EMPTY_MODEL_RESPONSE' }, t),
    'translated:errors.emptyModelResponse',
  )
  assert.equal(getVisibleModelErrorMessage(new Error('upstream failed'), t), 'upstream failed')
})
