import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { normalizeChatTurnIntentMode, shouldRequireExecution } from '../server/utils/executionIntent.js'
import { shouldInheritExecutionIntent } from '../server/services/chatToolSelection.js'

test('stale chat execute mode does not mandate work for greetings, explanations, or status', () => {
  for (const text of [
    'hi', '  HELLO!  ', '你好', '您好！', '谢谢',
    '你是谁？', '你能做什么？', 'Who are you?',
    '解释这个函数的作用。', 'Explain how this code works.',
    '修复了吗？', 'What is the status?', 'Did you fix the bug?',
  ]) {
    assert.equal(normalizeChatTurnIntentMode('execute', text), 'auto', text)
    assert.equal(shouldRequireExecution({ text }), false, text)
  }
})

test('polite explanation questions also shed a stale execution mandate', async (t) => {
  for (const text of [
    'Can you explain this function?',
    'Could you explain why the test failed?',
    '能否介绍一下这个项目？',
  ]) {
    await t.test(text, () => {
      assert.equal(normalizeChatTurnIntentMode('execute', text), 'auto')
      assert.equal(shouldRequireExecution({ text }), false)
    })
  }
})

test('contextual confirmations retain the explicitly supplied execute mode', () => {
  // The caller owns the preceding plan context. This context-free compatibility
  // guard must not erase the one-turn confirmation sent by that caller.
  for (const text of ['执行', '继续', '继续执行', '按上述计划执行。', 'Continue.', 'Go ahead.']) {
    assert.equal(normalizeChatTurnIntentMode('execute', text), 'execute', text)
  }
})

test('supported plan-mode confirmations retain execution intent for a later continuation', () => {
  for (const text of ['执行', '正常模式执行', '自动模式执行']) {
    assert.equal(shouldRequireExecution({ text }), true, text)
    assert.equal(shouldInheritExecutionIntent('继续', text), true, text)
    assert.equal(shouldRequireExecution({ intentMode: 'answer', text }), false, text)
  }
})

test('long explanatory lists remain fast without ignoring a later explicit work order', () => {
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { shouldRequireExecution } from './server/utils/executionIntent.js'
    const text = 'Explain these labels: ' + 'alpha, beta, gamma, delta. '.repeat(1000)
    console.log(JSON.stringify([
      shouldRequireExecution({ text }),
      shouldRequireExecution({ text: text + 'Please fix src/App.jsx.' }),
    ]))
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000 })
  assert.equal(probe.error, undefined, 'intent parsing must not block on a modest explanatory list')
  assert.equal(probe.status, 0, probe.stderr)
  assert.deepEqual(JSON.parse(probe.stdout), [false, true])
})

test('affirmative work requests keep their explicit execute mode even in question form', () => {
  for (const text of [
    '请修复 app.js。',
    'Update package.json to add the test script.',
    'Delete obsolete.json.',
    'Can you fix the bug?',
    'Could you update package.json?',
    '能否修复这个问题？',
    '可以把按钮改成蓝色吗？',
    'Can you execute the plan and explain the outcome?',
  ]) {
    assert.equal(normalizeChatTurnIntentMode('execute', text), 'execute', text)
  }
})

test('a query does not erase a separate affirmative mutation or execution clause', async (t) => {
  for (const text of [
    'Explain the bug and fix it.',
    'Explain the error and delete obsolete.json.',
    '解释这个错误，修复 app.js',
    '解释这段代码并删除无用分支。',
    'What is the status, and please update package.json?',
    'Explain why this failed, then deploy the app.',
    '为什么还没执行？现在执行。',
    '为什么失败？请修复。',
    'How does this work? Please update the README.',
  ]) {
    await t.test(text, () => {
      assert.equal(normalizeChatTurnIntentMode('execute', text), 'execute')
      assert.equal(shouldRequireExecution({ text }), true, 'auto-mode clients must still infer the separate work order')
    })
  }
})

test('quoted, hypothetical, and prohibited mutation words remain explanation-only', async (t) => {
  for (const text of [
    'Explain how to fix app.js.',
    'How can I delete a file?',
    'Explain how to update a file and delete it safely.',
    'Explain what "run the build and deploy the app" means.',
    "Explain what 'run the build and deploy the app' means.",
    'Explain what ‘run the build and deploy the app’ means.',
    'Explain why we read files and update them.',
    'Explain the bug and do not fix it.',
    '请解释删除文件的步骤，不要修改文件。',
    'Can you explain how to read package.json?',
    'Explain how to read files and update them.',
    'How do I read files, write changes, and then save them?',
    '解释如何读取文件并修改它。',
  ]) {
    await t.test(text, () => {
      assert.equal(normalizeChatTurnIntentMode('execute', text), 'auto')
      assert.equal(shouldRequireExecution({ text }), false)
    })
  }
})

test('chat compatibility normalization does not override non-execute modes', () => {
  for (const [supplied, expected] of [
    ['answer', 'answer'],
    ['auto', 'auto'],
    [undefined, 'auto'],
    ['invalid-mode', 'auto'],
    [' ANSWER ', 'answer'],
  ]) {
    assert.equal(normalizeChatTurnIntentMode(supplied, 'Please fix app.js.'), expected)
  }
  assert.equal(normalizeChatTurnIntentMode(' EXECUTE ', 'hi'), 'auto')
  assert.equal(normalizeChatTurnIntentMode(' EXECUTE ', 'Please fix app.js.'), 'execute')
})
