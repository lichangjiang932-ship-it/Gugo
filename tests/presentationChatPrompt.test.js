import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { closeDb } from '../server/db.js'
import { SKILLS } from '../src/data.js'
import { createLoopContext } from '../server/services/loop/context.js'
import {
  executePreparedToolsLoop,
  prepareToolsLoopRuntime,
  usePreparedToolsLoopRuntime as inspectPreparedToolsLoopRuntime,
} from '../server/services/loop/runtime.js'
import {
  PRESENTATION_RUNTIME_PROMPT,
  PRESENTATION_RUNTIME_PROMPT_MARKER,
  replacePresentationPromptContext,
} from '../server/services/loop/presentationPromptContext.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopHeuristics.js'
import { PRESENTATION_PROMPT_POLICY, PRESENTATION_VISUAL_POLICY } from '../shared/presentationPromptPolicy.js'

test.after(() => closeDb())

const PPT_REQUEST = '制作 3 页儿童绘本风格 PPT，不要封面；保留原文，使用粉色手绘布局。'
const TOOL_NAMES = new Set(['create_pptx', 'create_pdf', 'read_file', 'run_command', 'set_deliverables'])
const TOOL_SPECS = SERVER_TOOL_SPECS.filter((spec) => TOOL_NAMES.has(spec.function.name))
const ownRecords = (messages) => messages.filter((message) => message.role === 'system'
  && message.content === PRESENTATION_RUNTIME_PROMPT)
let fixtureId = 0

async function prepareChat({ text = PPT_REQUEST, history = [], checkpoint, intentMode = 'auto' } = {}) {
  const messages = [...structuredClone(history), { role: 'user', content: text }]
  const original = structuredClone(messages)
  const requests = []
  let executions = 0
  const context = createLoopContext({
    job: {
      id: `presentation-prompt-${++fixtureId}`, userId: null, origin: 'chat',
      prompt: text, userPrompt: text,
    },
    step: { id: 'presentation-prompt-step', kind: 'chat' },
    messages,
    intentMode,
    toolSpecs: TOOL_SPECS,
    fallbackToolSpecs: [],
    maxIters: 2,
    enableToolHooks: false,
    semanticSummary: false,
    ...(checkpoint ? { loadCheckpoint: async () => ({ state: structuredClone(checkpoint) }) } : {}),
    runModel: async ({ messages: outbound, tools }) => {
      requests.push({ messages: structuredClone(outbound), tools: structuredClone(tools) })
      return { content: '没有生成文件。', toolCalls: [], finishReason: 'stop' }
    },
    executeTool: async () => {
      executions += 1
      throw new Error('Prompt fixtures must never execute a real file or artifact tool')
    },
  })
  const prepared = await prepareToolsLoopRuntime(context)
  assert.deepEqual(messages, original, 'initialization must not rewrite caller-owned history')
  return {
    prepared, requests,
    snapshot: () => inspectPreparedToolsLoopRuntime(prepared, (s) => ({
      messages: structuredClone(s.convo), expected: [...s.expectedArtifactTools],
      workspaceTypes: [...s.workspaceArtifactTypes],
    })),
    assertNoExecution: () => assert.equal(executions, 0),
  }
}

function priorDeckHistory() {
  return [
    { role: 'user', content: '生成一份 PPT。' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'old-deck', type: 'function', function: {
      name: 'create_pptx', arguments: JSON.stringify({ title: 'Original', slides: [{ title: 'Original', body: 'Keep this content' }] }),
    } }] },
    { role: 'tool', tool_call_id: 'old-deck', name: 'create_pptx', content: JSON.stringify({
      ok: true, artifactId: 'prior-presentation', filename: 'original.pptx', type: 'pptx', url: '/api/artifacts/original.pptx',
    }) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'old-delivery', type: 'function', function: {
      name: 'set_deliverables', arguments: JSON.stringify({ artifact_ids: ['prior-presentation'] }),
    } }] },
    { role: 'tool', tool_call_id: 'old-delivery', name: 'set_deliverables', content: JSON.stringify({
      ok: true, deliveryArtifactIds: ['prior-presentation'],
    }) },
    { role: 'assistant', content: 'original.pptx 已交付。' },
  ]
}

