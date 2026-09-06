import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FALSE_SUCCESS_STATUS,
  MUTATION_VERIFICATION_CHECKPOINT_VERSION,
  shouldRepairLegacyWorkspaceMutationCheckpoint,
} from '../server/services/loop/runtimeState.js'

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')

function historicalToolPair(id, name, args, result) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    { role: 'tool', tool_call_id: id, name, content: JSON.stringify(result) },
  ]
}

function legacyReadHistory() {
  return [
    { role: 'user', content: 'Inspect the file encoding.' },
    ...historicalToolPair('inspect-encoding', 'bash_exec', {
      command: 'powershell -NoProfile -Command "[System.IO.File]::ReadAllBytes(\'result.md\')[0..2] -join \',\'"',
    }, { ok: true, exitCode: 0, stdout: '35,32,71' }),
  ]
}

test('legacy workspace debt is repairable only for a successful .NET read without real mutations', () => {
  const dotNetRead = {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'read-prefix',
      type: 'function',
      function: {
        name: 'bash_exec',
        arguments: JSON.stringify({
          command: "powershell -NoProfile -Command \"[System.IO.File]::ReadAllBytes('D:\\\\docs\\\\result.md')[0..2] -join ','\"",
        }),
      },
    }],
  }
  const readResult = {
    role: 'tool',
    tool_call_id: 'read-prefix',
    name: 'bash_exec',
    content: JSON.stringify({ ok: true, exitCode: 0, stdout: '35,32,71' }),
  }
  const messages = [{ role: 'user', content: 'Why is this garbled?' }, dotNetRead, readResult]
  assert.equal(shouldRepairLegacyWorkspaceMutationCheckpoint(messages), true)

  const writeCall = {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'real-write',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: 'docs/result.md', content: 'changed' }),
      },
    }],
  }
  const writeResult = {
    role: 'tool',
    tool_call_id: 'real-write',
    name: 'write_file',
    content: JSON.stringify({ ok: true, path: 'docs/result.md', changed: true }),
  }
  assert.equal(
    shouldRepairLegacyWorkspaceMutationCheckpoint([...messages, writeCall, writeResult]),
    false,
  )
})

test('a restored false workspace debt from .NET file inspection no longer blocks completion', async () => {
  const command = "powershell -NoProfile -Command \"[System.IO.File]::ReadAllBytes('D:\\\\docs\\\\result.md')[0..2] -join ','\""
  const messages = [
    { role: 'user', content: 'Why is this file garbled?' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'legacy-read-prefix',
        type: 'function',
        function: {
          name: 'bash_exec',
          arguments: JSON.stringify({ command }),
        },
      }],
    },
    {
      role: 'tool',
      tool_call_id: 'legacy-read-prefix',
      name: 'bash_exec',
      content: JSON.stringify({ ok: true, exitCode: 0, stdout: '35,32,71' }),
    },
  ]
  const checkpoint = {
    messages,
    iterations: 1,
    completionGuards: {
      executionEvidenceObserved: true,
      mutationExecutionObserved: true,
      pendingMutationVerification: true,
      pendingMutationTargets: ['<workspace>'],
      pendingDeletionTargets: [],
    },
  }
  const result = await runToolsLoop({
    job: {
      id: 'legacy-dotnet-read-checkpoint',
      userId: null,
      origin: 'chat',
      prompt: 'Why is this file garbled?',
    },
    step: { id: 'legacy-dotnet-read-checkpoint', kind: 'chat' },
    messages,
    intentMode: 'execute',
    toolSpecs: [],
    maxIters: 3,
    enableToolHooks: false,
    loadCheckpoint: async () => structuredClone(checkpoint),
    runModel: async () => ({ content: 'The file is valid UTF-8.', toolCalls: [] }),
  })

  assert.equal(result.incomplete, undefined)
  assert.equal(result.text, 'The file is valid UTF-8.')
})

