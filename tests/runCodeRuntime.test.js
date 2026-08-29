import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-run-code-runtime-'))
const originalEnv = Object.fromEntries([
  'APP_DATA_DIR',
  'APP_DB_PATH',
  'AUTH_MODE',
  'SERVER_HOST',
  'LOCAL_CODE_EXECUTION_ENABLED',
  'WORKSPACE_SHELL_ENABLED',
].map((key) => [key, process.env[key]]))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')
process.env.AUTH_MODE = 'multi_user'
process.env.SERVER_HOST = '0.0.0.0'
process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'
delete process.env.WORKSPACE_SHELL_ENABLED

const {
  closeDb,
  createUser,
  getDb,
  setUserToolPermission,
} = await import('../server/db.js')
const { codeModeLimiter } = await import('../server/utils/rateLimiter.js')
const {
  RUN_CODE_TOOL_SPECS,
  dispatchRunCodeTool,
  isRunCodeExecutionEnabled,
} = await import('../server/services/runCodeRuntime.js')
const { executeServerTool } = await import('../server/services/loop/heuristics/toolExecutor.js')

const userId = `run-code-runtime-${process.pid}`
createUser({ id: userId, email: `${userId}@example.com` })

test.beforeEach(() => {
  process.env.AUTH_MODE = 'multi_user'
  process.env.SERVER_HOST = '0.0.0.0'
  process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'
  delete process.env.WORKSPACE_SHELL_ENABLED
  setUserToolPermission({ userId, toolName: 'run_code', enabled: true })
  codeModeLimiter.reset(userId, 'run_code')
  getDb().prepare('DELETE FROM tool_audit WHERE user_id = ? AND tool_name = ?').run(userId, 'run_code')
})

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('run_code publishes a minimal pure-computation schema', () => {
  assert.equal(RUN_CODE_TOOL_SPECS.length, 1)
  const spec = RUN_CODE_TOOL_SPECS[0]
  assert.equal(spec.function.name, 'run_code')
  assert.deepEqual(spec.function.parameters.required, ['code'])
  assert.deepEqual(Object.keys(spec.function.parameters.properties).sort(), [
    'code',
    'description',
  ])
  assert.equal(spec.function.parameters.additionalProperties, false)
  assert.match(spec.function.description, /not an operating-system security boundary/iu)
  assert.doesNotMatch(
    Object.keys(spec.function.parameters.properties).join(' '),
    /path|command|network|fetch|tool_calls/iu,
  )
})

test('run_code dispatcher returns bounded JSON computation results', async () => {
  const result = await dispatchRunCodeTool('run_code', {
    code: "console.log('sum'); return [20, 22].reduce((a, b) => a + b, 0)",
    description: 'Add two numbers',
  }, { userId })

  assert.deepEqual(result, {
    ok: true,
    logs: ['sum'],
    value: 42,
  })
})

test('run_code dispatcher normalizes deterministic worker failures', async () => {
  const result = await dispatchRunCodeTool('run_code', {
    code: 'throw new Error("expected failure")',
  }, { userId })

  assert.deepEqual(result, {
    ok: false,
    code: 'code_mode_exception',
    error: 'Error: expected failure',
    logs: [],
    retryable: false,
  })
  assert.equal((await dispatchRunCodeTool('missing', {}, { userId })).code, 'unknown_code_mode_tool')
})

test('executeServerTool routes run_code through the canonical server executor', async () => {
  const result = await executeServerTool({
    name: 'run_code',
    args: { code: 'return { routed: true }' },
    job: { userId },
    signal: new AbortController().signal,
  })

  assert.deepEqual(result, {
    ok: true,
    logs: [],
    value: { routed: true },
  })
  assert.equal(
    executeServerTool.supportsIdempotentResume({
      name: 'run_code',
      idempotencyKey: 'run-code-resume',
    }),
    false,
  )
})

test('run_code cancellation terminates the in-flight worker', async () => {
  const controller = new AbortController()
  const pending = executeServerTool({
    name: 'run_code',
    args: { code: 'await new Promise(() => {})' },
    job: { userId },
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 25)

  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'code_mode_cancelled')
  assert.equal(result.retryable, false)
  const row = getDb().prepare(`
    SELECT status FROM tool_audit
    WHERE user_id = ? AND tool_name = ? AND origin = 'code_mode'
    ORDER BY id DESC LIMIT 1
  `).get(userId, 'run_code')
  assert.equal(row.status, 'cancelled')
})

