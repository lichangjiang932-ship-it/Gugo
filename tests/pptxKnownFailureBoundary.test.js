import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import PptxGen from 'pptxgenjs'

// All generated files and the real SQLite ledger belong to this test worker.
// No model provider, user-authored script, browser or user database is used.
const isolatedRoot = fs.realpathSync(process.env.TEMP)
const artifactDirectory = path.resolve(process.env.ARTIFACT_DIR)
assert.equal(path.dirname(path.resolve(process.env.APP_DB_PATH)), isolatedRoot)
assert.equal(path.dirname(artifactDirectory), isolatedRoot)
process.env.WORKSPACE_ROOT = path.join(isolatedRoot, 'pptx-boundary-workspace')
fs.mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true })

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { upsertSession } = await import('../server/services/sessionStore.js')
const { setDefaultOutputDirectory } = await import('../server/services/localFileAccessService.js')
const { createPptx } = await import('../server/services/artifactGen.js')
const { validateGeneratedArtifactFile } = await import('../server/services/generatedArtifactFormatValidation.js')
const { readArtifactSourceSnapshot } = await import('../server/services/artifactSourceStore.js')
const { listTurnArtifacts } = await import('../server/services/turnArtifactStore.js')
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { executeGeneratedArtifactTool } = await import('../server/services/loop/heuristics/generatedArtifactExecutor.js')
const { createSideEffectExecution } = await import('../server/services/loop/sideEffectExecution.js')
const {
  createSideEffectScope, getSideEffectExecutionLedger, sideEffectRecoveryBlock,
  SIDE_EFFECT_LEDGER_CONFLICT, SIDE_EFFECT_OUTCOME_UNKNOWN,
} = await import('../server/services/sideEffectExecutionLedger.js')

test.after(() => closeDb())

function fixture(label) {
  const suffix = randomUUID()
  const userId = `pptx-boundary-user-${suffix}`
  const sessionId = `pptx-boundary-session-${suffix}`
  const turnId = `pptx-boundary-turn-${suffix}`
  createUser({ id: userId, email: `${userId}@example.test` })
  upsertSession({ id: sessionId, userId, title: label })
  setDefaultOutputDirectory({ userId, rootPath: path.join(isolatedRoot, 'output', suffix) })
  const prompt = 'Create a downloadable PPT presentation and preserve all supplied slide text.'
  const job = { id: turnId, userId, sessionId, origin: 'chat', prompt, userPrompt: prompt }
  const step = { id: turnId, kind: 'chat' }
  return {
    job, step, userId, sessionId, turnId,
    options: {
      job, step, messages: [{ role: 'user', content: prompt }],
      toolSpecs: SERVER_TOOL_SPECS.filter((spec) => ['create_pptx', 'set_deliverables'].includes(spec.function?.name)),
      intentMode: 'execute', maxIters: 8, enableToolHooks: false,
      approvalMode: 'bypass', approvalOrigin: 'chat', approvalSessionId: sessionId,
      requestToolApproval: async ({ args }) => ({ proceed: true, args }),
    },
  }
}

function pptxFiles() {
  return fs.readdirSync(artifactDirectory).filter((name) => /\.pptx$/iu.test(name)).sort()
}

