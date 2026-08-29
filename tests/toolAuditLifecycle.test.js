import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-tool-audit-lifecycle-'))
process.env.APP_DATA_DIR = tempDir

const { closeDb, getDb, setUserToolPermission } = await import('../server/db.js')
const { runToolsLoop } = await import('../server/services/toolLoopRuntime.js')
const { listBuiltinSpecs } = await import('../server/services/toolRegistry.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const session = issueTestSession({ email: 'tool-audit-lifecycle@example.com' })
const bashSpec = listBuiltinSpecs().find((item) => item?.function?.name === 'bash_exec')
const runCodeSpec = listBuiltinSpecs().find((item) => item?.function?.name === 'run_code')

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

test('run_code follows the real approval, worker execution, and audit pipeline', async () => {
  const callId = 'audit-run-code'
  const sourceSentinel = 'RUN_CODE_SUCCESS_SOURCE_SENTINEL_4f91'
  const source = `const ${sourceSentinel} = 20; return ${sourceSentinel} + 22`
  let modelCalls = 0
  let approvals = 0
  const result = await runToolsLoop({
    job: {
      id: callId,
      userId: session.userId,
      origin: 'chat',
      prompt: 'Calculate 20 plus 22 with the bounded code worker.',
    },
    step: { id: callId, kind: 'chat' },
    messages: [{ role: 'user', content: 'Calculate 20 plus 22 with the bounded code worker.' }],
    intentMode: 'execute',
    toolSpecs: [runCodeSpec],
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
            function: {
              name: 'run_code',
              arguments: JSON.stringify({
                code: source,
                description: 'Add two numbers',
              }),
            },
          }],
        }
      }
      return { content: 'The result is 42.', toolCalls: [] }
    },
    requestToolApproval: async (request) => {
      approvals += 1
      assert.equal(request.toolName, 'run_code')
      assert.equal(request.args.description, 'Add two numbers')
      await request.onPending?.({
        id: 'approval-run-code',
        toolName: request.toolName,
        args: request.args,
      })
      return {
        proceed: true,
        args: request.args,
        approvalId: 'approval-run-code',
      }
    },
  })

  assert.equal(approvals, 1)
  assert.match(result.text, /42/u)
  const rows = getDb().prepare(`
    SELECT call_id, stage, status, args_json, result_preview
    FROM tool_audit
    WHERE user_id = ? AND call_id = ?
    ORDER BY id
  `).all(session.userId, callId)
  assert.deepEqual(rows.map((row) => row.stage), [
    'proposed',
    'started',
    'approval_requested',
    'approved',
    'finished',
  ])
  assert.ok(rows.every((row) => row.call_id === callId))
  assert.ok(rows.every((row) => !row.args_json.includes(sourceSentinel)))
  assert.ok(rows.every((row) => !row.args_json.includes(source)))
  const expectedCodeSha256 = createHash('sha256').update(source).digest('hex')
  assert.ok(rows.every((row) => {
    const args = JSON.parse(row.args_json)
    return !Object.hasOwn(args, 'code')
      && args.codeBytes === Buffer.byteLength(source, 'utf8')
      && args.codeSha256 === expectedCodeSha256
  }))
  assert.ok(rows.every((row) => !String(row.result_preview || '').includes(sourceSentinel)))
  assert.equal(rows.at(-1).status, 'ok')
  assert.match(rows.at(-1).result_preview, /"ok":true/u)
  assert.match(rows.at(-1).result_preview, /"valueType":"number"/u)
})

