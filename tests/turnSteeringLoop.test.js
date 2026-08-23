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
  const events = []

  const result = await baseRun({
    claimSteering: async () => ({
      leaseId: 'lease-checkpoint-order',
      messages: [{ id: 'steering-checkpoint-order', content: 'Apply this update' }],
    }),
    runModel: async () => ({ content: 'Applied', toolCalls: [] }),
    saveCheckpoint: async (state) => {
      events.push({ type: 'save', state: structuredClone(state) })
      return true
    },
    acknowledgeSteering: async (leaseId) => events.push({ type: 'ack', leaseId }),
  })

  assert.equal(result.text, 'Applied')
  assert.equal(events.filter((event) => event.type === 'ack').length, 1)

  const acknowledgeIndex = events.findIndex((event) => event.type === 'ack')
  const steeringCheckpointIndex = events.findIndex((event) => (
    event.type === 'save'
      && event.state.appliedSteeringIds?.includes('steering-checkpoint-order')
  ))
  const inFlightCheckpointIndex = events.findIndex((event) => (
    event.type === 'save' && event.state.modelInvocation?.status === 'in_flight'
  ))

  assert.ok(steeringCheckpointIndex >= 0)
  assert.ok(steeringCheckpointIndex < acknowledgeIndex)
  assert.ok(inFlightCheckpointIndex >= 0)
  assert.ok(inFlightCheckpointIndex < acknowledgeIndex)
  assert.equal(events[acknowledgeIndex].leaseId, 'lease-checkpoint-order')
})

test('an already-applied steering id is acknowledged without duplicate context injection', async () => {
  const readFile = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'read_file')
  const acknowledged = []
  const requests = []
  let claims = 0

  const result = await baseRun({
    toolSpecs: [readFile],
    saveCheckpoint: async () => true,
    claimSteering: async () => {
      claims += 1
      return {
        leaseId: `duplicate-steering-lease-${claims}`,
        messages: [{ id: 'same-steering-id', content: 'Use the same direction once.' }],
      }
    },
    acknowledgeSteering: async (leaseId) => acknowledged.push(leaseId),
    executeTool: async () => ({ ok: true, content: 'README contents' }),
    runModel: async ({ messages }) => {
      requests.push(structuredClone(messages))
      if (requests.length === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'dedupe-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          }],
        }
      }
      return { content: 'Applied once.', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'Applied once.')
  assert.equal(requests[1].filter((message) => message.content === 'Use the same direction once.').length, 1)
  assert.deepEqual(acknowledged, ['duplicate-steering-lease-1', 'duplicate-steering-lease-2'])
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

test('live artifact correction cancels an obsolete image generator and clears its forced retry', async () => {
  const prompt = '生成图片并做网站'
  const correction = '纠正：只使用已有本地图片制作网站，不要生成任何新图片'
  const modelRequests = []
  const checkpoints = []
  const executions = []
  let claims = 0

  const result = await baseRun({
    job: {
      id: 'steering-artifact-contract',
      userId: 'turn-steering-user',
      title: 'Steering artifact contract',
      prompt,
      userPrompt: prompt,
    },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    intentMode: 'execute',
    maxIters: 7,
    claimSteering: async () => {
      claims += 1
      // The runtime checks steering both before model calls and immediately
      // before mutating/artifact tools. Wait until the old image recovery has
      // actually been scheduled, then correct that contract.
      if (claims !== 4) return { leaseId: null, messages: [] }
      return {
        leaseId: 'artifact-contract-correction-lease',
        messages: [{ id: 'artifact-contract-correction', content: correction }],
      }
    },
    acknowledgeSteering: async () => {},
    saveCheckpoint: async (state) => {
      checkpoints.push(structuredClone(state))
      return true
    },
    executeTool: async ({ name }) => {
      executions.push(name)
      assert.equal(name, 'create_html_app')
      return {
        ok: true,
        artifactId: 'steered-html-artifact',
        filename: 'steered.html',
        url: '/api/artifacts/steered.html',
      }
    },
    runModel: async (request) => {
      modelRequests.push({
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
        toolChoice: request.toolChoice ? structuredClone(request.toolChoice) : null,
      })
      const call = modelRequests.length
      if (call === 1) {
        assert.ok(request.tools.some((spec) => spec?.function?.name === 'generate_image'))
        return {
          content: '',
          toolCalls: [{
            id: 'steered-html-create',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Existing image site',
                html: '<!doctype html><html><body><main>Existing image</main></body></html>',
              }),
            },
          }],
        }
      }
      if (call === 2) return { content: 'Both files are ready.', toolCalls: [] }

      const visibleNames = request.tools.map((spec) => spec?.function?.name)
      const context = request.messages.map((message) => String(message?.content || '')).join('\n')
      assert.ok(visibleNames.includes('create_html_app'))
      assert.equal(visibleNames.includes('generate_image'), false)
      assert.notEqual(request.toolChoice?.function?.name, 'generate_image')
      assert.equal(context.includes('must successfully call: generate_image'), false)
      assert.equal(context.includes('Call each missing artifact generator now: generate_image'), false)
      assert.ok(context.includes('Cancelled artifact generators: generate_image'))
      return { content: '已使用现有图片完成网页。', toolCalls: [] }
    },
  })

  assert.equal(result.text, '已使用现有图片完成网页。')
  assert.deepEqual(executions, ['create_html_app'])
  assert.ok(modelRequests.length >= 3)
  assert.ok(checkpoints.some((state) => (
    state.completionGuards?.artifactContractText === correction
      && state.completionGuards?.activeArtifactTools?.join(',') === 'create_html_app'
      && !state.completionGuards?.forcedArtifactToolName
  )))
})

