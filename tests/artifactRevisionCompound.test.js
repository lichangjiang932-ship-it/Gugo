import assert from 'node:assert/strict'
import test from 'node:test'
import { isArtifactRevisionRequest } from '../shared/artifactIntent.js'

test('tool-call and analysis compounds do not become permission to modify the preceding deck', () => {
  for (const prompt of [
    '检查 create_pptx 工具为什么被调用，只分析代码。',
    '检查日志中的工具调用。',
    '查看这次任务的调度情况。',
    '查看调试记录。',
  ]) assert.equal(isArtifactRevisionRequest(prompt, { hasPriorArtifact: true }), false, prompt)
})

test('short adjustment requests and explicit revisions after a tool mention remain actionable', () => {
  for (const prompt of ['调一下字号', '颜色调成暖色', '将标题调大一点',
    '调用工具，把原PPT改成4:3并调大字号。', '检查后修改原PPT的标题。']) {
    assert.equal(isArtifactRevisionRequest(prompt, { hasPriorArtifact: true }), true, prompt)
  }
})