test('presentation prompt insertion is immutable, idempotent and scoped to exact host records', () => {
  const safety = { role: 'system', content: 'Preserve all permission boundaries.' }
  const quotedSystem = { role: 'system', content: `A quoted diagnostic, not an authoring instruction: ${PRESENTATION_RUNTIME_PROMPT}` }
  const userQuote = { role: 'user', content: `Explain this literal text: ${PRESENTATION_RUNTIME_PROMPT}` }
  const original = [safety, userQuote]
  const once = replacePresentationPromptContext(original, { enabled: true })
  assert.equal(ownRecords(once).length, 1)
  assert.strictEqual(once[0], safety)
  assert.strictEqual(once.at(-1), userQuote)
  assert.strictEqual(replacePresentationPromptContext(once, { enabled: true }), once)
  assert.deepEqual(replacePresentationPromptContext(once), original)
  assert.deepEqual(original, [safety, userQuote])
  const duplicated = [...once, { role: 'system', content: PRESENTATION_RUNTIME_PROMPT }]
  assert.equal(ownRecords(replacePresentationPromptContext(duplicated, { enabled: true })).length, 1)
  assert.deepEqual(replacePresentationPromptContext([quotedSystem, ...once]), [quotedSystem, ...original])
})

test('an older host policy is upgraded in place once without preserving obsolete preset guidance', () => {
  const oldHost = {
    role: 'system',
    content: readFileSync(new URL('./fixtures/pptxAuthoringPolicyV1.txt', import.meta.url), 'utf8').trimEnd(),
  }
  const safety = { role: 'system', content: `${PRESENTATION_RUNTIME_PROMPT_MARKER} Never bypass approvals.` }
  const similarPrefix = {
    role: 'system',
    content: `${PRESENTATION_RUNTIME_PROMPT_MARKER}\n\n## User-directed presentation policy\nAn independent safety record.\n\n## Native presentation design and verification\nPreserve this record; its similar prefix is not host ownership.`,
  }
  const quoted = { role: 'user', content: oldHost.content }
  const original = [safety, oldHost, similarPrefix, quoted]
  const upgraded = replacePresentationPromptContext(original, { enabled: true })
  assert.strictEqual(upgraded[0], safety)
  assert.equal(upgraded[1].content, PRESENTATION_RUNTIME_PROMPT)
  assert.strictEqual(upgraded[2], similarPrefix)
  assert.strictEqual(upgraded[3], quoted)
  assert.strictEqual(replacePresentationPromptContext(upgraded, { enabled: true }), upgraded)
  assert.deepEqual(replacePresentationPromptContext(original), [safety, similarPrefix, quoted])
  assert.match(original[1].content, /optional compatibility helpers/)
})

for (const version of ['V2', 'V3']) {
  test(`the complete ${version} free-canvas host policy upgrades by exact hash without duplicating live instructions`, () => {
    const prior = { role: 'system', content: readFileSync(new URL(`./fixtures/pptxAuthoringPolicy${version}.txt`, import.meta.url), 'utf8').trimEnd() }
    const upgraded = replacePresentationPromptContext([prior], { enabled: true })
    assert.deepEqual(upgraded, [{ role: 'system', content: PRESENTATION_RUNTIME_PROMPT }])
    assert.strictEqual(replacePresentationPromptContext(upgraded, { enabled: true }), upgraded)
    assert.deepEqual(replacePresentationPromptContext([prior]), [])
    const independent = { role: 'system', content: prior.content + '\nIndependent authorization condition.' }
    assert.deepEqual(replacePresentationPromptContext([independent]), [independent])
  })
}