test('style-only live steering preserves every existing artifact deliverable', async () => {
  const prompt = '生成一个网站和一份 PPT'
  const steering = 'PPT 不要动画，网站继续完善配色'
  const modelRequests = []
  const executions = []
  let claims = 0

  const result = await baseRun({
    job: {
      id: 'steering-style-preserves-artifacts',
      userId: 'turn-steering-user',
      title: 'Style steering preserves artifacts',
      prompt,
      userPrompt: prompt,
    },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    intentMode: 'execute',
    maxIters: 4,
    claimSteering: async () => {
      claims += 1
      if (claims !== 1) return { leaseId: null, messages: [] }
      return {
        leaseId: 'style-steering-lease',
        messages: [{ id: 'style-steering', content: steering }],
      }
    },
    acknowledgeSteering: async () => {},
    saveCheckpoint: async () => true,
    executeTool: async ({ name }) => {
      executions.push(name)
      return {
        ok: true,
        artifactId: `style-${name}`,
        filename: name === 'create_html_app' ? 'style.html' : 'style.pptx',
        url: `/api/artifacts/style-${name}`,
      }
    },
    runModel: async (request) => {
      modelRequests.push({
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
        toolChoice: request.toolChoice ? structuredClone(request.toolChoice) : null,
      })
      const names = request.tools.map((spec) => spec?.function?.name)
      assert.ok(names.includes('create_html_app'))
      assert.ok(names.includes('create_pptx'))
      if (modelRequests.length === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'style-html-create',
              function: {
                name: 'create_html_app',
                arguments: JSON.stringify({
                  title: 'Style website',
                  html: '<!doctype html><html><body><main>Style</main></body></html>',
                }),
              },
            },
            {
              id: 'style-pptx-create',
              function: {
                name: 'create_pptx',
                arguments: JSON.stringify({ title: 'Style deck', slides: [{ title: 'Style' }] }),
              },
            },
          ],
        }
      }
      return { content: '网站和 PPT 均已完成。', toolCalls: [] }
    },
  })

  assert.equal(result.text, '网站和 PPT 均已完成。')
  assert.deepEqual(executions.sort(), ['create_html_app', 'create_pptx'])
})

