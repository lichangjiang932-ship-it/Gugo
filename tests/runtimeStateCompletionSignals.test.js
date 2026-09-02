import assert from 'node:assert/strict'
import test from 'node:test'

import { FALSE_SUCCESS_STATUS } from '../server/services/loop/runtimeState.js'

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')

test('explicit English completion confirmations are recognized', () => {
  for (const text of [
    'Done.',
    'Yes, it is.',
    'The work has finished.',
    'Everything is complete.',
    'The task has been completed.',
    'All done.',
    "It's done.",
    'Task complete.',
    'This is done.',
    'Done. Would you like details?',
    'Everything is complete. Need anything else?',
    'The task is now complete.',
    'The work was now finished.',
    'I completed the task.',
    'I have completed the work successfully.',
    "I've finished it.",
    'The task was completed.',
    'Everything was completed.',
    'It is completed.',
    "We're done.",
    'The requested changes are complete.',
    'I completed the requested task.',
  ]) {
    assert.equal(FALSE_SUCCESS_STATUS.test(text), true, text)
  }
})

test('a prior failed turn cannot be changed to success by terse completion claims', async () => {
  const readFile = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
  const completionClaims = [
    'All done.',
    "It's done.",
    'Task complete.',
    'This is done.',
    'Done. Would you like details?',
    'Everything is complete. Need anything else?',
    'The task was completed.',
    "We're done.",
    'I completed the requested changes.',
  ]

  for (const [index, completionClaim] of completionClaims.entries()) {
    let modelCalls = 0
    const result = await runToolsLoop({
      job: {
        id: `prior-failure-terse-completion-${index}`,
        userId: null,
        origin: 'chat',
        locale: 'en',
        prompt: 'Is the work complete?',
      },
      step: { id: `prior-failure-terse-completion-${index}`, kind: 'chat' },
      messages: [
        { role: 'user', content: 'Create and verify result.txt.' },
        {
          role: 'system',
          content: '[PRIOR TURN OUTCOME]\n{"state":"failed","error":{"message":"verification failed"}}\nThe prior turn did not complete.',
        },
        { role: 'assistant', content: 'The task is incomplete.' },
        { role: 'user', content: 'Is the work complete?' },
      ],
      toolSpecs: [readFile],
      maxIters: 3,
      enableToolHooks: false,
      runModel: async () => {
        modelCalls += 1
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: `inspect-prior-output-${index}`,
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"result.txt"}' },
            }],
          }
        }
        return { content: completionClaim, toolCalls: [] }
      },
      executeTool: async () => ({ ok: true, path: 'result.txt', content: 'partial output' }),
    })

    assert.equal(modelCalls, 2, completionClaim)
    assert.match(result.text, /prior turn is still incomplete/i, completionClaim)
    assert.doesNotMatch(result.text, new RegExp(completionClaim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }
})

test('completion questions are not treated as confirmations', () => {
  for (const text of [
    'Done?',
    'Yes, it is?',
    'The work has finished?',
    'Is it complete?',
    'Has the task been completed?',
    'Everything is done？',
    'The task is now complete?',
    'I completed the task?',
    "I haven't completed the task.",
    'I did not complete the task.',
    'I completed the task, but verification failed.',
    "I don't think everything is complete.",
    'If everything is complete.',
    'Not everything is complete.',
    'The logs claim the task is complete.',
    'I doubt the task is complete.',
    'It does not look like the task is complete.',
    'The report said the task is complete.',
    'None of the changes are complete.',
    'Only one task is complete.',
  ]) {
    assert.equal(FALSE_SUCCESS_STATUS.test(text), false, text)
  }
})
