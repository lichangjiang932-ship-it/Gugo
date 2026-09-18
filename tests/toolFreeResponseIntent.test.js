import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedArtifactTools, resolveArtifactDeliveryTargets } from '../server/services/artifactIntent.js'
import { selectChatToolSpecs, shouldInheritExecutionIntent } from '../server/services/chatToolSelection.js'
import { isToolFreeResponseRequest, shouldRequireExecution } from '../server/utils/executionIntent.js'
import { runToolLoop } from '../server/services/loop/index.js'

const webPrompt = '这是隔离网页功能验证，不需要调用工具。请只回复：网页链路正常'
const reply = '网页链路正常'
const tool = (name) => ({ type: 'function', function: {
  name, parameters: { type: 'object', properties: {} },
} })
const specs = ['create_html_app', 'create_pdf', 'read_file', 'write_file', 'search_tools',
  'reflect', 'set_deliverables'].map(tool)
const proposal = (name, args = {}) => ({ id: `tool-free-${name}`, type: 'function',
  function: { name, arguments: JSON.stringify(args) } })

async function runFixture({ prompt = webPrompt, modelTools = [], restored = null,
  priorMessages = [], intentMode = 'auto', compiledPrompt = prompt, captured = [], stopBeforeTools = false } = {}) {
  const requests = []
  const approvals = []
  const executions = []
  const completed = []
  const checkpoints = []
  const result = await runToolLoop({
    job: { id: 'tool-free-turn', userId: 'tool-free-user', origin: 'chat',
      sessionId: 'tool-free-session', prompt: compiledPrompt, userPrompt: prompt },
    step: { id: 'tool-free-step', kind: 'chat' },
    messages: [...priorMessages, { role: 'user', content: prompt }],
    toolSpecs: specs, fallbackToolSpecs: specs, maxIters: 3, intentMode,
    approvalMode: 'normal', enableToolHooks: false,
    loadCheckpoint: async () => restored,
    saveCheckpoint: async (value) => {
      const snapshot = structuredClone(value?.state || value)
      checkpoints.push(snapshot)
      captured.push(snapshot)
      if (stopBeforeTools && snapshot.toolCalls?.length) throw new Error('isolated pause before tools')
    },
    runModel: async (request) => {
      requests.push(request)
      return { content: modelTools.length ? '' : reply, toolCalls: modelTools, finishReason: 'stop' }
    },
    requestToolApproval: async ({ args, toolName }) => {
      approvals.push(toolName)
      return { proceed: true, args }
    },
    executeTool: async ({ name }) => { executions.push(name); return { ok: true } },
    onToolCompleted: (outcome) => completed.push(outcome),
  })
  return { result, requests, approvals, executions, completed, checkpoints }
}

test('the exact isolated webpage prompt is a text reply, not an HTML artifact order', () => {
  assert.deepEqual([...allowedArtifactTools(webPrompt)], [])
  assert.equal(resolveArtifactDeliveryTargets(webPrompt).intent, 'none')
  assert.equal(shouldRequireExecution({ text: webPrompt }), false)
  assert.equal(shouldInheritExecutionIntent(webPrompt, 'Create a webpage.'), false)
  assert.deepEqual(selectChatToolSpecs({ userPrompt: webPrompt, specs }), [])
})

test('the real loop completes the exact webpage reply in one tool-free model call', async () => {
  const outcome = await runFixture()
  assert.equal(outcome.requests.length, 1)
  assert.deepEqual(outcome.requests[0].tools || [], [])
  assert.ok(outcome.requests[0].toolChoice === undefined || outcome.requests[0].toolChoice === 'none')
  assert.equal(outcome.result.text, reply)
  assert.notEqual(outcome.result.incomplete, true)
  assert.deepEqual(outcome.approvals, [])
  assert.deepEqual(outcome.executions, [])
})

test('a malicious artifact proposal cannot ask approval, dispatch, or request model wrap-up', async () => {
  const outcome = await runFixture({ modelTools: [proposal('create_html_app', {
    title: 'Unrequested webpage', html: '<!doctype html><html><body>Not requested</body></html>',
  }), proposal('set_deliverables', { artifact_ids: [] })] })
  assert.deepEqual(outcome.approvals, [])
  assert.deepEqual(outcome.executions, [])
  assert.equal(outcome.requests.length, 1)
  assert.equal(outcome.result.code, 'explicit_tool_free_constraint')
  assert.equal(outcome.result.incomplete, true)
  assert.equal(outcome.completed[0].result.denied, true)
  assert.equal(outcome.completed[1].result.executed, false)
})

