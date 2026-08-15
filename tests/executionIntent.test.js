import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasActionableNumberedSteps,
  hasFileTargetReference,
  hasMutationExecutionIntent,
  normalizeTurnIntentMode,
  shouldRequireExecution,
} from '../server/utils/executionIntent.js'

test('turn intent mode is strict and defaults unknown callers to auto', () => {
  assert.equal(normalizeTurnIntentMode(' execute '), 'execute')
  assert.equal(normalizeTurnIntentMode('ANSWER'), 'answer')
  assert.equal(normalizeTurnIntentMode('unexpected'), 'auto')
  assert.equal(normalizeTurnIntentMode(null), 'auto')
})

test('explicit intent mode overrides textual inference', () => {
  assert.equal(shouldRequireExecution({ intentMode: 'execute', text: '为什么会失败？' }), true)
  assert.equal(shouldRequireExecution({ intentMode: 'answer', text: '请修复这个项目' }), false)
})

test('auto mode recognizes concise Chinese and English work orders', () => {
  const workOrders = [
    '继续，完善工作内核，像 Codex 那样',
    '把登录问题处理好',
    '优化一下侧边栏',
    '请修复这个 bug',
    '帮我补全上传逻辑',
    'go ahead and improve the execution loop',
    'please fix the login bug',
    '\u8bf7\u96c6\u6210\u4ee3\u7801\u6267\u884c\u80fd\u529b\uff0c\u4ee3\u7801\u6267\u884c\u80fd\u529b\u662f\u6838\u5fc3\u5173\u952e',
    'please integrate code execution into the project',
  ]
  for (const text of workOrders) {
    assert.equal(shouldRequireExecution({ text }), true, text)
  }
})

test('auto mode recognizes write orders with Chinese filenames and nested Windows paths', () => {
  const screenshotPrompt = [
    'As analyzed above, career competition and financial pressure should not be ignored. 写入 Task 1。',
    '[附件: 雅思写作最新答题纸.pdf, 217.9 KB]"D:\\desktop\\雅思写作最新答题纸.pdf"',
  ].join('\n')
  assert.equal(shouldRequireExecution({ text: screenshotPrompt }), true)
  assert.equal(shouldRequireExecution({ text: '将最终稿保存到 D:\\reports\\中文报告.docx' }), true)
  assert.equal(shouldRequireExecution({ text: 'How do I write content into report.pdf?' }), false)
})

test('auto mode leaves explanatory questions as answer-only requests', () => {
  const questions = [
    '什么是工作内核？',
    '为什么登录会失败？',
    '如何优化侧边栏？',
    '介绍一下 Codex',
    'explain how the execution loop works',
  ]
  for (const text of questions) {
    assert.equal(shouldRequireExecution({ text }), false, text)
  }
  assert.equal(shouldRequireExecution({ text: '如何定位问题，然后帮我修复登录逻辑' }), true)
})

test('external action requests execute while send-how-to questions remain answers', () => {
  for (const text of [
    'Send a Slack message to the release channel.',
    'Could you send the release notification?',
    '请发送一条发布通知',
    '你能通知发布群吗？',
  ]) {
    assert.equal(shouldRequireExecution({ text }), true, text)
  }
  for (const text of [
    'How do I send a Slack message?',
    'Can you explain how to send a Slack message?',
    '如何发送 Slack 消息？',
  ]) {
    assert.equal(shouldRequireExecution({ text }), false, text)
  }
})

test('an explanatory lead does not hide a later explicit execution order', () => {
  assert.equal(shouldRequireExecution({
    text: 'How should this login bug be fixed? Please fix it now.',
  }), true)
  assert.equal(shouldRequireExecution({
    text: '如何定位这个登录问题？直接帮我修复好。',
  }), true)
  assert.equal(shouldRequireExecution({
    text: 'How should this login bug be fixed?',
  }), false)
})

test('delegated Chinese repair orders execute without turning repair questions into commands', () => {
  assert.equal(shouldRequireExecution({
    text: '\u4f60\u6839\u636e\u5b9e\u9645\u60c5\u51b5\u6765\u8fdb\u884c\u4fee\u590d\uff0cpython\u7b49\u7684\u4ee3\u7801\u6267\u884c\u80fd\u529b\u662f\u5fc5\u987b\u6709\u7684',
  }), true)
  assert.equal(shouldRequireExecution({
    text: '\u4f60\u8ba4\u4e3a\u5e94\u8be5\u600e\u4e48\u4fee\u590d\uff1f',
  }), false)
})

test('numbered action plans execute while numbered questions remain answers', () => {
  assert.equal(hasActionableNumberedSteps('1. 检查登录\n2. 修复会话恢复'), true)
  assert.equal(shouldRequireExecution({ text: '1. 检查登录\n2. 修复会话恢复' }), true)
  assert.equal(hasActionableNumberedSteps('1. 什么是租约\n2. 为什么要续租'), false)
  assert.equal(shouldRequireExecution({ text: '1. 什么是租约\n2. 为什么要续租' }), false)
})

test('mutation inference remains available to the post-write verification guard', () => {
  assert.equal(hasMutationExecutionIntent('完善工作内核'), true)
  assert.equal(hasMutationExecutionIntent('请介绍工作内核'), false)
})

test('external sends are mutation intents and cannot be satisfied by a non-writing tool', () => {
  assert.equal(hasMutationExecutionIntent('Send the release update to Slack now.'), true)
  assert.equal(hasMutationExecutionIntent('Do not regenerate the PDF; only read it back.'), false)
  assert.equal(hasMutationExecutionIntent('\u4e0d\u8981\u91cd\u65b0\u751f\u6210\u6587\u4ef6\uff1b\u53ea\u56de\u8bfb\u5e76\u5217\u76ee\u5f55\u3002'), false)
  assert.equal(hasMutationExecutionIntent('\u4e0d\u8981\u4fee\u6539 A\uff1b\u8bf7\u521b\u5efa B.txt\u3002'), true)
  assert.equal(hasMutationExecutionIntent('请立即发送发布通知。'), true)
})

test('negated mutations do not create execution intent while mixed work orders remain executable', () => {
  assert.equal(shouldRequireExecution({
    text: '请只给我一个 JavaScript 代码片段，不要修改文件。',
  }), false)
  assert.equal(shouldRequireExecution({
    text: '不要修改 A；请创建 B.txt。',
  }), true)
  assert.equal(shouldRequireExecution({
    text: '修改 src/example.js，并给我一个代码片段。',
  }), true)
  assert.equal(hasFileTargetReference('修改 src/example.js，并给我一个代码片段。'), true)
})