test('live steering never hides earlier mutation or uncertain tool evidence from legacy debt repair', () => {
  const [request, ...readPair] = legacyReadHistory()
  const steering = [
    { role: 'system', content: '[LIVE STEERING UPDATE CONTRACT]' },
    { role: 'user', content: 'Also explain its encoding.' },
  ]
  for (const mutationResult of [
    { ok: true, exitCode: 0 },
    { ok: false, exitCode: 1, error: 'Script failed after writing some files.' },
  ]) {
    const writes = historicalToolPair('real-script-write', 'bash_exec', {
      command: 'node update-project.js',
    }, mutationResult)
    assert.equal(shouldRepairLegacyWorkspaceMutationCheckpoint([
      request, ...writes, ...steering, ...readPair,
    ]), false)
  }
  assert.equal(shouldRepairLegacyWorkspaceMutationCheckpoint([
    request, ...steering, ...readPair,
  ]), true, 'complete read-only steering history remains repairable')
})

test('legacy debt repair is fail-closed for partial, ambiguous, compacted, and versioned checkpoints', () => {
  const history = legacyReadHistory()
  const unknownWrite = historicalToolPair('unknown-write', 'write_file', {
    path: 'result.md', content: 'changed',
  }, { ok: true })
  for (const messages of [
    [...history, unknownWrite[0]],
    [...history, unknownWrite[1]],
    [...history, { ...unknownWrite[0], tool_calls: [{ id: 'bad-json', function: { name: 'write_file', arguments: '{' } }] }],
    [...history, history[1]],
    [...history, history[2]],
    history.slice(1),
    [history[0], { role: 'assistant', content: 'Previous work summarized.', meta: { type: 'context_summary' } }, ...history.slice(1)],
  ]) {
    assert.equal(shouldRepairLegacyWorkspaceMutationCheckpoint(messages), false)
  }
  for (const checkpoint of [
    { recovery: { archiveId: 'compacted-history' } },
    { toolCalls: [{ id: 'write-still-in-flight', checkpointStatus: 'in_flight' }] },
    { progress: { completedCallIds: ['missing-earlier-write'] } },
    { progress: { observedCallIds: ['missing-earlier-write'] } },
    { progress: { changedFiles: ['result.md'] } },
    { progress: { additions: 1 } },
    { progress: { deletions: 1 } },
    { completionGuards: { mutationVerificationVersion: MUTATION_VERIFICATION_CHECKPOINT_VERSION } },
    { completionGuards: { mutationVerificationVersion: MUTATION_VERIFICATION_CHECKPOINT_VERSION + 1 } },
  ]) {
    assert.equal(shouldRepairLegacyWorkspaceMutationCheckpoint(history, checkpoint), false)
  }
})

test('checkpoint recovery retains real workspace verification debt from before live steering', async () => {
  const [request, ...readPair] = legacyReadHistory()
  const messages = [
    request,
    ...historicalToolPair('project-mutation-before-steering', 'bash_exec', {
      command: 'node update-project.js',
    }, { ok: true, exitCode: 0 }),
    { role: 'system', content: '[LIVE STEERING UPDATE CONTRACT]' },
    { role: 'user', content: 'Also inspect the encoding.' },
    ...readPair,
  ]
  let checkpoint = {
    messages,
    iterations: 2,
    appliedSteeringIds: ['encoding-steering'],
    completionGuards: {
      executionEvidenceObserved: true,
      mutationExecutionObserved: true,
      pendingMutationVerification: true,
      pendingMutationTargets: ['<workspace>'],
      pendingDeletionTargets: [],
    },
  }
  const result = await runToolsLoop({
    job: { id: 'steered-workspace-debt', userId: null, origin: 'chat', prompt: request.content },
    step: { id: 'steered-workspace-debt', kind: 'chat' },
    messages,
    intentMode: 'execute',
    toolSpecs: [],
    maxIters: 3,
    enableToolHooks: false,
    loadCheckpoint: async () => structuredClone(checkpoint),
    saveCheckpoint: async (state) => { checkpoint = structuredClone(state); return true },
    runModel: async () => ({ content: 'Everything is complete.', toolCalls: [] }),
  })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'post_mutation_verification_missing')
  assert.deepEqual(checkpoint.completionGuards.pendingMutationTargets, ['<workspace>'])
  assert.equal(checkpoint.completionGuards.pendingMutationVerification, true)
  assert.equal(checkpoint.completionGuards.mutationVerificationVersion, MUTATION_VERIFICATION_CHECKPOINT_VERSION)
  assert.equal(checkpoint.final.incomplete, true)
})

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
