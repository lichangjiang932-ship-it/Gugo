import assert from 'node:assert/strict'
import test from 'node:test'

process.env.APPROVAL_MODE = 'off'

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')

function baseRun(overrides = {}) {
  return runToolsLoop({
    job: {
      id: 'turn-steering-loop',
      userId: 'turn-steering-user',
      title: 'Steering loop',
      prompt: 'Answer the request',
    },
    step: { id: 'turn-steering-step', kind: 'chat' },
    messages: [{ role: 'user', content: 'Original request' }],
    toolSpecs: [],
    intentMode: 'answer',
    maxIters: 4,
    ...overrides,
  })
}

test('an open completion gate defers completion and applies steering claimed on the next round', async () => {
  const modelRequests = []
  const savedStates = []
  const acknowledged = []
  let claims = 0
  let completionChecks = 0

  const result = await baseRun({
    claimSteering: async () => {
      claims += 1
      if (claims === 1) return { leaseId: null, messages: [] }
      if (claims === 2) {
        return {
          leaseId: 'lease-next-round',
          messages: [{ id: 'steering-next-round', content: 'Use the new direction' }],
        }
      }
      return { leaseId: null, messages: [] }
    },
    runModel: async ({ messages }) => {
      modelRequests.push(structuredClone(messages))
      const redirected = messages.some((message) => (
        message.role === 'user' && message.content === 'Use the new direction'
      ))
      return { content: redirected ? 'Updated answer' : 'Premature answer', toolCalls: [] }
    },
    beforeFinalCompletion: async () => {
      completionChecks += 1
      return { closed: completionChecks > 1 }
    },
    saveCheckpoint: async (state) => {
      savedStates.push(structuredClone(state))
      return true
    },
    acknowledgeSteering: async (leaseId) => acknowledged.push(leaseId),
  })

  assert.equal(result.text, 'Updated answer')
  assert.equal(claims, 2)
  assert.equal(completionChecks, 2)
  assert.equal(modelRequests.length, 2)
  assert.ok(modelRequests[1].some((message) => (
    message.role === 'user' && message.content === 'Use the new direction'
  )))
  assert.ok(savedStates.some((state) => (
    state.messages.some((message) => message.content === 'Premature answer')
  )))
  assert.deepEqual(acknowledged, ['lease-next-round'])
})

test('a steering checkpoint persists applied ids before acknowledging its lease', async () => {
  const order = []
  const checkpoints = []

  const result = await baseRun({
    claimSteering: async () => ({
      leaseId: 'lease-checkpoint-order',
      messages: [{ id: 'steering-checkpoint-order', content: 'Apply this update' }],
    }),
    runModel: async () => ({ content: 'Applied', toolCalls: [] }),
    saveCheckpoint: async (state) => {
      order.push('save')
      checkpoints.push(structuredClone(state))
      return true
    },
    acknowledgeSteering: async () => order.push('ack'),
  })

  assert.equal(result.text, 'Applied')
  assert.deepEqual(order, ['save', 'ack'])
  assert.deepEqual(checkpoints[0].appliedSteeringIds, ['steering-checkpoint-order'])
})

test('multiple steering batches reuse one stable system contract', async () => {
  const readFile = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'read_file')
  const requests = []
  let claims = 0

  const result = await baseRun({
    toolSpecs: [readFile],
    claimSteering: async () => {
      claims += 1
      return {
        leaseId: `steering-lease-${claims}`,
        messages: [{ id: `steering-${claims}`, content: `Direction ${claims}` }],
      }
    },
    acknowledgeSteering: async () => {},
    saveCheckpoint: async () => true,
    executeTool: async () => ({ ok: true, content: 'README contents' }),
    runModel: async ({ messages }) => {
      requests.push(structuredClone(messages))
      if (requests.length === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'steering-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          }],
        }
      }
      return { content: 'Updated twice', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'Updated twice')
  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests[1].filter((message) => (
      message.role === 'system' && message.content.includes('[LIVE STEERING UPDATE CONTRACT]')
    )).map((message) => message.content),
    [requests[0].find((message) => message.content.includes('[LIVE STEERING UPDATE CONTRACT]')).content],
  )
  assert.ok(requests[1].some((message) => message.role === 'user' && message.content === 'Direction 1'))
  assert.ok(requests[1].some((message) => message.role === 'user' && message.content === 'Direction 2'))
})