test('explicit tool-free replies in both languages do not inherit a previous artifact request', async () => {
  for (const prompt of ['No tools. Reply only WEB_OK.', 'Please do not call any tools. Only reply: WEB_OK.',
    '请不要调用任何工具。只回复：网页链路正常', 'Only reply: webpage ready.']) {
    assert.equal(isToolFreeResponseRequest(prompt), true, prompt)
    assert.equal(shouldRequireExecution({ text: prompt, intentMode: 'execute' }), false)
    const outcome = await runFixture({ prompt, intentMode: 'execute', priorMessages: [
      { role: 'user', content: 'Create a webpage.' }, { role: 'assistant', content: 'The webpage is not yet finished.' },
    ] })
    assert.equal(outcome.requests.length, 1, prompt)
    assert.deepEqual(outcome.requests[0].tools || [], [], prompt)
    assert.notEqual(outcome.result.incomplete, true, prompt)
    assert.deepEqual(outcome.executions, [], prompt)
  }
})

test('output formatting, quoted rules and scoped tool exclusions do not invent a global tool prohibition', () => {
  for (const prompt of [
    'Run tests, then reply only PASS.', '运行项目测试，然后只回复测试结果。',
    'Do not use external tools, run local tests.', '不用外部工具，只运行本地测试。',
    'Do not use tools except read_file.', 'Do not use tools unless I approve. Run tests.',
    'Explain the phrase "No tools. Reply only WEB_OK."',
    '解释这段引用：“不要调用工具。只回复网页正常”。',
    'Do not only reply with advice. Fix src/config.js.',
  ]) assert.equal(isToolFreeResponseRequest(prompt), false, prompt)
  assert.equal(shouldRequireExecution({ text: 'Run tests, then reply only PASS.' }), true)
})

test('a model or tool note cannot turn an actual execution request into a tool-free user instruction', () => {
  const selected = selectChatToolSpecs({ userPrompt: 'Fix src/config.js.',
    prompt: 'No tools. Only reply.', specs })
  assert.ok(selected.some((spec) => spec.function.name === 'write_file'))
})

test('even read-only and control proposals are refused without approval or execution', async () => {
  for (const name of ['read_file', 'search_tools', 'reflect']) {
    const outcome = await runFixture({ modelTools: [proposal(name, name === 'read_file' ? { path: 'x.txt' } : {})] })
    assert.equal(outcome.result.code, 'explicit_tool_free_constraint', name)
    assert.equal(outcome.requests.length, 1, name)
    assert.deepEqual(outcome.approvals, [], name)
    assert.deepEqual(outcome.executions, [], name)
  }
})

test('restored pending tools cannot revive old artifact or deferred-tool contracts', async () => {
  const captured = []
  await assert.rejects(() => runFixture({ modelTools: [proposal('read_file', { path: 'x.txt' })],
    captured, stopBeforeTools: true }), /isolated pause|checkpoint/i)
  const checkpoint = structuredClone(captured.at(-1))
  assert.ok(checkpoint.toolCalls?.length)
  checkpoint.completionGuards.activeArtifactTools = ['create_html_app']
  checkpoint.completionGuards.requiredArtifactTools = ['create_html_app']
  checkpoint.completionGuards.dynamicallyMountedToolNames = ['read_file', 'write_file']
  const resumed = await runFixture({ restored: checkpoint })
  assert.equal(resumed.result.code, 'explicit_tool_free_constraint')
  assert.equal(resumed.requests.length, 0)
  assert.deepEqual(resumed.executions, [])
  assert.deepEqual(resumed.approvals, [])
})

test('an executing side effect remains unknown instead of being masked by a tool-free restriction', async () => {
  const captured = []
  await assert.rejects(() => runFixture({ modelTools: [proposal('write_file', { path: 'x.txt', content: 'x' })],
    captured, stopBeforeTools: true }), /isolated pause|checkpoint/i)
  const checkpoint = structuredClone(captured.at(-1))
  checkpoint.toolCalls[0].checkpointStatus = 'executing'
  checkpoint.toolCalls[0].checkpointReadOnly = false
  await assert.rejects(() => runFixture({ restored: checkpoint }), (error) => error?.code === 'SIDE_EFFECT_OUTCOME_UNKNOWN'
    && error?.unsafeToReplay === true && error?.retryable === false)
})