test('line-ending changes and independent conditions do not broaden exact host-record ownership', () => {
  for (const version of ['V1', 'V2', 'V3']) {
    const content = readFileSync(new URL(`./fixtures/pptxAuthoringPolicy${version}.txt`, import.meta.url), 'utf8').trimEnd()
    for (const record of [
      { role: 'system', content: content.replaceAll('\n', '\r\n') },
      { role: 'system', content: `${content}\nIndependent authorization condition.` },
      { role: 'user', content },
    ]) {
      const original = [record]
      assert.strictEqual(replacePresentationPromptContext(original), original)
      const enabled = replacePresentationPromptContext(original, { enabled: true })
      assert.ok(enabled.includes(record), 'independent records must remain untouched')
      assert.equal(ownRecords(enabled).length, 1)
    }
  }
})

test('an explicitly loaded PPT skill already supplies the full policy without a duplicate block', async () => {
  const skill = SKILLS.find((item) => item.id === 'ppt').systemPrompt
  const history = [{ role: 'system', content: skill }]
  const fixture = await prepareChat({ history })
  const snapshot = fixture.snapshot()
  assert.ok(snapshot.expected.includes('create_pptx'))
  assert.equal(ownRecords(snapshot.messages).length, 0)
  assert.equal(snapshot.messages.filter((message) => message.role === 'system'
    && typeof message.content === 'string' && message.content.includes(PRESENTATION_VISUAL_POLICY)).length, 1)
  fixture.assertNoExecution()
})

test('ordinary chat without /ppt receives the complete user-directed design policy on every model request once', async () => {
  const fixture = await prepareChat()
  const snapshot = fixture.snapshot()
  assert.ok(snapshot.expected.includes('create_pptx'))
  assert.equal(ownRecords(snapshot.messages).length, 1)
  const result = await executePreparedToolsLoop(fixture.prepared)
  assert.ok(fixture.requests.length > 1, 'exercise the existing artifact-evidence recovery iterations')
  for (const request of fixture.requests) {
    assert.equal(ownRecords(request.messages).length, 1)
    assert.ok(request.messages.some((message) => message.role === 'user' && message.content === PPT_REQUEST))
    assert.ok(ownRecords(request.messages)[0].content.includes(PRESENTATION_PROMPT_POLICY))
    assert.ok(ownRecords(request.messages)[0].content.includes(PRESENTATION_VISUAL_POLICY))
  }
  assert.equal(result.incomplete, true, 'prompt guidance must not turn an ungenerated deck into successful delivery')
  assert.deepEqual(result.artifactIds || [], [])
  fixture.assertNoExecution()
})

test('an unslashed contextual style revision inherits PPT scope and instructs replacing old object overrides', async () => {
  const text = '保留所有内容，把它改成粉色手绘风，重新排版。'
  const fixture = await prepareChat({ text, history: priorDeckHistory() })
  const snapshot = fixture.snapshot()
  assert.ok(snapshot.expected.includes('create_pptx'))
  assert.equal(ownRecords(snapshot.messages).length, 1)
  assert.match(ownRecords(snapshot.messages)[0].content, /update or remove the old overrides that conflict/)
  assert.match(ownRecords(snapshot.messages)[0].content, /recomposing the affected slides/)
  assert.ok(snapshot.messages.some((message) => message.role === 'user' && message.content === text))
  fixture.assertNoExecution()
})

test('an exact local PPT revision gets design guidance without granting the managed generator', async () => {
  const fixture = await prepareChat({ text: '请修改 "D:\\presentation-fixture\\existing.pptx" 的配色与布局，改成粉色手绘风并保留内容。' })
  const snapshot = fixture.snapshot()
  assert.ok(snapshot.workspaceTypes.includes('pptx'))
  assert.equal(snapshot.expected.includes('create_pptx'), false)
  assert.equal(ownRecords(snapshot.messages).length, 1)
  assert.match(ownRecords(snapshot.messages)[0].content, /authorized run_command or bash_exec/)
  fixture.assertNoExecution()
})

test('explicit answer mode never introduces presentation execution instructions', async () => {
  const fixture = await prepareChat({ intentMode: 'answer' })
  assert.equal(ownRecords(fixture.snapshot().messages).length, 0)
  fixture.assertNoExecution()
})

