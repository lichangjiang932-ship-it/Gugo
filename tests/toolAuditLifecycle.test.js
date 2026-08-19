import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-tool-audit-lifecycle-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, getDb } = await import('../server/db.js')
const { runToolsLoop } = await import('../server/services/toolLoopRuntime.js')
const { listBuiltinSpecs } = await import('../server/services/toolRegistry.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const session = issueTestSession({ email: 'tool-audit-lifecycle@example.com' })
const bashSpec = listBuiltinSpecs().find((item) => item?.function?.name === 'bash_exec')

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

async function runScenario({ callId, args = { command: 'pwd' }, decision, expectedExecutions }) {
  let modelCalls = 0
  let executions = 0
  await runToolsLoop({
    job: {
      id: `audit-${callId}`,
      userId: session.userId,
      origin: 'chat',
      prompt: 'Inspect the current workspace and report the result.',
    },
    step: { id: `audit-${callId}`, kind: 'chat' },
    messages: [{ role: 'user', content: 'Inspect the current workspace and report the result.' }],
    intentMode: 'execute',
    toolSpecs: [bashSpec],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: callId,
            type: 'function',
            function: { name: 'bash_exec', arguments: JSON.stringify(args) },
          }],
        }
      }
      return { content: 'Inspection complete.', toolCalls: [] }
    },
    requestToolApproval: async (request) => {
      if (!decision) assert.fail('filtered calls must not reach approval')
      if (decision === 'auto_allowed') return { proceed: true, args: request.args }
      await request.onPending?.({
        id: `approval-${callId}`,
        toolName: request.toolName,
        args: request.args,
      })
      if (decision === 'approved') {
        return { proceed: true, args: request.args, approvalId: `approval-${callId}` }
      }
      return {
        proceed: false,
        args: request.args,
        approvalId: `approval-${callId}`,
        reason: 'Denied for lifecycle test',
      }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true, stdout: 'workspace', exitCode: 0 }
    },
  })
  assert.equal(executions, expectedExecutions)
  return getDb().prepare(`
    SELECT call_id, stage, status, args_json, result_preview
    FROM tool_audit
    WHERE user_id = ? AND call_id = ?
    ORDER BY id
  `).all(session.userId, callId)
}

test('tool audit lifecycle records every real stage on the matching call id', async () => {
  const auto = await runScenario({
    callId: 'audit-auto',
    decision: 'auto_allowed',
    expectedExecutions: 1,
  })
  const approved = await runScenario({
    callId: 'audit-approved',
    decision: 'approved',
    expectedExecutions: 1,
  })
  const denied = await runScenario({
    callId: 'audit-denied',
    decision: 'denied',
    expectedExecutions: 0,
  })
  const filtered = await runScenario({
    callId: 'audit-filtered',
    args: {},
    decision: null,
    expectedExecutions: 0,
  })

  assert.deepEqual(auto.map((row) => row.stage), [
    'proposed', 'started', 'auto_allowed', 'finished',
  ])
  assert.deepEqual(approved.map((row) => row.stage), [
    'proposed', 'started', 'approval_requested', 'approved', 'finished',
  ])
  assert.deepEqual(denied.map((row) => row.stage), [
    'proposed', 'started', 'approval_requested', 'denied',
  ])
  assert.deepEqual(filtered.map((row) => row.stage), [
    'proposed', 'started', 'filtered',
  ])
  const allStages = new Set([...auto, ...approved, ...denied, ...filtered].map((row) => row.stage))
  assert.deepEqual([...allStages].sort(), [
    'approval_requested',
    'approved',
    'auto_allowed',
    'denied',
    'filtered',
    'finished',
    'proposed',
    'started',
  ])
  for (const [expectedCallId, rows] of [
    ['audit-auto', auto],
    ['audit-approved', approved],
    ['audit-denied', denied],
    ['audit-filtered', filtered],
  ]) {
    assert.ok(rows.length > 0)
    assert.ok(rows.every((row) => row.call_id === expectedCallId))
  }
  assert.equal(auto.at(-1).status, 'ok')
  assert.match(auto.at(-1).result_preview, /workspace/u)
  assert.equal(denied.at(-1).status, 'denied')
})