function ledgerRows(f) {
  return getDb().prepare(`
    SELECT tool_call_id, status, outcome_json
    FROM side_effect_executions
    WHERE owner_id = ? AND turn_id = ? AND tool_name = 'create_pptx'
    ORDER BY prepared_at, tool_call_id
  `).all(f.userId, f.turnId)
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function validArgs(title) {
  return { title, slides: [{ title: 'Kept content', elements: [
    { type: 'text', text: 'Retain this source text.', x: 0.08, y: 0.15, w: 0.84, h: 0.3 },
  ] }] }
}

async function assertKnownFailure(f, args, execute, expected) {
  const before = pptxFiles()
  const ledger = getSideEffectExecutionLedger()
  const callId = `preparation-${randomUUID()}`
  const boundary = createSideEffectExecution({
    ledger, isDurableSideEffect: () => true, toolName: 'create_pptx',
    call: { id: callId, idempotencyKey: `test:${f.turnId}:${callId}` },
    job: f.job, step: f.step, approvalOrigin: 'chat', approvalSessionId: f.sessionId,
    createScope: createSideEffectScope, recoveryBlock: sideEffectRecoveryBlock,
    conflictCode: SIDE_EFFECT_LEDGER_CONFLICT, unknownCode: SIDE_EFFECT_OUTCOME_UNKNOWN,
  })
  const { input } = boundary.prepare(args)
  boundary.markExecuting(input)
  let sourceError
  await assert.rejects(execute, (error) => {
    sourceError = error
    assert.match(error.message, expected)
    return true
  })
  assert.throws(() => boundary.rethrowExecutionError({
    error: sourceError, input, started: true, returned: false, result: null,
  }), (error) => error === sourceError)
  const record = ledger.read(input)
  assert.equal(record.status, 'failed')
  assert.match(ledger.parseOutcome(record).error, expected)
  assert.deepEqual(pptxFiles(), before, 'preparation failures must not enter the output writer')
}

test('PPT empty-input rejection is durably known failed without an output write', async () => {
  const f = fixture('empty input')
  await assertKnownFailure(f, { slides: [] }, () => createPptx({ slides: [] }), /slides 不能为空/u)
})

test('PPT image-input resolution rejects before generation and keeps its actionable error', async () => {
  const f = fixture('image preparation')
  const args = { ...validArgs('PPT input boundary'), images: [{ path: '' }] }
  await assertKnownFailure(f, args, () => executeGeneratedArtifactTool({
    name: 'create_pptx', args, job: f.job, step: f.step,
  }), /images\[0\]\.path is required/u)
})

test('PPT in-memory encoder rejection is known failed without invoking the artifact writer', async (t) => {
  const f = fixture('encoder preparation')
  const args = validArgs('PPT encoder boundary')
  const failure = Object.assign(new Error('PPT encoder rejected its in-memory output'), {
    code: 'PPTX_ENCODER_INVALID', retryable: true,
  })
  const encoder = t.mock.method(PptxGen.prototype, 'write', async () => { throw failure })
  await assertKnownFailure(f, args, () => createPptx(args), /PPT encoder rejected its in-memory output/u)
  assert.equal(encoder.mock.callCount(), 1)
})

for (const layout of ['process', 'split']) {
  test(`historical ${layout} source errors are still proven pre-write failures`, async () => {
    const f = fixture(`legacy ${layout} input`)
    const args = { title: 'Historical source', slides: [{ title: 'Old source', layout, subtitle: 'Retain the supplied text.' }] }
    await assertKnownFailure(f, args, () => createPptx(args), /slides\[0\]\.bullets or body/u)
  })
}

test('one real durable turn repairs free-canvas geometry and text fit without losing source content', async () => {
  const f = fixture('two actionable corrections')
  const args = {
    title: `PPT preparation repair ${randomUUID()}`,
    slides: [
      ...Array.from({ length: 7 }, (_, index) => ({
        title: `Existing slide ${index + 1}`, elements: [
          { type: 'text', text: `Existing content ${index + 1}`, x: 0.08, y: 0.15, w: 0.84, h: 0.3 },
        ],
      })),
      { title: 'Composition evidence', elements: [
        { type: 'text', text: 'Preserve the composition evidence.', x: 0.9, y: 0.3, w: 0.4, h: 0.3 },
      ] },
      { title: 'Typography evidence', elements: [
        { type: 'text', text: 'Preserve the typography evidence.', x: 0.08, y: 0.3, w: 0.15, h: 0.035, font_size: 32 },
      ] },
    ],
  }
  const originalSlides = structuredClone(args.slides)
  const before = pptxFiles()
  const checkpoints = []
  const observedErrors = []
  let modelCalls = 0
  let artifactId
  const result = await runToolsLoop({
    ...f.options,
    saveCheckpoint: async (state) => { checkpoints.push(structuredClone(state)); return true },
    runModel: async ({ messages }) => {
      modelCalls += 1
      const latest = messages.findLast((message) => message.role === 'tool' && message.name === 'create_pptx')
      const outcome = latest ? JSON.parse(latest.content) : null
      if (modelCalls === 2 || modelCalls === 3) {
        const index = modelCalls === 2 ? 7 : 8
        assert.equal(outcome?.ok, false)
        assert.notEqual(outcome?.code, SIDE_EFFECT_OUTCOME_UNKNOWN, JSON.stringify(outcome))
        assert.ok(outcome.error.includes(`slides[${index}].elements[0]`), outcome.error)
        assert.equal(outcome.code, modelCalls === 2 ? 'PPTX_CONTENT_INVALID' : 'PPTX_CONTENT_OVERFLOW')
        observedErrors.push(outcome.error)
        assert.deepEqual(pptxFiles(), before)
        // The simulated model fixes only the invalid element frame. The host
        // does not replace the design or discard text to manufacture success.
        Object.assign(args.slides[index].elements[0], modelCalls === 2
          ? { x: 0.08, w: 0.84 } : { w: 0.84, h: 0.3 })
      }
      if (modelCalls <= 3) {
        return { content: '', toolCalls: [toolCall(`pptx-attempt-${modelCalls}`, 'create_pptx', args)] }
      }
      if (modelCalls === 4) {
        assert.equal(outcome?.ok, true, JSON.stringify(outcome))
        artifactId = outcome.artifactId
        assert.ok(artifactId)
        return { content: '', toolCalls: [toolCall('select-pptx', 'set_deliverables', { artifact_ids: [artifactId] })] }
      }
      assert.equal(modelCalls, 5, 'the same turn must finish without a resume or unbounded regeneration')
      return { content: 'The PPT is complete; all supplied slide text is preserved.', toolCalls: [] }
    },
  })
  assert.equal(modelCalls, 5, JSON.stringify(result))
  assert.equal(observedErrors.length, 2)
  assert.equal(result.incomplete, undefined, JSON.stringify(result))
  assert.deepEqual(result.deliveryArtifactIds, [artifactId])
  const rows = ledgerRows(f)
  assert.deepEqual(rows.map((row) => row.status), ['failed', 'failed', 'committed'])
  assert.match(JSON.parse(rows[0].outcome_json).error, /slides\[7\]\.elements\[0\]/u)
  assert.match(JSON.parse(rows[1].outcome_json).error, /slides\[8\]\.elements\[0\]/u)
  assert.ok(checkpoints.some((state) => state.toolCalls?.some((call) => call.checkpointStatus === 'completed')))
  const artifacts = listTurnArtifacts(f)
  assert.equal(artifacts.length, 1)
  const validation = await validateGeneratedArtifactFile({
    filePath: path.join(artifactDirectory, artifacts[0].filename), artifactType: 'pptx',
  })
  assert.equal(validation.ok, true)
  const storedSource = JSON.parse(readArtifactSourceSnapshot(artifactId).source)
  assert.deepEqual(storedSource.slides.slice(0, 7), originalSlides.slice(0, 7))
  for (const index of [7, 8]) {
    assert.equal(storedSource.slides[index].elements[0].text, originalSlides[index].elements[0].text)
    assert.deepEqual(storedSource.slides[index], args.slides[index])
  }
})

test('an exception after PPT file publication remains unknown and never replays the writer', async (t) => {
  const f = fixture('post-write uncertainty')
  const args = validArgs(`PPT uncertain write ${randomUUID()}`)
  const originalLink = fs.linkSync
  const writtenTargets = []
  t.mock.method(fs, 'linkSync', (source, target) => {
    const result = originalLink(source, target)
    if (path.dirname(String(target)) === artifactDirectory && /\.pptx$/iu.test(String(target))) {
      writtenTargets.push(String(target))
      throw Object.assign(new Error('Synthetic failure after the PPT output was linked'), { code: 'EIO' })
    }
    return result
  })
  let modelCalls = 0
  const run = () => runToolsLoop({
    ...f.options,
    runModel: async () => {
      modelCalls += 1
      return { content: '', toolCalls: [toolCall('uncertain-pptx', 'create_pptx', args)] }
    },
  })
  const isUnknown = (error) => error?.code === SIDE_EFFECT_OUTCOME_UNKNOWN && error?.unsafeToReplay === true
  await assert.rejects(run, isUnknown)
  assert.equal(modelCalls, 1)
  assert.equal(writtenTargets.length, 1)
  assert.equal(ledgerRows(f)[0]?.status, 'unknown')
  assert.equal(listTurnArtifacts(f).length, 0, 'unrecorded output must not be advertised as completed')
  assert.equal((await validateGeneratedArtifactFile({ filePath: writtenTargets[0], artifactType: 'pptx' })).ok, true)
  await assert.rejects(run, isUnknown)
  assert.equal(modelCalls, 2)
  assert.equal(writtenTargets.length, 1, 'an unknown execution must not create a second suffixed PPT')
  assert.equal(ledgerRows(f).length, 1)
})
