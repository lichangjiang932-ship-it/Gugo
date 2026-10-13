import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-artifact-policy-stop', String(process.pid))
process.env.APPROVAL_MODE = 'off'

const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { classifyGeneratedArtifactFormatCode } = await import(
  '../server/services/generatedArtifactFormatValidationError.js'
)
const { trustedInternalLoopPrincipal } = await import('../server/services/loop/internalExecutionPrincipal.js')

const READ_FILE = SERVER_TOOL_SPECS.find((item) => item?.function?.name === 'read_file')
const REJECTED_PATH = 'D:\\work\\report.docx'
const POLICY_CODE = 'ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN'

test('a format code is classified by what the model could do about it', () => {
  // Malformed bytes: a better generation gets past these, so they stay retryable.
  for (const code of [
    'ARTIFACT_FORMAT_ZIP_INVALID',
    'ARTIFACT_FORMAT_ZIP_ENTRY_INVALID',
    'ARTIFACT_FORMAT_XML_INVALID',
    'ARTIFACT_FORMAT_STRUCTURE_INVALID',
    'ARTIFACT_FORMAT_PDF_INVALID',
    'ARTIFACT_FORMAT_IMAGE_INVALID',
    'ARTIFACT_FORMAT_TYPE_MISMATCH',
    'ARTIFACT_FORMAT_EXTENSION_MISMATCH',
  ]) {
    assert.deepEqual(
      classifyGeneratedArtifactFormatCode(code),
      { retryable: true, policyBlocked: false },
      code,
    )
  }

  // A refused feature: the policy decides this one, not the bytes, so the same
  // kind of file is refused however many times it is generated.
  assert.deepEqual(
    classifyGeneratedArtifactFormatCode(POLICY_CODE),
    { retryable: false, policyBlocked: true },
  )

  // The environment, where retrying is not the thing that helps.
  for (const code of [
    'ARTIFACT_FORMAT_PATH_INVALID',
    'ARTIFACT_FORMAT_FILE_UNREADABLE',
    'ARTIFACT_FORMAT_UNSUPPORTED',
    'ARTIFACT_FORMAT_INVALID',
  ]) {
    assert.deepEqual(
      classifyGeneratedArtifactFormatCode(code),
      { retryable: false, policyBlocked: false },
      code,
    )
  }
  assert.deepEqual(classifyGeneratedArtifactFormatCode(undefined), { retryable: false, policyBlocked: false })
})

/** What `read_file` returns for an artifact the safety policy refused. */
const refusal = (overrides = {}) => ({
  ok: true,
  path: REJECTED_PATH,
  content: 'document text',
  formatValidated: false,
  formatValidationCode: POLICY_CODE,
  formatValidationMessage: 'The DOCX package declares a forbidden content type: '
    + 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml.',
  formatValidationPolicyBlocked: true,
  ...overrides,
})

async function runAgainstRefusal(result, { maxIters = 20 } = {}) {
  let modelCalls = 0
  let toolRuns = 0
  const outcome = await runToolsLoop({
    job: { id: 'job-artifact-policy', userId: null, origin: 'chat', prompt: '把文档背景改成浅黄色' },
    approvalPrincipal: trustedInternalLoopPrincipal(),
    step: { id: 'step-artifact-policy', kind: 'chat' },
    messages: [{ role: 'user', content: '把文档背景改成浅黄色' }],
    toolSpecs: [READ_FILE],
    maxIters,
    enableToolHooks: false,
    runModel: async ({ tools }) => {
      modelCalls += 1
      if (!Array.isArray(tools) || tools.length === 0) return { content: '这个效果加不上。', toolCalls: [] }
      return {
        content: '',
        toolCalls: [{
          id: `read-${modelCalls}`,
          type: 'function',
          // A different window every round on purpose: the repeated-identical-call
          // guard must not be the thing that stops this, or the test would pass
          // without the mechanism it exists to check.
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: REJECTED_PATH, limit: modelCalls, offset: modelCalls }),
          },
        }],
      }
    },
    executeTool: async () => { toolRuns += 1; return result },
  })
  return { outcome, toolRuns }
}

test('an artifact the format policy refuses twice stops the round, and says why', async () => {
  const { outcome, toolRuns } = await runAgainstRefusal(refusal())
  assert.equal(toolRuns, 2, 'the second refusal of the same artifact is enough')
  assert.equal(outcome.incomplete, true)
  assert.equal(outcome.noProgress, true)
  assert.equal(outcome.reason, 'artifact_format_policy_blocked')
  assert.deepEqual(outcome.missingRequirements, ['deliverable_artifact'])
})

test('an artifact refused for its bytes is left to the model to repair', async () => {
  // The same count of refusals, but this code means the generation was wrong —
  // which is exactly what another attempt is for. Stopping here would take the
  // repair away from a model that could still make one.
  const { outcome, toolRuns } = await runAgainstRefusal(
    refusal({
      formatValidationCode: 'ARTIFACT_FORMAT_ZIP_INVALID',
      formatValidationMessage: 'The DOCX package is not a readable ZIP archive.',
      formatValidationPolicyBlocked: false,
    }),
    { maxIters: 4 },
  )
  assert.ok(toolRuns > 2, `the loop kept trying, ran ${toolRuns}`)
  assert.notEqual(outcome.reason, 'artifact_format_policy_blocked')
})

test('refusals of different artifacts are not the same refusal', async () => {
  // Each artifact is refused once, so nothing has been shown to be unwinnable.
  let modelCalls = 0
  let toolRuns = 0
  const outcome = await runToolsLoop({
    job: { id: 'job-artifact-policy-distinct', userId: null, origin: 'chat', prompt: '把两个文档的背景都改掉' },
    approvalPrincipal: trustedInternalLoopPrincipal(),
    step: { id: 'step-artifact-policy-distinct', kind: 'chat' },
    messages: [{ role: 'user', content: '把两个文档的背景都改掉' }],
    toolSpecs: [READ_FILE],
    maxIters: 4,
    enableToolHooks: false,
    runModel: async ({ tools }) => {
      modelCalls += 1
      if (!Array.isArray(tools) || tools.length === 0) return { content: '好的。', toolCalls: [] }
      return {
        content: '',
        toolCalls: [{
          id: `read-${modelCalls}`,
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: REJECTED_PATH, limit: modelCalls }) },
        }],
      }
    },
    executeTool: async () => {
      toolRuns += 1
      return refusal({ path: `D:\\work\\report-${toolRuns}.docx` })
    },
  })
  assert.ok(toolRuns > 2, `the loop kept trying, ran ${toolRuns}`)
  assert.notEqual(outcome.reason, 'artifact_format_policy_blocked')
})