for (const steering of [
  '不要生成任何新图片，继续完成网站',
  '别生成图片，继续完成网站',
  '别再生成图片，继续完成网站',
  '不用生成图片，继续完成网站',
  '不需要生成图片，继续完成网站',
]) {
test(`live steering can cancel only image generation with ${steering.split('，')[0]}`, async () => {
  const prompt = '生成图片并做网站'
  const modelRequests = []
  const executions = []
  let claims = 0

  const result = await baseRun({
    job: {
      id: 'steering-cancel-one-artifact',
      userId: 'turn-steering-user',
      title: 'Cancel one artifact',
      prompt,
      userPrompt: prompt,
    },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    intentMode: 'execute',
    maxIters: 4,
    claimSteering: async () => {
      claims += 1
      if (claims !== 1) return { leaseId: null, messages: [] }
      return {
        leaseId: 'cancel-image-steering-lease',
        messages: [{ id: 'cancel-image-steering', content: steering }],
      }
    },
    acknowledgeSteering: async () => {},
    saveCheckpoint: async () => true,
    executeTool: async ({ name }) => {
      executions.push(name)
      assert.equal(name, 'create_html_app')
      return {
        ok: true,
        artifactId: 'cancel-image-html',
        filename: 'cancel-image.html',
        url: '/api/artifacts/cancel-image.html',
      }
    },
    runModel: async (request) => {
      modelRequests.push({
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
        toolChoice: request.toolChoice ? structuredClone(request.toolChoice) : null,
      })
      const names = request.tools.map((spec) => spec?.function?.name)
      assert.ok(names.includes('create_html_app'))
      assert.equal(names.includes('generate_image'), false)
      assert.notEqual(request.toolChoice?.function?.name, 'generate_image')
      if (modelRequests.length === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'cancel-image-html-create',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Existing image website',
                html: '<!doctype html><html><body><main>Existing image</main></body></html>',
              }),
            },
          }],
        }
      }
      return { content: '已使用现有图片完成网站。', toolCalls: [] }
    },
  })

  assert.equal(result.text, '已使用现有图片完成网站。')
  assert.deepEqual(executions, ['create_html_app'])
})
}

for (const scenario of [
  { label: 'drive root', steering: '补充：写到 E 盘' },
  { label: 'absolute directory', steering: '补充：写到 E:\\交付网站' },
]) {
  test(`live steering updates the enforced artifact output target for ${scenario.label}`, async () => {
    const prompt = '生成一个网站'
    const checkpoints = []
    let claimed = false
    let modelCalls = 0
    let executions = 0

    const result = await baseRun({
      job: {
        id: `steering-output-${scenario.label}`,
        userId: 'turn-steering-user',
        title: 'Steering output target',
        prompt,
        userPrompt: prompt,
      },
      messages: [{ role: 'user', content: prompt }],
      toolSpecs: SERVER_TOOL_SPECS,
      intentMode: 'execute',
      maxIters: 4,
      claimSteering: async () => {
        if (claimed) return { leaseId: null, messages: [] }
        claimed = true
        return {
          leaseId: `output-${scenario.label}-lease`,
          messages: [{ id: `output-${scenario.label}-steering`, content: scenario.steering }],
        }
      },
      acknowledgeSteering: async () => {},
      saveCheckpoint: async (state) => {
        checkpoints.push(structuredClone(state))
        return true
      },
      executeTool: async ({ name, job }) => {
        executions += 1
        assert.equal(name, 'create_html_app')
        assert.equal(job.userPrompt, scenario.steering)
        return {
          ok: true,
          artifactId: `steered-output-${scenario.label}`,
          filename: 'steered-output.html',
          url: '/api/artifacts/steered-output.html',
        }
      },
      runModel: async ({ messages }) => {
        modelCalls += 1
        assert.ok(messages.some((message) => message.role === 'user' && message.content === scenario.steering))
        if (modelCalls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: `create-output-${scenario.label}`,
              function: {
                name: 'create_html_app',
                arguments: JSON.stringify({
                  title: 'Steered output',
                  html: '<!doctype html><html><body><main>Ready</main></body></html>',
                }),
              },
            }],
          }
        }
        return { content: '网站已生成并保存到指定位置。', toolCalls: [] }
      },
    })

    assert.equal(result.text, '网站已生成并保存到指定位置。')
    assert.equal(executions, 1)
    assert.ok(checkpoints.some((state) => (
      state.completionGuards?.artifactOutputPrompt === scenario.steering
    )))
  })
}

