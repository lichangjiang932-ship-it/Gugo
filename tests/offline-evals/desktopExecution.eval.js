import assert from 'node:assert/strict'
import path from 'node:path'
import { defineOfflineEvalCase, defineOfflineEvalSuite } from '../helpers/offlineEvalHarness.js'
import { localRequestRejection } from '../../server/utils/localRequestPolicy.js'
import { createLoopExecutionScope, assertLoopExecutionScope } from '../../server/services/loop/executionScope.js'
import { runToolLoop } from '../../server/services/loop/index.js'
import { SERVER_TOOL_SPECS } from '../../server/services/toolLoopRuntime.js'
import { clearVerifiedMutationTargets } from '../../server/services/loop/heuristics/mutationVerification.js'
import { isSuccessfulPdfLayoutVerification } from '../../server/services/loop/heuristics/capabilityChecks.js'
import { registerDynamicTool, getDynamicTool } from '../../server/services/toolRegistry.js'
import { TurnEngine } from '../../server/services/TurnEngine.js'
import { createTestTurnEnginePersistence } from '../helpers/turnEnginePersistence.js'
import { createUser, closeDb } from '../../server/db.js'

const userId = 'desktop-contract-eval-owner'
const spec = (name) => SERVER_TOOL_SPECS.find((value) => value.function.name === name)
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

function createOwner(ctx) {
  createUser({ id: userId, email: `${userId}@example.invalid` })
  ctx.defer(() => closeDb())
}

async function twoFileScenario(ctx, complete) {
  createOwner(ctx)
  const prompt = 'Update both a.js and b.js and verify both changes.'
  const files = new Map([['a.js', 'old'], ['b.js', 'old']])
  let requests = 0
  const targets = complete ? ['a.js', 'b.js'] : ['a.js']
  const result = await runToolLoop({
    job: { id: 'desktop-two-file-eval', userId, origin: 'chat', prompt },
    step: { id: 'desktop-two-file-step', kind: 'chat' },
    messages: [{ role: 'user', content: prompt }],
    toolSpecs: [spec('write_file'), spec('read_file')],
    intentMode: 'execute', maxIters: 8, enableToolHooks: false,
    requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'desktop-eval-approved' }),
    runModel: async () => ++requests === 1
      ? { content: '', toolCalls: targets.map((target) => call(`write-${target}`, 'write_file', {
          path: target, content: 'updated',
        })) }
      : { content: 'Both files are complete.', toolCalls: [] },
    executeTool: async ({ name, args }) => {
      if (name === 'write_file') {
        files.set(args.path, args.content)
        return { ok: true, changed: true, path: args.path }
      }
      return { ok: true, path: args.path, content: files.get(args.path), truncated: false }
    },
  })
  assert.equal(result.incomplete, complete ? undefined : true)
  assert.equal(files.get('b.js'), complete ? 'updated' : 'old')
  ctx.metric('false_completions', 0)
}