test('run_code enablement honors local-code and trusted workspace shell policies', () => {
  assert.equal(isRunCodeExecutionEnabled({
    AUTH_MODE: 'multi_user',
    SERVER_HOST: '0.0.0.0',
    LOCAL_CODE_EXECUTION_ENABLED: '0',
    WORKSPACE_SHELL_ENABLED: '0',
  }), false)
  assert.equal(isRunCodeExecutionEnabled({
    AUTH_MODE: 'multi_user',
    SERVER_HOST: '0.0.0.0',
    LOCAL_CODE_EXECUTION_ENABLED: '1',
    WORKSPACE_SHELL_ENABLED: '0',
  }), true)
  assert.equal(isRunCodeExecutionEnabled({
    AUTH_MODE: 'multi_user',
    SERVER_HOST: '0.0.0.0',
    LOCAL_CODE_EXECUTION_ENABLED: '0',
    WORKSPACE_SHELL_ENABLED: '1',
  }), true)
})

test('direct run_code calls cannot bypass deployment trust, identity, or user permission', async () => {
  const args = { code: 'return "must not run"', description: 'guard check' }
  await assert.rejects(
    () => dispatchRunCodeTool('run_code', args, {
      userId,
      env: {
        AUTH_MODE: 'multi_user',
        SERVER_HOST: '0.0.0.0',
        LOCAL_CODE_EXECUTION_ENABLED: '0',
        WORKSPACE_SHELL_ENABLED: '0',
      },
    }),
    (error) => error?.code === 'CODE_MODE_DISABLED' && error?.statusCode === 403,
  )

  await assert.rejects(
    () => dispatchRunCodeTool('run_code', args, {
      env: {
        AUTH_MODE: 'multi_user',
        SERVER_HOST: '0.0.0.0',
        LOCAL_CODE_EXECUTION_ENABLED: '1',
        WORKSPACE_SHELL_ENABLED: '0',
      },
    }),
    (error) => error?.code === 'USER_REQUIRED' && error?.statusCode === 403,
  )

  await assert.rejects(
    () => dispatchRunCodeTool('run_code', args, {
      userId: '   ',
      env: {
        AUTH_MODE: 'multi_user',
        SERVER_HOST: '0.0.0.0',
        LOCAL_CODE_EXECUTION_ENABLED: '0',
        WORKSPACE_SHELL_ENABLED: '1',
      },
    }),
    (error) => error?.code === 'USER_REQUIRED' && error?.statusCode === 403,
  )

  setUserToolPermission({ userId, toolName: 'run_code', enabled: false })
  await assert.rejects(
    () => dispatchRunCodeTool('run_code', args, { userId }),
    (error) => error?.code === 'TOOL_DISABLED' && error?.statusCode === 403,
  )

  const deniedRows = getDb().prepare(`
    SELECT status, args_json, result_preview FROM tool_audit
    WHERE user_id = ? AND tool_name = ? AND origin = 'code_mode'
    ORDER BY id
  `).all(userId, 'run_code')
  assert.deepEqual(deniedRows.map((row) => row.status), ['denied', 'denied'])
  assert.ok(deniedRows.every((row) => !row.args_json.includes('must not run')))
  assert.ok(deniedRows.every((row) => /codeSha256/u.test(row.args_json)))
})

test('run_code applies a per-user worker creation rate limit before execution', async () => {
  for (let index = 0; index < 8; index += 1) {
    assert.equal(codeModeLimiter.tryConsume(userId, 'run_code'), true)
  }
  await assert.rejects(
    () => dispatchRunCodeTool('run_code', { code: 'return 1' }, { userId }),
    (error) => error?.code === 'RUN_CODE_RATE_LIMITED' && error?.statusCode === 429,
  )
  const row = getDb().prepare(`
    SELECT status, result_preview FROM tool_audit
    WHERE user_id = ? AND tool_name = ? AND origin = 'code_mode'
    ORDER BY id DESC LIMIT 1
  `).get(userId, 'run_code')
  assert.equal(row.status, 'denied')
  assert.match(row.result_preview, /RUN_CODE_RATE_LIMITED/u)
})

test('direct run_code audit distinguishes successful and failed worker outcomes', async () => {
  await dispatchRunCodeTool('run_code', { code: 'return 42' }, { userId })
  await dispatchRunCodeTool('run_code', { code: 'throw new Error("audit failure")' }, { userId })
  const rows = getDb().prepare(`
    SELECT status, args_json, result_preview FROM tool_audit
    WHERE user_id = ? AND tool_name = ? AND origin = 'code_mode'
    ORDER BY id
  `).all(userId, 'run_code')
  assert.deepEqual(rows.map((row) => row.status), ['ok', 'error'])
  assert.ok(rows.every((row) => !row.args_json.includes('return 42')))
  assert.ok(rows.every((row) => !row.args_json.includes('audit failure')))
  assert.ok(rows.every((row) => !String(row.result_preview || '').includes('return 42')))
  assert.ok(rows.every((row) => !String(row.result_preview || '').includes('audit failure')))
  assert.match(rows[0].result_preview, /"valueType":"number"/u)
  assert.match(rows[1].result_preview, /code_mode_exception/u)
})