test('checkpoint resume keeps the latest steered artifact contract instead of reviving the original image requirement', async () => {
  const prompt = '生成图片并做网站'
  const correction = '纠正：只使用已有本地图片制作网站，不要生成任何新图片'
  const modelRequests = []
  const checkpoint = {
    messages: [
      { role: 'user', content: prompt },
      { role: 'user', content: correction },
    ],
    toolCalls: [],
    artifactIds: [],
    appliedSteeringIds: ['artifact-contract-correction'],
    iterations: 0,
    completionGuards: {
      activeArtifactTools: ['create_html_app'],
      requiredArtifactTools: ['create_html_app'],
      artifactContractText: correction,
      artifactProvenance: [],
      artifactDeliveryRetries: 0,
    },
  }

  const result = await baseRun({
    job: {
      id: 'steering-artifact-contract-resume',
      userId: 'turn-steering-user',
      title: 'Resume steering artifact contract',
      prompt,
      userPrompt: prompt,
    },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    intentMode: 'execute',
    maxIters: 4,
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async () => true,
    executeTool: async () => ({
      ok: true,
      artifactId: 'resumed-steered-html',
      filename: 'resumed-steered.html',
      url: '/api/artifacts/resumed-steered.html',
    }),
    runModel: async (request) => {
      modelRequests.push({
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
        toolChoice: request.toolChoice ? structuredClone(request.toolChoice) : null,
      })
      const names = request.tools.map((spec) => spec?.function?.name)
      assert.ok(names.includes('create_html_app'))
      assert.equal(names.includes('generate_image'), false)
      assert.notEqual(request.toolChoice?.function?.name, 'generate_image')
      if (modelRequests.length === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'resumed-html-create',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Resumed site',
                html: '<!doctype html><html><body><main>Resumed</main></body></html>',
              }),
            },
          }],
        }
      }
      return { content: '恢复后网页已完成。', toolCalls: [] }
    },
  })

  assert.equal(result.text, '恢复后网页已完成。')
  assert.deepEqual(result.artifactIds, ['resumed-steered-html'])
  assert.ok(modelRequests.every((request) => (
    !request.messages.some((message) => String(message?.content || '').includes('Call each missing artifact generator now: generate_image'))
  )))
})