export default defineOfflineEvalSuite({
  id: 'desktop-execution',
  title: 'Desktop execution identity, model binding and completion evidence',
  version: 1,
  cases: [
    defineOfflineEvalCase({
      id: 'DESKTOP-01', category: 'local-authority', title: 'untrusted Host cannot bootstrap desktop identity',
      async run(ctx) {
        assert.equal(localRequestRejection({ method: 'POST', headers: {
          host: 'attacker.example', origin: 'http://attacker.example',
        } }).code, 'LOCAL_REQUEST_HOST_DENIED')
        assert.equal(localRequestRejection({ method: 'POST', headers: { host: '127.0.0.1:3000' } }), null)
        ctx.metric('anonymous_identity_leaks', 0)
      },
    }),
    defineOfflineEvalCase({
      id: 'DESKTOP-02', category: 'task-completion', title: 'missing second file blocks a false completion',
      run: (ctx) => twoFileScenario(ctx, false),
    }),
    defineOfflineEvalCase({
      id: 'DESKTOP-03', category: 'task-completion', title: 'both writes and host readback permit completion',
      run: (ctx) => twoFileScenario(ctx, true),
    }),
    defineOfflineEvalCase({
      id: 'DESKTOP-04', category: 'task-completion', title: 'MCP lookup cannot satisfy an external write request',
      async run(ctx) {
        createOwner(ctx)
        const name = 'mcp__notion__lookup'
        const dispose = registerDynamicTool({
          name, userId, origin: 'mcp', metadata: { category: 'read', isReadOnly: true },
          spec: { type: 'function', function: {
            name, description: 'Read-only Notion lookup.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          } },
        })
        ctx.defer(dispose)
        const prompt = 'Create a new Notion page and verify it.'
        let requests = 0
        const result = await runToolLoop({
          job: { id: 'desktop-mcp-read-eval', userId, origin: 'chat', prompt },
          step: { id: 'desktop-mcp-step', kind: 'chat' },
          messages: [{ role: 'user', content: prompt }],
          toolSpecs: [getDynamicTool(name, { userId }).spec], maxIters: 6, enableToolHooks: false,
          requestToolApproval: async ({ args }) => ({ proceed: true, args }),
          runModel: async () => ++requests === 1
            ? { content: '', toolCalls: [call('lookup', name, {})] }
            : { content: 'The page was created.', toolCalls: [] },
          executeTool: async () => ({ ok: true, rows: [] }),
        })
        assert.equal(result.incomplete, true)
        assert.equal(result.reason, 'execution_evidence_missing')
        ctx.metric('read_as_write_completions', 0)
      },
    }),
    defineOfflineEvalCase({
      id: 'DESKTOP-05', category: 'verification-scope', title: 'partial read and a foreign project never discharge file evidence',
      async run(ctx) {
        const root = path.resolve('selected-project')
        const target = path.join(root, 'src/a.js')
        const pending = new Set([target])
        assert.equal(clearVerifiedMutationTargets(pending,
          { name: 'read_file', args: { path: target, limit: 1 } },
          { ok: true, path: target, offset: 0, returnedLines: 1, totalLines: 3 }), false)
        const diff = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n-old\n+new\n'
        assert.equal(clearVerifiedMutationTargets(pending,
          { name: 'git_diff', args: { cwd: root } },
          { ok: true, diff, executionCwd: path.resolve('another-project') },
          { projectDirectory: root }), false)
        assert.equal(clearVerifiedMutationTargets(pending,
          { name: 'git_diff', args: { cwd: root } }, { ok: true, diff, executionCwd: root },
          { projectDirectory: root }), true)
        ctx.metric('foreign_or_partial_evidence_accepted', 0)
      },
    }),
    defineOfflineEvalCase({
      id: 'DESKTOP-06', category: 'evidence-authority', title: 'printed PDF markers and altered execution identities are rejected',
      async run(ctx) {
        assert.equal(isSuccessfulPdfLayoutVerification(
          { name: 'bash_exec', args: { command: 'python verify_pdf_layout.py' } },
          { ok: true, exitCode: 0, stdout: 'PDF_LAYOUT_VERIFICATION_OK\n',
            pdfLayoutVerification: { verified: true, version: 1, verifier: 'gugo_pdf_layout' } },
        ), false)
        const job = { id: 'turn', userId, modelName: 'local-a', modelProviderId: 'local' }
        const scope = createLoopExecutionScope({ job })
        assert.throws(() => assertLoopExecutionScope(scope, { job: { ...job, userId: 'foreign' } }), {
          code: 'LOOP_EXECUTION_SCOPE_DRIFT',
        })
        ctx.metric('forged_evidence_accepted', 0)
      },
    }),
    defineOfflineEvalCase({
      id: 'DESKTOP-07', category: 'local-model-binding', title: 'background memory keeps the selected local endpoint and cancellation',
      async run(ctx) {
        createOwner(ctx)
        let scheduled
        const requests = []
        const engine = new TurnEngine({
          persistence: createTestTurnEnginePersistence(),
          env: { MODEL_NAME: 'default-local', MODEL_BASE_URL: 'http://127.0.0.1:18888/v1' },
          toolSpecs: [],
          resolveModelBinding: () => ({ modelName: 'selected-local', providerId: 'local', configRevision: 1,
            env: { MODEL_NAME: 'selected-local', MODEL_BASE_URL: 'http://127.0.0.1:11434/v1' } }),
          preparePromptContext: async () => ({ messages: [], skillIds: [], memoryIds: [] }),
          runLoop: async () => ({ text: 'Completed.', artifactIds: [], iterations: 0 }),
          dispatchHooks: async () => ({ allow: true }),
          scheduleMemoryExtraction: (options) => { scheduled = options },
          scheduleExperienceAbstraction: () => {},
          runMemoryModel: async (request) => { requests.push(request); return '{"memories":[]}' },
        })
        ctx.defer(() => engine.shutdown())
        const scope = { userId, sessionId: 'desktop-binding-session', turnId: 'desktop-binding-turn' }
        await engine.startTurn({ ...scope, content: 'This desktop project keeps local SQLite data.' })
        await engine.waitForTurn(scope)
        await scheduled.callModel({ messages: [{ role: 'user', content: 'Extract facts.' }] })
        assert.equal(requests[0].modelName, 'selected-local')
        assert.equal(requests[0].env.MODEL_BASE_URL, 'http://127.0.0.1:11434/v1')
        assert.equal(requests[0].usageOwnerId, userId)
        await engine.shutdown()
        await assert.rejects(async () => scheduled.callModel({ messages: [] }), { name: 'AbortError' })
        assert.equal(requests.length, 1)
        ctx.metric('background_model_drift', 0)
      },
    }),
  ],
})
