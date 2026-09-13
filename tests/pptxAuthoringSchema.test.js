import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { closeDb } from '../server/db.js'
import { BUILTIN_ARTIFACT_TOOL_SPECS } from '../server/services/builtinArtifactToolSpecs.js'
import {
  PPTX_AUTHORING_DESIGN_SCHEMA,
  PPTX_AUTHORING_SLIDE_SCHEMA,
  PPTX_DESIGN_SCHEMA,
  PPTX_SLIDE_SCHEMA,
} from '../server/services/pptxArtifactContract.js'
import { buildPptxArtifactBuffer } from '../server/services/pptxArtifactFormat.js'
import { assertPptxSchema } from '../server/services/pptxArtifactValidation.js'
import { SIDE_EFFECT_OUTCOME_UNKNOWN } from '../server/services/sideEffectExecutionLedger.js'
import { createLoopContext } from '../server/services/loop/context.js'
import { runToolsLoopCore } from '../server/services/loop/runtime.js'
import { pptxExecutionInputError } from '../server/services/loop/pptxRepairRuntime.js'
import { SERVER_TOOL_SPECS } from '../server/services/toolLoopHeuristics.js'
import { buildAssistantToolCallsMessage, validateToolCall } from '../server/utils/toolCallArguments.js'

test.after(() => closeDb())

const spec = BUILTIN_ARTIFACT_TOOL_SPECS.create_pptx
const parameters = spec.function.parameters
const genericValidation = (args) => validateToolCall({ name: 'create_pptx', args }, [spec])
const visibleText = 'Keep this exact supplied text.'
const canvasSlide = () => ({ elements: [{ type: 'text', text: visibleText, x: 0.08, y: 0.2, w: 0.84, h: 0.3 }] })
const canvasArgs = () => ({ title: 'Free authored presentation', slides: [canvasSlide()] })
const legacyArgs = () => ({
  title: 'Historical presentation', theme: 'noir', subtitle: 'Original subtitle', brand: 'Original brand',
  slides: [{ title: 'Historical slide', layout: 'bullets', bullets: [visibleText] }],
})

test('the canonical model-facing PPT schema has no preset or implicit composition parameters', () => {
  assert.deepEqual(SERVER_TOOL_SPECS.find((item) => item.function.name === 'create_pptx').function.parameters, parameters)
  assert.strictEqual(parameters.properties.design, PPTX_AUTHORING_DESIGN_SCHEMA)
  assert.strictEqual(parameters.properties.slides.items, PPTX_AUTHORING_SLIDE_SCHEMA)
  assert.equal(parameters.additionalProperties, false)
  assert.equal(PPTX_AUTHORING_DESIGN_SCHEMA.additionalProperties, false)
  assert.equal(PPTX_AUTHORING_SLIDE_SCHEMA.additionalProperties, false)
  assert.deepEqual(PPTX_AUTHORING_SLIDE_SCHEMA.required, ['elements'])
  assert.deepEqual(Object.keys(PPTX_AUTHORING_SLIDE_SCHEMA.properties).sort(), ['background', 'elements', 'notes', 'title'])
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['base_digest', 'design', 'edits', 'images', 'output_directory', 'repair_from_tool_call_id', 'replace_artifact_id', 'slides', 'title'])
  for (const name of ['show_page_numbers', 'show_brand', 'show_date']) {
    assert.equal(Object.hasOwn(PPTX_AUTHORING_DESIGN_SCHEMA.properties, name), false)
    assert.ok(PPTX_DESIGN_SCHEMA.properties[name], 'legacy renderer keeps explicit historic chrome support')
  }
  assert.doesNotMatch(JSON.stringify(parameters), /"(?:noir|paper|ocean|forest)"/u)
})