test('run_code lifecycle audit omits worker exception source text', async () => {
  const callId = 'audit-run-code-exception-redaction'
  const sourceSentinel = 'RUN_CODE_FAILURE_SOURCE_SENTINEL_82ad'
  const source = `throw new Error("${sourceSentinel}")`
  let modelCalls = 0
  await runToolsLoop({
    job: {
      id: callId,
      userId: session.userId,
      origin: 'chat',
      prompt: 'Run one bounded failing computation.',
    },
    step: { id: callId, kind: 'chat' },
    messages: [{ role: 'user', content: 'Run one bounded failing computation.' }],
    intentMode: 'execute',
    toolSpecs: [runCodeSpec],
    maxIters: 3,
    enableToolHooks: false,
    runModel: async ({ messages }) => {
      modelCalls += 1
      if (modelCalls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: callId,
            type: 'function',
            function: {
              name: 'run_code',
              arguments: JSON.stringify({ code: source, description: 'Expected failure' }),
            },
          }],
        }
      }
      const toolResult = messages.find((message) => (
        message.role === 'tool' && message.name === 'run_code'
      ))
      assert.match(String(toolResult?.content || ''), /code_mode_exception/u)
      return { content: 'The bounded computation failed as expected.', toolCalls: [] }
    },
    requestToolApproval: async (request) => {
      await request.onPending?.({
        id: 'approval-run-code-exception-redaction',
        toolName: request.toolName,
        args: request.args,
      })
      return {
        proceed: true,
        args: request.args,
        approvalId: 'approval-run-code-exception-redaction',
      }
    },
  })

  const rows = getDb().prepare(`
    SELECT stage, status, args_json, result_preview
    FROM tool_audit
    WHERE user_id = ? AND call_id = ?
    ORDER BY id
  `).all(session.userId, callId)
  assert.deepEqual(rows.map((row) => row.stage), [
    'proposed',
    'started',
    'approval_requested',
    'approved',
    'finished',
  ])
  assert.ok(rows.every((row) => !row.args_json.includes(sourceSentinel)))
  assert.ok(rows.every((row) => !String(row.result_preview || '').includes(sourceSentinel)))
  const expectedCodeSha256 = createHash('sha256').update(source).digest('hex')
  assert.ok(rows.every((row) => {
    const args = JSON.parse(row.args_json)
    return !Object.hasOwn(args, 'code')
      && args.codeBytes === Buffer.byteLength(source, 'utf8')
      && args.codeSha256 === expectedCodeSha256
  }))
  assert.equal(rows.at(-1).status, 'error')
  assert.match(rows.at(-1).result_preview, /code_mode_exception/u)
  assert.match(rows.at(-1).result_preview, /"errorPresent":true/u)
})

test('run_code approval cannot bypass execution trust revoked before dispatch', async () => {
  const callId = 'audit-run-code-revoked'
  const envKeys = [
    'AUTH_MODE',
    'SERVER_HOST',
    'LOCAL_CODE_EXECUTION_ENABLED',
    'WORKSPACE_SHELL_ENABLED',
  ]
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  let observedToolResult = null
  let approvals = 0
  try {
    process.env.AUTH_MODE = 'multi_user'
    process.env.SERVER_HOST = '0.0.0.0'
    process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'
    process.env.WORKSPACE_SHELL_ENABLED = '0'
    setUserToolPermission({ userId: session.userId, toolName: 'run_code', enabled: true })

    await runToolsLoop({
      job: {
        id: callId,
        userId: session.userId,
        origin: 'chat',
        prompt: 'Run one bounded computation.',
      },
      step: { id: callId, kind: 'chat' },
      messages: [{ role: 'user', content: 'Run one bounded computation.' }],
      intentMode: 'execute',
      toolSpecs: [runCodeSpec],
      maxIters: 3,
      enableToolHooks: false,
      runModel: async ({ messages }) => {
        const toolMessage = messages.find((message) => (
          message.role === 'tool' && message.name === 'run_code'
        ))
        if (toolMessage) {
          observedToolResult = JSON.parse(toolMessage.content)
          return { content: `Execution blocked: ${observedToolResult.code}`, toolCalls: [] }
        }
        return {
          content: '',
          toolCalls: [{
            id: callId,
            type: 'function',
            function: {
              name: 'run_code',
              arguments: JSON.stringify({ code: 'return "must not execute"' }),
            },
          }],
        }
      },
      requestToolApproval: async (request) => {
        approvals += 1
        await request.onPending?.({
          id: 'approval-run-code-revoked',
          toolName: request.toolName,
          args: request.args,
        })
        process.env.LOCAL_CODE_EXECUTION_ENABLED = '0'
        return {
          proceed: true,
          args: request.args,
          approvalId: 'approval-run-code-revoked',
        }
      },
    })

    assert.equal(approvals, 1)
    assert.equal(observedToolResult?.ok, false)
    assert.equal(observedToolResult?.code, 'CODE_MODE_DISABLED')
    assert.equal(observedToolResult?.denied, true)
    const rows = getDb().prepare(`
      SELECT stage, status, result_preview
      FROM tool_audit
      WHERE user_id = ? AND call_id = ?
      ORDER BY id
    `).all(session.userId, callId)
    assert.deepEqual(rows.map((row) => row.stage), [
      'proposed',
      'started',
      'approval_requested',
      'approved',
      'finished',
    ])
    assert.equal(rows.at(-1).status, 'denied')
    assert.match(rows.at(-1).result_preview, /CODE_MODE_DISABLED/u)
  } finally {
    setUserToolPermission({ userId: session.userId, toolName: 'run_code', enabled: true })
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
