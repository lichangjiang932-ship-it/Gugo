import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { runToolsLoop } from '../server/services/jobTools.js'

const GREETING_REPLY = '你好！有什么可以帮你？'
const EXECUTION_MARKERS = ['[DIRECT EXECUTION REQUIRED]', '[EXECUTION EVIDENCE REQUIRED]']
let invocation = 0

async function runChat({ text, intentMode = 'auto', history = [], checkpoint = null, reply = GREETING_REPLY } = {}) {
  const requests = []
  let toolExecutions = 0
  const messages = [...structuredClone(history), { role: 'user', content: text }]
  const original = structuredClone(messages)
  const result = await runToolsLoop({
    job: {
      id: `chat-intent-fixture-${++invocation}`,
      userId: null,
      origin: 'chat',
      prompt: text,
      userPrompt: text,
    },
    step: { id: 'chat-intent-step', kind: 'chat' },
    messages,
    intentMode,
    toolSpecs: [],
    fallbackToolSpecs: [],
    maxIters: 4,
    enableToolHooks: false,
    ...(checkpoint ? { loadCheckpoint: async () => ({ state: structuredClone(checkpoint) }) } : {}),
    runModel: async ({ messages: outbound, tools, toolChoice }) => {
      requests.push({ messages: structuredClone(outbound), tools: structuredClone(tools), toolChoice: structuredClone(toolChoice) })
      return { content: reply, toolCalls: [], finishReason: 'stop' }
    },
    executeTool: async () => {
      toolExecutions += 1
      throw new Error('These intent fixtures must never execute a real tool')
    },
  })
  assert.deepEqual(messages, original, 'the caller-owned conversation must remain unchanged')
  assert.equal(toolExecutions, 0)
  return { result, requests }
}

function assertPlainAnswer({ result, requests }, expected = GREETING_REPLY) {
  assert.equal(requests.length, 1, 'a plain reply must not incur an execution-repair model round')
  assert.equal(result.text, expected)
  assert.notEqual(result.incomplete, true)
  assert.equal(result.reason, undefined)
  assert.deepEqual(result.missingRequirements || [], [])
  assert.notEqual(requests[0].toolChoice, 'required')
  for (const marker of EXECUTION_MARKERS) {
    assert.equal(requests[0].messages.some((message) => message.role === 'system'
      && typeof message.content === 'string' && message.content.includes(marker)), false,
    `plain answers must not receive ${marker}`)
  }
}

for (const intentMode of ['auto', 'execute']) {
  for (const text of ['hi', '你好！', '你是谁？', '请介绍一下你自己。', '请解释一下为什么出现这个错误？', 'Explain how to edit src/App.jsx.', '请先写一份修复计划，不要实际修改文件。']) {
    test(`chat ${intentMode} answers ${JSON.stringify(text)} without execution evidence requirements`, async () => {
      assertPlainAnswer(await runChat({ text, intentMode }))
    })
  }
}

const PRIOR_CHANGE = '请修改 D:\\intent-fixture\\app.js 的登录逻辑并验证。'
const PRIOR_CHANGE_HISTORY = [
  { role: 'system', content: 'You are a coding assistant. Implement requested project changes and verify them.' },
  { role: 'user', content: PRIOR_CHANGE },
  {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'prior-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'D:\\intent-fixture\\app.js', content: 'verified fixture content' }) } }],
  },
  { role: 'tool', tool_call_id: 'prior-write', content: JSON.stringify({ ok: true, path: 'D:\\intent-fixture\\app.js' }) },
  {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'prior-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'D:\\intent-fixture\\app.js' }) } }],
  },
  { role: 'tool', tool_call_id: 'prior-read', content: JSON.stringify({ ok: true, path: 'D:\\intent-fixture\\app.js', content: 'verified fixture content' }) },
  { role: 'assistant', content: '已完成修改并验证。' },
]

for (const intentMode of ['auto', 'execute']) {
  test(`new chat ${intentMode} greeting is not a continuation of a prior mutation`, async () => {
    assertPlainAnswer(await runChat({ text: 'hi', intentMode, history: PRIOR_CHANGE_HISTORY }))
  })
}