test('free canvas authoring supports optional metadata, explicit dimensions and native chart/table data', async () => {
  const args = canvasArgs()
  args.design = { background: 'F9E5EC', foreground: '2C2040', heading_font: 'Arial', body_font: 'Arial', width: 10, height: 10 }
  args.slides[0].notes = 'Speaker notes are not visible slide copy.'
  assert.equal(genericValidation(args), null)
  assertPptxSchema(args.slides[0], PPTX_AUTHORING_SLIDE_SCHEMA, 'slide')
  const { buffer } = await buildPptxArtifactBuffer(args)
  const zip = await JSZip.loadAsync(buffer)
  const slideXml = await zip.file('ppt/slides/slide1.xml').async('string')
  const renderedText = [...slideXml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)].map((match) => match[1])
  assert.deepEqual(renderedText, [visibleText], 'slide metadata must never become an implicit visible title')
  const elements = PPTX_AUTHORING_SLIDE_SCHEMA.properties.elements.items.oneOf
  for (const type of ['text', 'shape', 'line', 'chart', 'table', 'image']) {
    assert.ok(elements.some((variant) => variant.properties.type.const === type), type)
  }
})

test('legacy design and slide schemas stay available to old source and renderer paths', () => {
  assertPptxSchema(legacyArgs().slides[0], PPTX_SLIDE_SCHEMA, 'legacySlide')
  assertPptxSchema({ show_page_numbers: true, show_brand: true, show_date: false }, PPTX_DESIGN_SCHEMA, 'legacyDesign')
  assert.ok(PPTX_SLIDE_SCHEMA.properties.layout.enum.includes('cover'))
  assert.equal(PPTX_SLIDE_SCHEMA.properties.bullets.maxItems, 24)
})

for (const theme of ['noir', 'paper', 'ocean', 'forest']) {
  test(`new model calls reject removed theme ${theme} with an ordinary repairable schema error`, () => {
    const error = genericValidation({ ...canvasArgs(), theme })
    assert.equal(error.code, 'tool_arguments_validation_failed')
    assert.equal(error.retryable, true)
    assert.ok(error.issues.some((issue) => issue.includes('$.theme')))
    assert.equal(error.requiresUserVerification, undefined)
  })
}

test('all legacy page types and content slots are rejected even when empty or accompanied by elements', () => {
  for (const layout of PPTX_SLIDE_SCHEMA.properties.layout.enum) {
    const args = canvasArgs()
    args.slides[0].layout = layout
    const error = genericValidation(args)
    assert.equal(error.code, 'tool_arguments_validation_failed', layout)
    assert.ok(error.issues.some((issue) => issue.includes('$.slides[0].layout')), layout)
  }
  const slots = { eyebrow: '', bullets: [], body: '', subtitle: '', kpi: [], chart: {}, table: {}, quote: '' }
  for (const [name, value] of Object.entries(slots)) {
    const args = canvasArgs()
    args.slides[0][name] = value
    assert.equal(genericValidation(args)?.code, 'tool_arguments_validation_failed', name)
  }
  for (const [name, value] of Object.entries({ theme: 'paper', subtitle: '', brand: '', markdown: '# Old source' })) {
    assert.equal(genericValidation({ ...canvasArgs(), [name]: value })?.code, 'tool_arguments_validation_failed', name)
  }
  for (const name of ['show_page_numbers', 'show_brand', 'show_date']) {
    for (const value of [true, false]) {
      assert.equal(genericValidation({ ...canvasArgs(), design: { [name]: value } })?.code, 'tool_arguments_validation_failed', name)
    }
  }
})

test('missing canvas content, unsupported properties and existing bounds remain strict', () => {
  const cases = [
    { title: 'No elements', slides: [{ title: 'Old empty slide' }] },
    { title: 'No elements', slides: [{ elements: [] }] },
    { ...canvasArgs(), slides: [] },
    { ...canvasArgs(), slides: Array.from({ length: 101 }, canvasSlide) },
    { ...canvasArgs(), design: { background: 'not a color' } },
    { ...canvasArgs(), design: { body_font_size: 1 } },
    { ...canvasArgs(), design: { code: 'arbitrary code is not design data' } },
  ]
  for (const args of cases) {
    const before = structuredClone(args)
    const error = genericValidation(args)
    assert.equal(error.code, 'tool_arguments_validation_failed')
    assert.equal(error.retryable, true)
    assert.deepEqual(args, before, 'validation must never auto-convert, truncate or fill old content')
  }
})