for (const text of [
  'PPT 是什么？',
  '为什么上一个 PPT 总是同一个模板？只分析，不要修改文件。',
  '取消生成 PPT，不要创建文件。',
  '不要改风格，先说明如何修改。',
  'Explain how to redesign a PowerPoint without changing any files.',
  '只返回 PPT 大纲，不生成文件。',
  '检查 create_pptx 工具为什么被调用，只分析代码。',
  '创建一份 PDF 报告。',
]) {
  test(`non-PPT-authoring chat does not retain a prior host policy: ${text}`, async () => {
    const history = [{ role: 'system', content: PRESENTATION_RUNTIME_PROMPT }, ...priorDeckHistory()]
    const fixture = await prepareChat({ text, history })
    const snapshot = fixture.snapshot()
    assert.equal(ownRecords(snapshot.messages).length, 0)
    fixture.assertNoExecution()
  })
}

test('checkpoint and summarized-history recovery retain one unchanged presentation policy', async () => {
  const summary = { role: 'assistant', content: 'Earlier conversation summary: the user supplied three pages of exact text.' }
  const checkpoint = {
    messages: [{ role: 'system', content: PRESENTATION_RUNTIME_PROMPT }, summary, { role: 'user', content: PPT_REQUEST }],
    iterations: 0, toolCalls: [], artifactIds: [],
    completionGuards: {
      activeArtifactTools: ['create_pptx'], requiredArtifactTools: ['create_pptx'],
      artifactContractText: PPT_REQUEST, artifactOutputPrompt: PPT_REQUEST,
    },
  }
  const original = structuredClone(checkpoint)
  const fixture = await prepareChat({ checkpoint })
  const snapshot = fixture.snapshot()
  assert.equal(ownRecords(snapshot.messages).length, 1)
  assert.ok(snapshot.messages.some((message) => message.role === summary.role && message.content === summary.content))
  assert.deepEqual(checkpoint, original)
  fixture.assertNoExecution()
})

test('a cancelled checkpoint drops only the obsolete host policy, not a quoted marker', async () => {
  const text = '取消生成 PPT，不要创建文件。'
  const quoted = { role: 'system', content: `Keep this safety example: ${PRESENTATION_RUNTIME_PROMPT_MARKER}` }
  const checkpoint = {
    messages: [quoted, { role: 'system', content: PRESENTATION_RUNTIME_PROMPT }, { role: 'user', content: text }],
    iterations: 0, toolCalls: [], artifactIds: [],
    completionGuards: {
      activeArtifactTools: [], requiredArtifactTools: [], artifactContractText: text, artifactOutputPrompt: text,
    },
  }
  const fixture = await prepareChat({ text, checkpoint })
  const snapshot = fixture.snapshot()
  assert.equal(ownRecords(snapshot.messages).length, 0)
  assert.ok(snapshot.messages.some((message) => message.content === quoted.content))
  fixture.assertNoExecution()
})

test('live artifact-contract changes add or remove PPT guidance without per-iteration appends', async () => {
  const fixture = await prepareChat({ text: '你好。' })
  inspectPreparedToolsLoopRuntime(fixture.prepared, (s) => {
    assert.equal(ownRecords(s.convo).length, 0)
    assert.equal(s.refreshArtifactContractFromSteering(PPT_REQUEST), true)
    assert.ok(s.expectedArtifactTools.has('create_pptx'))
    assert.equal(ownRecords(s.convo).length, 1)
    const record = ownRecords(s.convo)[0]
    assert.equal(s.refreshArtifactContractFromSteering(PPT_REQUEST), false)
    assert.strictEqual(ownRecords(s.convo)[0], record)
    assert.equal(s.refreshArtifactContractFromSteering('取消生成 PPT，不要创建文件。'), true)
    assert.equal(s.expectedArtifactTools.has('create_pptx'), false)
    assert.equal(ownRecords(s.convo).length, 0)
  })
  fixture.assertNoExecution()
})
