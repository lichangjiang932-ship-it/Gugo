import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.APPROVAL_MODE = 'off'
const { runToolsLoop, SERVER_TOOL_SPECS } = await import('../server/services/jobTools.js')
const { trustedInternalLoopPrincipal } = await import('../server/services/loop/internalExecutionPrincipal.js')
const PATH = 'D:/work/policy-output.docx'
const prompt = '把文档背景改成浅黄色，并交付 Word 文档。'
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

test('output policy refusals survive a checkpoint without replaying completed writes or reads', async () => {
  let checkpoint
  let reads = 0
  let writes = 0
  let modelCalls = 0
  let interrupted = false
  const common = {
    job: { id: 'policy-checkpoint', userId: null, origin: 'chat', prompt },
    approvalPrincipal: trustedInternalLoopPrincipal(),
    step: { id: 'policy-checkpoint-step', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: SERVER_TOOL_SPECS.filter((spec) => ['read_file', 'write_file'].includes(spec.function?.name)),
    maxIters: 8,
    enableToolHooks: false,
    saveCheckpoint: async (value) => { checkpoint = structuredClone(value); return true },
    runModel: async ({ tools }) => {
      if (!tools?.length) return { content: '该效果未交付。', toolCalls: [] }
      modelCalls += 1
      return { content: '', toolCalls: [modelCalls === 1
        ? call('write-output', 'write_file', { path: PATH, content: 'fixture' })
        : call(`read-${modelCalls}`, 'read_file', { path: PATH, offset: modelCalls, limit: 1 })] }
    },
    executeTool: async ({ name }) => {
      if (name === 'write_file') { writes += 1; return { ok: true, path: PATH, changedPaths: [PATH] } }
      reads += 1
      return { ok: true, path: PATH, content: 'fixture text', formatValidated: false,
        formatValidationCode: 'ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN', formatValidationPolicyBlocked: true }
    },
  }
  await assert.rejects(runToolsLoop({ ...common, onToolCompleted: async (outcome) => {
    if (outcome.call.name === 'read_file' && !interrupted) {
      interrupted = true
      throw Object.assign(new Error('fixture interruption'), { name: 'AbortError' })
    }
  } }), { name: 'AbortError' })
  assert.equal(reads, 1)
  const saved = structuredClone(checkpoint)
  const result = await runToolsLoop({ ...common, loadCheckpoint: async () => saved })
  assert.equal(writes, 1, 'a completed write is never replayed')
  assert.equal(reads, 2, 'one prior refusal plus one new refusal reaches the same policy boundary')
  assert.equal(result.reason, 'artifact_format_policy_blocked')
  assert.equal(saved.completionGuards.artifactFormatRejections.version, 1)
})
