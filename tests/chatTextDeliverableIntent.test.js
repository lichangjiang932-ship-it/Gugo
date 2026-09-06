import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { isTextDeliverableRequest, normalizeChatTurnIntentMode } from '../server/utils/executionIntent.js'
import { runToolsLoop } from '../server/services/jobTools.js'

const TEXT_REQUESTS = [
  '帮我写一份本周项目周报。',
  '请先写一份修复计划，不要实际修改文件。',
  '写一封给客户的邮件，不要发送。',
  'Write a short poem about the moon.',
  'Please draft a plan; do not modify any files.',
  'Write an email for me. Do not send it.',
]

test('text-only deliverables are recognized as answers in both supported languages', () => {
  for (const text of TEXT_REQUESTS) {
    assert.equal(isTextDeliverableRequest(text), true, text)
    assert.equal(normalizeChatTurnIntentMode('execute', text), 'auto', text)
  }
})

test('a plan or email noun does not exempt actual execution, sending, or file delivery', () => {
  for (const text of [
    '请执行上面的计划。',
    'Execute the above plan.',
    '请发送这封邮件。',
    'Send this email to the customer.',
    '请运行测试，然后写一份总结。',
    'Run the tests and write a report.',
    '写一份修复计划，然后执行。',
    'Write a plan, then execute it.',
    'Write the report to reports/weekly.md.',
    '把周报写入 D:\\reports\\weekly.md。',
    'Overwrite the plan.',
    'Create the reports folder.',
    'Create an email account for Alice.',
    'Write test reports to disk.',
  ]) assert.equal(isTextDeliverableRequest(text), false, text)
})

for (const intentMode of ['auto', 'execute']) {
  test(`chat ${intentMode} accepts text delivery without an unnecessary tool-repair round`, async () => {
    for (const [index, text] of TEXT_REQUESTS.entries()) {
      let modelCalls = 0
      const reply = 'Here is the requested text. 这是所需的正文。'
      const result = await runToolsLoop({
        job: { id: `text-answer-${intentMode}-${index}`, userId: null, origin: 'chat', prompt: text, userPrompt: text },
        step: { id: 'text-answer', kind: 'chat' },
        messages: [{ role: 'user', content: text }],
        intentMode,
        toolSpecs: [],
        fallbackToolSpecs: [],
        maxIters: 3,
        enableToolHooks: false,
        runModel: async ({ messages }) => {
          modelCalls += 1
          assert.equal(messages.some((message) => message.role === 'system'
            && /\[(?:DIRECT EXECUTION|EXECUTION EVIDENCE) REQUIRED\]/u.test(String(message.content))), false, text)
          return { content: reply, toolCalls: [], finishReason: 'stop' }
        },
        executeTool: async () => assert.fail('Text-only requests must not need a tool'),
      })
      assert.equal(modelCalls, 1, text)
      assert.equal(result.text, reply, text)
      assert.notEqual(result.incomplete, true, text)
    }
  })
}