test('checkpoint resume keeps optional artifact tools available without forcing them as deliverables', async () => {
  const prompt = '生成图片并做网站'
  const correction = '继续制作网站；已有图片够用，如确实需要可以使用图片工具'
  const modelRequests = []
  const executions = []
  const checkpoint = {
    messages: [
      { role: 'user', content: prompt },
      { role: 'user', content: correction },
    ],
    toolCalls: [],
    artifactIds: [],
    appliedSteeringIds: ['artifact-contract-optional-image'],
    iterations: 0,
    completionGuards: {
      activeArtifactTools: ['create_html_app', 'generate_image'],
      requiredArtifactTools: ['create_html_app'],
      artifactContractText: correction,
      artifactProvenance: [],
      artifactDeliveryRetries: 0,
    },
  }

  const result = await baseRun({
    job: {
      id: 'steering-artifact-contract-optional-resume',
      userId: 'turn-steering-user',
      title: 'Resume optional artifact tool contract',
      prompt,
      userPrompt: prompt,
    },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS,
    intentMode: 'execute',
    maxIters: 5,
    loadCheckpoint: async () => ({ state: checkpoint }),
    saveCheckpoint: async () => true,
    executeTool: async ({ name }) => {
      executions.push(name)
      assert.equal(name, 'create_html_app')
      return {
        ok: true,
        artifactId: 'optional-tool-resumed-html',
        filename: 'optional-tool-resumed.html',
        url: '/api/artifacts/optional-tool-resumed.html',
      }
    },
    runModel: async (request) => {
      modelRequests.push({
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
        toolChoice: request.toolChoice ? structuredClone(request.toolChoice) : null,
      })
      const names = request.tools.map((spec) => spec?.function?.name)
      const context = request.messages.map((message) => String(message?.content || '')).join('\n')
      assert.ok(names.includes('create_html_app'))
      assert.ok(names.includes('generate_image'))
      assert.notEqual(request.toolChoice?.function?.name, 'generate_image')
      assert.equal(context.includes('Call each missing artifact generator now: generate_image'), false)
      assert.equal(context.includes('must successfully call: generate_image'), false)

      if (modelRequests.length === 1) {
        return { content: '网站已经完成。', toolCalls: [] }
      }
      if (modelRequests.length === 2) {
        assert.equal(request.toolChoice?.function?.name, 'create_html_app')
        return {
          content: '',
          toolCalls: [{
            id: 'optional-tool-html-create',
            function: {
              name: 'create_html_app',
              arguments: JSON.stringify({
                title: 'Optional image tool site',
                html: '<!doctype html><html><body><main>Existing image</main></body></html>',
              }),
            },
          }],
        }
      }
      return { content: '恢复后网页已完成并验证。', toolCalls: [] }
    },
  })

  assert.equal(result.text, '恢复后网页已完成并验证。')
  assert.deepEqual(executions, ['create_html_app'])
  assert.deepEqual(result.artifactIds, ['optional-tool-resumed-html'])
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

test('tool-boundary steering supersedes unstarted siblings after a durable checkpoint', async () => {
  const readFile = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'read_file')
  const writeFile = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'write_file')
  const executed = []
  const checkpointOrder = []
  const steeringCheckpoints = []
  let claims = 0
  let modelCalls = 0

  const result = await baseRun({
    intentMode: 'execute',
    toolSpecs: [readFile, writeFile],
    claimSteering: async () => {
      claims += 1
      if (claims === 2) {
        return {
          leaseId: 'boundary-steering-lease',
          messages: [{ id: 'boundary-steering-id', content: 'Do not write the file; summarize the read instead.' }],
        }
      }
      return { leaseId: null, messages: [] }
    },
    acknowledgeSteering: async (leaseId) => checkpointOrder.push(`ack:${leaseId}`),
    releaseSteering: async () => assert.fail('a successful boundary checkpoint must not release its lease'),
    saveCheckpoint: async (state) => {
      const superseded = state.toolCalls.find((call) => (
        call.checkpointResult?.code === 'tool_execution_superseded_by_steering'
      ))
      if (superseded) {
        checkpointOrder.push('save:steering')
        steeringCheckpoints.push(structuredClone(state))
      }
      return true
    },
    executeTool: async ({ name, args }) => {
      executed.push(name)
      return { ok: true, path: args.path, content: 'project notes' }
    },
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'boundary-read',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            },
            {
              id: 'boundary-write',
              type: 'function',
              function: { name: 'write_file', arguments: '{"path":"stale.txt","content":"stale"}' },
            },
          ],
        }
      }

      const readResultIndex = messages.findIndex((message) => message.tool_call_id === 'boundary-read')
      const skippedResultIndex = messages.findIndex((message) => message.tool_call_id === 'boundary-write')
      const steeringIndex = messages.findIndex((message) => (
        message.role === 'user' && message.content === 'Do not write the file; summarize the read instead.'
      ))
      assert.ok(readResultIndex >= 0)
      assert.equal(skippedResultIndex, readResultIndex + 1)
      assert.ok(steeringIndex > skippedResultIndex)
      assert.equal(JSON.parse(messages[skippedResultIndex].content).code, 'tool_execution_superseded_by_steering')
      return { content: 'Read summarized without writing.', toolCalls: [] }
    },
  })

  assert.equal(result.text, 'Read summarized without writing.')
  assert.deepEqual(executed, ['read_file'])
  assert.equal(modelCalls, 2)
  assert.equal(steeringCheckpoints.length, 1)
  assert.deepEqual(steeringCheckpoints[0].appliedSteeringIds, ['boundary-steering-id'])
  assert.equal(steeringCheckpoints[0].toolCalls[1].checkpointResult.executed, false)
  assert.equal(steeringCheckpoints[0].failureRecovery.count, 0)
  assert.deepEqual(steeringCheckpoints[0].progress.completedCallIds, ['boundary-read', 'boundary-write'])
  assert.deepEqual(checkpointOrder.slice(0, 2), ['save:steering', 'ack:boundary-steering-lease'])
})

