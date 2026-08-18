import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasActionableNumberedSteps,
  hasFileTargetReference,
  hasMutationExecutionIntent,
  isExecutionCapabilityChallenge,
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

test('object-first transformation requests are executable mutations', () => {
  for (const text of [
    '把它做成立体可旋转的，可以转为横着的，也可以转为竖着的',
    '把这个网页改成可以横向和竖向旋转的 3D 展廊',
    '将当前页面改造为立体画廊',
  ]) {
    assert.equal(shouldRequireExecution({ text }), true, text)
    assert.equal(hasMutationExecutionIntent(text), true, text)
  }

  for (const text of [
    '为什么它会变成立体的？',
    '如何把网页做成立体可旋转的？',
    '我想知道，把网页做成立体怎么实现？',
    '先不要把它改成立体的',
  ]) {
    assert.equal(shouldRequireExecution({ text }), false, text)
    assert.equal(hasMutationExecutionIntent(text), false, text)
  }

  const createCopy = '把它做成立体的，另建版本并保留原版'
  assert.equal(shouldRequireExecution({ text: createCopy }), true)
  assert.equal(hasMutationExecutionIntent(createCopy), true)
})

test('visual and file editing orders use the mutation toolchain on the first turn', () => {
  for (const text of [
    '"E:\\果\\gallery.html"这个网站，是用了很多图片，但是现在我还有几个需求，1.图片之间太过拥挤2.旋转的时候似乎无法维系圆形',
    '请读取 E:\\果\\gallery.html，把卡片翻转后的背面显示和朝向调整好。',
    '编辑 E:\\果\\gallery.html，修好卡片背面和翻转方向。',
    '把这个页面的卡片翻转效果改一下。',
    '修改联网搜索页面的颜色和图标。',
    '只修改当前这一张「联网搜索」配置页面，页面功能和交互逻辑全部保留不变。',
    'mini timeline中间的竖线去掉。',
    '主题添加一个白色。',
    '1. 网页版设置里面配置文件打不开；2. 主题添加一个白色；3. 不要随机分配工具了，要按需挂载。',
    'Edit the gallery page and adjust the card flip direction.',
  ]) {
    assert.equal(shouldRequireExecution({ text }), true, text)
    assert.equal(hasMutationExecutionIntent(text), true, text)
  }

  for (const text of [
    '"E:\\果\\gallery.html"这个文件有什么问题？',
    '请分析 "E:\\果\\gallery.html" 的以下需求：1.图片是否拥挤2.旋转是否圆滑',
    '如何编辑这个页面？',
    '为什么需要调整卡片翻转方向？',
    '不要编辑或调整这个页面，只分析翻转问题。',
    'How do I edit the gallery page?',
    'Do not edit or adjust the gallery page; only explain the flip issue.',
  ]) {
    assert.equal(shouldRequireExecution({ text }), false, text)
    assert.equal(hasMutationExecutionIntent(text), false, text)
  }
})

test('routing, addition, and rewind orders distinguish affirmative work from prohibitions', () => {
  for (const text of [
    '要按需挂载',
    '不要随机分配工具了，要按需挂载',
    '添加一个白色主题',
    '主题添加一个白色',
    'Rewrite notes.txt then revert the change.',
    'Undo the changes in notes.txt.',
    '回滚 notes.txt 的修改。',
    '撤销对 notes.txt 的改动。',
    '把 notes.txt 恢复原状。',
  ]) {
    assert.equal(shouldRequireExecution({ text }), true, text)
    assert.equal(hasMutationExecutionIntent(text), true, text)
  }

  for (const text of [
    '不要添加白色主题',
    '不要增加白色主题',
    '不要按需挂载工具',
    '不要随机分配工具',
    '不要撤销 notes.txt 的修改',
    '无需还原 notes.txt',
  ]) {
    assert.equal(shouldRequireExecution({ text }), false, text)
    assert.equal(hasMutationExecutionIntent(text), false, text)
  }
})

test('capability challenges are recognized without becoming standalone write orders', () => {
  for (const text of [
    '为什么不能你来改',
    '为什么不能你自己修改？',
    '为什么你不能直接改？',
    '你不能直接改吗？',
    '为什么没有写入工具？',
    '那你不能直接改吗？',
    '可是为什么不能你来改？',
    '难道你不能自己修改？',
    '既然有工具，为什么不能直接改？',
    '为什么不直接由你来改？',
    '怎么不自己修改？',
    '你不能修改用户资料？',
    "Why can't you edit it yourself?",
    'Why are you unable to write the file?',
    "But why can't you just fix it yourself?",
  ]) {
    assert.equal(isExecutionCapabilityChallenge(text), true, text)
    assert.equal(shouldRequireExecution({ text }), false, text)
  }

  for (const text of [
    '为什么登录状态会过期？',
    '为什么不能修改只读文件？',
    '为什么用户不能修改昵称？',
    '为什么管理员不能直接编辑成员资料？',
    '为什么当前用户不能修改昵称？',
    '为什么系统管理员不能编辑成员资料？',
    '为什么当前页面不能修改标题？',
    '你能解释为什么用户不能修改昵称吗？',
    '只解释为什么不能修改，不要改文件。',
    'Why is this API response immutable?',
    'Why is the current system unable to edit records?',
  ]) {
    assert.equal(isExecutionCapabilityChallenge(text), false, text)
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