test('checkpoint tool calls are completed before the loop claims new steering', async () => {
  const events = []
  const readFile = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'read_file')
  assert.ok(readFile)

  const checkpoint = {
    messages: [
      { role: 'user', content: 'Resume the durable tool call' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'restored-read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        }],
      },
    ],
    toolCalls: [{
      id: 'restored-read',
      name: 'read_file',
      args: { path: 'README.md' },
      argumentsText: '{"path":"README.md"}',
      parseError: null,
      checkpointStatus: 'pending',
      checkpointApprovalId: null,
    }],
    artifactIds: [],
    appliedSteeringIds: [],
    iterations: 0,
  }

  const result = await baseRun({
    toolSpecs: [readFile],
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async () => true,
    executeTool: async () => {
      events.push('execute')
      return { ok: true, content: 'README contents' }
    },
    claimSteering: async () => {
      events.push('claim')
      return { leaseId: null, messages: [] }
    },
    runModel: async () => ({ content: 'Recovered answer', toolCalls: [] }),
  })

  assert.equal(result.text, 'Recovered answer')
  assert.deepEqual(events.slice(0, 2), ['execute', 'claim'])
  assert.equal(events.filter((event) => event === 'execute').length, 1)
})

test('a racing steering update defers an interrupted result and gets a recovery model round', async () => {
  const readFile = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'read_file')
  const acknowledged = []
  let claims = 0
  let modelCalls = 0
  let completionChecks = 0

  const result = await baseRun({
    toolSpecs: [readFile],
    claimSteering: async () => {
      claims += 1
      if (claims === 3) {
        return {
          leaseId: 'interrupt-recovery-lease',
          messages: [{ id: 'interrupt-recovery-steering', content: 'Recover with this direction' }],
        }
      }
      return { leaseId: null, messages: [] }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'interrupt-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          }],
        }
      }
      if (modelCalls === 2) throw new Error('transient model failure')
      assert.ok(messages.some((message) => message.content === 'Recover with this direction'))
      return { content: 'Recovered after steering', toolCalls: [] }
    },
    executeTool: async () => ({ ok: true, content: 'README contents' }),
    beforeFinalCompletion: async () => {
      completionChecks += 1
      return { closed: completionChecks > 1 }
    },
    saveCheckpoint: async () => true,
    acknowledgeSteering: async (leaseId) => acknowledged.push(leaseId),
  })

  assert.equal(result.text, 'Recovered after steering')
  assert.equal(result.interrupted, undefined)
  assert.equal(modelCalls, 3)
  assert.equal(completionChecks, 2)
  assert.deepEqual(acknowledged, ['interrupt-recovery-lease'])
})

test('a racing steering update answers clarification before the loop pauses', async () => {
  const clarification = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'request_clarification')
  let claims = 0
  let modelCalls = 0
  let completionChecks = 0

  const result = await baseRun({
    toolSpecs: [clarification],
    claimSteering: async () => {
      claims += 1
      if (claims === 2) {
        return {
          leaseId: 'clarification-answer-lease',
          messages: [{ id: 'clarification-answer', content: 'Use TypeScript' }],
        }
      }
      return { leaseId: null, messages: [] }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'ask-language',
            type: 'function',
            function: {
              name: 'request_clarification',
              arguments: '{"question":"TypeScript or JavaScript?","options":["TypeScript","JavaScript"]}',
            },
          }],
        }
      }
      assert.ok(messages.some((message) => message.content === 'Use TypeScript'))
      return { content: 'Continuing with TypeScript', toolCalls: [] }
    },
    beforeFinalCompletion: async () => {
      completionChecks += 1
      return { closed: completionChecks > 1 }
    },
    saveCheckpoint: async () => true,
    acknowledgeSteering: async () => {},
  })

  assert.equal(result.text, 'Continuing with TypeScript')
  assert.equal(result.paused, undefined)
  assert.equal(modelCalls, 2)
  assert.equal(completionChecks, 2)
})

for (const failure of ['gate', 'save']) {
  test(`${failure} failure releases the claimed steering lease`, async () => {
    const released = []
    const error = new Error(`${failure} failed`)

    await assert.rejects(() => baseRun({
      claimSteering: async () => ({
        leaseId: `lease-${failure}-failure`,
        messages: [{ id: `steering-${failure}-failure`, content: 'Do not lose this' }],
      }),
      runModel: async () => ({ content: 'Candidate answer', toolCalls: [] }),
      beforeFinalCompletion: async () => {
        if (failure === 'gate') throw error
        return { closed: false }
      },
      saveCheckpoint: async () => {
        if (failure === 'save') throw error
        return true
      },
      releaseSteering: async (leaseId) => released.push(leaseId),
    }), error)

    assert.deepEqual(released, [`lease-${failure}-failure`])
  })
}