test('tool-boundary steering releases its lease when the durable checkpoint fails', async () => {
  const readFile = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'read_file')
  const writeFile = SERVER_TOOL_SPECS.find((spec) => spec?.function?.name === 'write_file')
  const released = []
  let claims = 0

  await assert.rejects(() => baseRun({
    intentMode: 'execute',
    toolSpecs: [readFile, writeFile],
    claimSteering: async () => {
      claims += 1
      return claims === 2
        ? {
            leaseId: 'boundary-save-failure-lease',
            messages: [{ id: 'boundary-save-failure-id', content: 'Stop the remaining calls.' }],
          }
        : { leaseId: null, messages: [] }
    },
    acknowledgeSteering: async () => assert.fail('failed checkpoint must not be acknowledged'),
    releaseSteering: async (leaseId) => released.push(leaseId),
    saveCheckpoint: async (state) => {
      if (state.toolCalls.some((call) => (
        call.checkpointResult?.code === 'tool_execution_superseded_by_steering'
      ))) throw new Error('boundary checkpoint failed')
      return true
    },
    executeTool: async ({ args }) => ({ ok: true, path: args.path, content: 'read' }),
    runModel: async () => ({
      content: '',
      toolCalls: [
        {
          id: 'boundary-failure-read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        },
        {
          id: 'boundary-failure-write',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"stale.txt","content":"stale"}' },
        },
      ],
    }),
  }), (error) => {
    assert.equal(error?.code, 'CHECKPOINT_FLUSH_FAILED')
    assert.equal(error?.retryable, true)
    assert.match(error?.cause?.message || '', /boundary checkpoint failed/)
    return true
  })

  assert.deepEqual(released, ['boundary-save-failure-lease'])
})

for (const [toolName, args] of [
  ['write_file', { path: 'stale.txt', content: 'stale' }],
  ['patch_file', { path: 'stale.txt', start_line: 1, end_line: 1, replacement: 'stale' }],
  ['file_download', { url: 'https://example.com/stale.txt', path: 'stale.txt' }],
  ['bash_exec', { command: 'node stale-script.js' }],
  ['git_commit', { message: 'stale commit', files: ['stale.txt'] }],
  ['git_push', {}],
  ['git_write', { action: 'commit', message: 'stale commit', files: ['stale.txt'] }],
  ['create_docx', { title: 'Stale document', paragraphs: ['stale'] }],
]) {
  test(`steering queued during model execution supersedes the first unstarted ${toolName} call`, async () => {
    const spec = SERVER_TOOL_SPECS.find((candidate) => candidate?.function?.name === toolName)
    assert.ok(spec, `${toolName} must be registered in the server tool catalog`)
    const executed = []
    const acknowledged = []
    let modelCalls = 0
    let steeringAvailable = false
    let steeringClaimed = false

    const result = await baseRun({
      toolSpecs: [spec],
      saveCheckpoint: async () => true,
      claimSteering: async () => {
        if (!steeringAvailable || steeringClaimed) return { leaseId: null, messages: [] }
        steeringClaimed = true
        return {
          leaseId: `pre-${toolName}-lease`,
          messages: [{ id: `pre-${toolName}-steering`, content: 'Stop before making any changes.' }],
        }
      },
      acknowledgeSteering: async (leaseId) => acknowledged.push(leaseId),
      executeTool: async ({ name }) => {
        executed.push(name)
        return { ok: true }
      },
      runModel: async ({ messages }) => {
        modelCalls += 1
        if (modelCalls === 1) {
          steeringAvailable = true
          return {
            content: '',
            toolCalls: [{
              id: `stale-${toolName}`,
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(args) },
            }],
          }
        }
        const skipped = messages.find((message) => message.tool_call_id === `stale-${toolName}`)
        assert.ok(skipped)
        assert.equal(JSON.parse(skipped.content).code, 'tool_execution_superseded_by_steering')
        assert.ok(messages.some((message) => (
          message.role === 'user' && message.content === 'Stop before making any changes.'
        )))
        return { content: 'Stopped before making changes.', toolCalls: [] }
      },
    })

    assert.equal(result.text, 'Stopped before making changes.')
    assert.deepEqual(executed, [])
    assert.deepEqual(acknowledged, [`pre-${toolName}-lease`])
  })
}

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
    }), (caught) => {
      if (failure === 'save') {
        assert.equal(caught?.code, 'CHECKPOINT_FLUSH_FAILED')
        assert.equal(caught?.retryable, true)
        assert.equal(caught?.cause, error)
      } else {
        assert.equal(caught, error)
      }
      return true
    })

    assert.deepEqual(released, [`lease-${failure}-failure`])
  })
}
