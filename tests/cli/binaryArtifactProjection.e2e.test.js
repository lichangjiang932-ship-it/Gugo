import test from 'node:test'
import assert from 'node:assert/strict'
import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import { createCliArtifactHarness, diagnosticSummary } from './helpers/artifactCompletionHarness.js'

test('real CLI projects its newly validated command-produced PPT as verified without a binary readback or old-turn upgrade', { timeout: 60_000 }, async (t) => {
  const deck = new PptxGenJS()
  deck.addSlide().addText('New canonical binary receipt', { x: 1, y: 1, w: 7, h: 1 })
  const archive = await JSZip.loadAsync(await deck.write({ outputType: 'nodebuffer' }))
  const bytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  assert.ok(bytes.length < 20_000, 'the binary fixture must fit the existing bounded CLI prompt budget')
  const harness = await createCliArtifactHarness(t, bytes)
  const run = await harness.run('Create the requested PPT in this workspace and deliver the completed presentation.')
  const diagnosis = diagnosticSummary(run)
  assert.equal(run.timedOut, false, diagnosis)
  assert.equal(run.status, 0, diagnosis)
  assert.deepEqual(harness.provider.failures, [], diagnosis)
  const completed = run.events.find((event) => event.type === 'turn.completed')
  assert.ok(completed, diagnosis)
  const producing = run.events.find((event) => event.type === 'tool.completed' && event.payload.name === 'run_command'
    && event.payload.result?.artifactValidation?.receipts?.some((receipt) => receipt.sourcePath === harness.paths.ppt))
  assert.ok(producing, diagnosis)
  const receipt = producing.payload.result.artifactValidation.receipts.find((value) => value.sourcePath === harness.paths.ppt)
  assert.equal(receipt.turnId, completed.turnId)
  assert.equal(receipt.toolCallId, producing.payload.toolCallId)
  const verified = completed.payload.verifiedLocalFiles.find((file) => file.path === harness.paths.ppt)
  assert.ok(verified, diagnosis)
  assert.equal(verified.size, bytes.length)
  assert.deepEqual(verified.relatedArtifactIds, [receipt.artifactId])
  assert.ok(completed.payload.deliveryArtifactIds.includes(receipt.artifactId))
  assert.equal(completed.payload.retainedLocalFiles.some((file) => file.path === harness.paths.ppt), false)
  assert.equal(run.events.some((event) => event.type === 'tool.completed' && event.payload.name === 'read_file'
    && event.payload.args?.path === harness.paths.ppt), false, 'binary verification is backed by the host receipt, not a text sample')
  assert.equal(harness.persistedEvents().filter((event) => event.type === 'turn.completed').length, 1)
})
