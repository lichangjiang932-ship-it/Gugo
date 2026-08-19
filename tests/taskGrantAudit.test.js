import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-task-grant-audit-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, getDb } = await import('../server/db.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { runToolsLoop } = await import('../server/services/toolLoopRuntime.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const publishSpec = {
  type: 'function',
  function: {
    name: 'publish_report',
    description: 'Publish a report to one external channel.',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['channelId', 'text'],
      additionalProperties: false,
    },
  },
}

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('cron task grant writes auto_allowed audit with task_grant source', async () => {
  const { userId } = issueTestSession({ email: `task-grant-audit-${process.pid}@example.com` })
  setApprovalMode({ userId, mode: 'normal' })
  let modelCalls = 0
  let executions = 0
  await runToolsLoop({
    job: {
      id: 'cron-task-grant-audit',
      userId,
      sourceType: 'cron',
      sourceId: 'cron-audit',
      grants: [{ tool: 'publish_report', target: { channelId: 'C-ops' }, scope: 'forever' }],
      prompt: 'Publish the daily report to C-ops.',
    },
    step: { id: 'cron-task-grant-audit-step', kind: 'execute' },
    messages: [{ role: 'user', content: 'Publish the daily report to C-ops.' }],
    intentMode: 'execute',
    toolSpecs: [publishSpec],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async () => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'task-grant-call',
            type: 'function',
            function: { name: 'publish_report', arguments: '{"channelId":"C-ops","text":"daily"}' },
          }],
        }
      }
      return { content: 'Repository status checked.', toolCalls: [] }
    },
    executeTool: async () => {
      executions += 1
      return { ok: true, published: true }
    },
  })

  assert.equal(executions, 1)
  const rows = getDb().prepare(`
    SELECT stage, result_preview
      FROM tool_audit
     WHERE user_id = ? AND call_id = ?
     ORDER BY id
  `).all(userId, 'task-grant-call')
  assert.deepEqual(rows.map((row) => row.stage), ['proposed', 'started', 'auto_allowed', 'finished'])
  assert.match(rows.find((row) => row.stage === 'auto_allowed').result_preview, /task_grant/u)
})