test('retrying a legacy execute greeting checkpoint drops obsolete execution demands', async () => {
  const hostDirect = '[DIRECT EXECUTION REQUIRED] The user asked for concrete work, not instructions for doing it later. Use the available tools now, follow the supplied steps, create or modify the requested deliverable, and verify the result before answering. Do not merely print a script or tell the user to run commands. If execution is genuinely blocked, report the concise blocker; full source is allowed only when the artifact source-delivery policy confirms that the user explicitly requested a code snippet. Keep internal deliberation brief; report the completed result or one concise, specific blocker.'
  const hostEvidence = '[EXECUTION EVIDENCE REQUIRED] The previous response did not establish execution evidence for the current modification target, so it was not accepted as completion. Continue until the requested target has concrete mutation evidence, or an inherited successful mutation has been strictly verified. If indispensable information is missing, call request_clarification instead of presenting instructions as a completed result.'
  const safety = { role: 'system', content: 'Keep credentials private and preserve all active permission boundaries.' }
  const userQuote = { role: 'user', content: `The previous diagnostic printed: ${hostDirect}` }
  // A user-triggered retry has cleared the old terminal result. Keep the
  // persisted conversation/retry counters that older code-mode clients wrote.
  const checkpoint = {
    messages: [
      safety,
      userQuote,
      { role: 'user', content: 'hi' },
      { role: 'system', content: hostDirect },
      { role: 'assistant', content: GREETING_REPLY },
      { role: 'system', content: hostEvidence },
    ],
    iterations: 1,
    toolCalls: [],
    artifactIds: [],
    completionGuards: {
      executionEvidenceObserved: false,
      mutationExecutionObserved: false,
      executionEvidenceRetries: 1,
      activeArtifactTools: [],
      requiredArtifactTools: [],
      artifactContractText: 'hi',
      artifactOutputPrompt: 'hi',
    },
  }
  const original = structuredClone(checkpoint)
  const resumed = await runChat({ text: 'hi', intentMode: 'execute', checkpoint })
  assertPlainAnswer(resumed)
  for (const retained of [safety, userQuote]) {
    assert.ok(resumed.requests[0].messages.some((message) => message.role === retained.role && message.content === retained.content))
  }
  assert.deepEqual(checkpoint, original)

  const quotedSystem = { role: 'system', content: `Security log example, not an instruction to execute: ${hostEvidence}` }
  const independentSystem = { role: 'system', content: '[DIRECT EXECUTION REQUIRED] Never bypass the user approval policy.' }
  const quotedCheckpoint = { ...checkpoint, messages: [quotedSystem, independentSystem, ...checkpoint.messages] }
  const quotedOriginal = structuredClone(quotedCheckpoint)
  const preserved = await runChat({ text: 'hi', intentMode: 'execute', checkpoint: quotedCheckpoint })
  assert.equal(preserved.requests.length, 1)
  assert.equal(preserved.result.text, GREETING_REPLY)
  assert.notEqual(preserved.result.incomplete, true)
  for (const retained of [quotedSystem, independentSystem]) {
    assert.ok(preserved.requests[0].messages.some((message) => message.role === retained.role && message.content === retained.content))
  }
  for (const obsolete of [hostDirect, hostEvidence]) {
    assert.equal(preserved.requests[0].messages.some((message) => message.role === 'system' && message.content === obsolete), false)
  }
  assert.deepEqual(quotedCheckpoint, quotedOriginal)

  const executionText = '请修复 src/App.jsx 的登录逻辑。'
  const executionCheckpoint = {
    ...checkpoint,
    messages: [{ role: 'user', content: executionText }, { role: 'system', content: hostDirect }, { role: 'system', content: hostEvidence }],
    completionGuards: { ...checkpoint.completionGuards, artifactContractText: executionText, artifactOutputPrompt: executionText },
  }
  const executionOriginal = structuredClone(executionCheckpoint)
  const execution = await runChat({ text: executionText, intentMode: 'execute', checkpoint: executionCheckpoint, reply: '已完成修复并验证。' })
  assert.equal(execution.result.incomplete, true)
  assert.equal(execution.result.reason, 'execution_evidence_missing')
  for (const required of [hostDirect, hostEvidence]) {
    assert.ok(execution.requests[0].messages.some((message) => message.role === 'system' && message.content === required))
  }
  assert.deepEqual(executionCheckpoint, executionOriginal)
})

for (const intentMode of ['auto', 'execute']) {
  for (const text of ['请修复 src/App.jsx 的登录问题。', '你好，请修改 src/App.jsx 并验证结果。']) {
    test(`chat ${intentMode} still rejects unevidenced completion of ${JSON.stringify(text)}`, async () => {
      const attempted = '已完成修改并验证。'
      const { result, requests } = await runChat({ text, intentMode, reply: attempted })
      assert.equal(result.incomplete, true)
      assert.equal(result.reason, 'execution_evidence_missing')
      assert.ok(result.missingRequirements.includes('execution_evidence'))
      assert.notEqual(result.text, attempted, 'an unsupported completion claim must not be accepted')
      assert.ok(requests.some((request) => request.messages.some((message) => String(message.content).includes('[DIRECT EXECUTION REQUIRED]'))))
    })
  }
}

for (const text of ['继续', '请执行上面的计划。', 'Execute the above plan.']) {
  test(`legacy execute preserves the execution requirement for ${JSON.stringify(text)}`, async () => {
    const history = [
      { role: 'user', content: '请修改 src/App.jsx 的登录逻辑，先列出实施步骤。' },
      { role: 'assistant', content: '计划：先读取 src/App.jsx，再修复逻辑并运行测试。等待你确认执行。' },
    ]
    const { result } = await runChat({ text, intentMode: 'execute', history, reply: '已完成修改并验证。' })
    assert.equal(result.incomplete, true)
    assert.equal(result.reason, 'execution_evidence_missing')
  })
}