const realShapeFailures = [
  {
    label: 'missing shape primitive', index: 2, field: 'shape', wording: '为必填参数',
    element: { type: 'shape', x: 0.4, y: 0.45, w: 0.2, h: 0.02, fill: '#5F7588' },
  },
  {
    label: 'unsupported empty text on rect', index: 1, field: 'text', wording: '是未允许的额外参数',
    element: { text: '', h: 0.02, x: 0.4, w: 0.2, y: 0.45, fill: '#5F7588', type: 'shape', shape: 'rect' },
  },
]
for (const failure of realShapeFailures) {
  test(`real MiMo ${failure.label} receives a specific field error through the actual tool loop`, async () => {
    const args = canvasArgs()
    while (args.slides[0].elements.length <= failure.index) {
      args.slides[0].elements.push({ type: 'shape', shape: 'rect', x: 0.1, y: 0.1, w: 0.1, h: 0.1 })
    }
    args.slides[0].elements[failure.index] = structuredClone(failure.element)
    const original = structuredClone(args)
    assert.equal(genericValidation(args)?.code, 'tool_arguments_validation_failed')
    const detailed = pptxExecutionInputError('create_pptx', args)
    const exactIssue = `$.slides[0].elements[${failure.index}].${failure.field} ${failure.wording}`
    assert.deepEqual(detailed.issues, [exactIssue])
    assert.ok(detailed.error.includes(exactIssue))
    assert.doesNotMatch(detailed.error, /不符合任一允许的参数形状/)
    assert.match(detailed.hint, failure.field === 'shape' ? /requires an explicit shape value/ : /does not accept text/)
    assert.doesNotMatch(detailed.hint, /hook|repair envelope|short repair/i)
    assert.deepEqual(args, original, 'diagnostics must not insert a default or silently remove content')
    const fixture = checkpointFixture('pending', { args })
    await runToolsLoopCore(fixture.context)
    const toolMessage = fixture.requests.flat().find((message) => message.role === 'tool' && message.name === 'create_pptx')
    assert.ok(toolMessage)
    const actual = JSON.parse(toolMessage.content)
    assert.deepEqual(actual.issues, [exactIssue])
    assert.equal(actual.hint, detailed.hint)
    fixture.assertNoExecution()
    assert.deepEqual(fixture.checkpoint, fixture.original)
  })
}

test('full-input diagnostics preserve non-empty shape text and do not expand the primitive contract', () => {
  const args = canvasArgs()
  args.slides[0].elements[0] = { ...realShapeFailures[1].element, text: 'Preserve these intended words.' }
  const original = structuredClone(args)
  const issue = pptxExecutionInputError('create_pptx', args)
  assert.match(issue.issues[0], /\.text 是未允许的额外参数/)
  assert.match(issue.hint, /preserve any intended non-empty words in a separate editable type="text" element/)
  assert.deepEqual(args, original)
  delete args.slides[0].elements[0].text
  args.slides[0].elements[0].shape = 'star'
  assert.match(pptxExecutionInputError('create_pptx', args).issues[0], /\.shape 必须是 rect \/ roundRect \/ ellipse \/ triangle \/ chevron 之一/)
  assert.equal(pptxExecutionInputError('create_pptx', canvasArgs()), null)
  const missingTitle = canvasArgs()
  delete missingTitle.title
  const titleIssue = pptxExecutionInputError('create_pptx', missingTitle)
  assert.match(titleIssue.issues[0], /\.title 为必填参数/)
  assert.doesNotMatch(titleIssue.hint, /hook|repair envelope|short repair|requires an explicit shape/i)
})

let checkpointIndex = 0
function checkpointFixture(status, { ledger, completedResult, args: sourceArgs } = {}) {
  const args = sourceArgs || legacyArgs()
  const call = {
    id: `old-pptx-${++checkpointIndex}`, name: 'create_pptx', args,
    argumentsText: JSON.stringify(args), checkpointStatus: status,
    ...(completedResult ? { checkpointResult: completedResult } : {}),
  }
  const prompt = 'Create a PPT preserving all supplied source content.'
  const checkpoint = {
    messages: [
      { role: 'user', content: prompt }, buildAssistantToolCallsMessage([call]),
      ...(completedResult ? [{ role: 'tool', tool_call_id: call.id, name: 'create_pptx', content: JSON.stringify(completedResult) }] : []),
    ],
    toolCalls: [call], artifactIds: [], iterations: 0,
    completionGuards: {
      activeArtifactTools: ['create_pptx'], requiredArtifactTools: ['create_pptx'],
      artifactContractText: prompt, artifactOutputPrompt: prompt,
    },
  }
  const original = structuredClone(checkpoint)
  const requests = []
  const completions = []
  let executions = 0
  const context = createLoopContext({
    job: { id: `pptx-schema-recovery-${checkpointIndex}`, userId: 'pptx-schema-fixture-user', origin: 'chat', prompt, userPrompt: prompt },
    step: { id: 'pptx-schema-step', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS.filter((item) => ['create_pptx', 'set_deliverables'].includes(item.function.name)),
    fallbackToolSpecs: [], maxIters: 2, enableToolHooks: false, semanticSummary: false,
    sideEffectLedger: ledger,
    loadCheckpoint: async () => ({ state: structuredClone(checkpoint) }),
    onToolCompleted: async (value) => { completions.push(value) },
    runModel: async ({ messages }) => {
      requests.push(structuredClone(messages))
      return { content: 'No file has been generated.', toolCalls: [], finishReason: 'stop' }
    },
    executeTool: async () => {
      executions += 1
      throw new Error('Schema/checkpoint fixtures must never execute a file-writing tool')
    },
  })
  return {
    context, requests, completions, checkpoint, original,
    assertNoExecution: () => assert.equal(executions, 0),
  }
}

for (const status of ['pending', 'awaiting_approval']) {
  test(`old ${status} checkpoint arguments are rejected by the current schema and returned to the model for repair`, async () => {
    const fixture = checkpointFixture(status)
    const result = await runToolsLoopCore(fixture.context)
    const response = fixture.requests.flat().find((message) => message.role === 'tool' && message.name === 'create_pptx')
    assert.ok(response, 'the model must receive the legacy-argument failure in its original turn')
    const error = JSON.parse(response.content)
    assert.equal(error.code, 'tool_arguments_validation_failed')
    assert.equal(error.retryable, true)
    assert.ok(error.issues.some((issue) => issue.includes('.elements')))
    assert.ok(error.issues.some((issue) => issue.includes('.layout')))
    assert.ok(fixture.requests[0].some((message) => message.tool_calls?.some((call) => call.function.arguments.includes(visibleText))))
    assert.equal(result.incomplete, true)
    assert.deepEqual(fixture.checkpoint, fixture.original)
    fixture.assertNoExecution()
  })
}

test('completed legacy checkpoint results are retained without replaying or revalidating their old arguments', async () => {
  const completedResult = { ok: false, code: 'PPTX_CONTENT_INVALID', error: 'A historical preflight failure already recorded.', retryable: true }
  const fixture = checkpointFixture('completed', { completedResult })
  await runToolsLoopCore(fixture.context)
  const response = fixture.requests.flat().find((message) => message.role === 'tool' && message.name === 'create_pptx')
  assert.ok(response)
  assert.equal(JSON.parse(response.content).code, completedResult.code)
  assert.deepEqual(fixture.checkpoint, fixture.original)
  fixture.assertNoExecution()
})

test('an unknown executing legacy checkpoint remains unsafe to replay instead of being downgraded to a schema retry', async () => {
  let reads = 0
  const denied = () => { throw new Error('Unknown execution must not mutate its ledger in this fixture') }
  const ledger = {
    read: () => { reads += 1; return { id: 'unknown-pptx-execution', status: 'unknown' } },
    prepare: denied, prepareRecovery: denied, readRecovery: denied, claimExecution: denied,
    markExecuting: denied, markUnknown: denied, finish: denied, parseOutcome: denied,
  }
  const fixture = checkpointFixture('executing', { ledger })
  await assert.rejects(() => runToolsLoopCore(fixture.context), (error) => {
    assert.equal(error.code, SIDE_EFFECT_OUTCOME_UNKNOWN)
    assert.equal(error.unsafeToReplay, true)
    return true
  })
  assert.equal(reads, 1)
  assert.equal(fixture.requests.length, 0)
  fixture.assertNoExecution()
})
