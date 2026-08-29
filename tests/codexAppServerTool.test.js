import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-codex-tool-'))
const originalEnv = Object.fromEntries(['APP_DATA_DIR', 'APP_DB_PATH'].map((key) => [key, process.env[key]]))
process.env.APP_DATA_DIR = tempDir
process.env.APP_DB_PATH = path.join(tempDir, 'app.db')

const {
  closeDb,
  createUser,
  getDb,
  setUserToolPermission,
} = await import('../server/db.js')
const {
  closeCodexAppServerRuntime,
  startCodexAppServerRuntime,
} = await import('../server/services/codexAppServerRuntime.js')
const {
  CODEX_APP_SERVER_TOOL_SPECS,
  CODEX_MODELS_TOOL_NAME,
  dispatchCodexAppServerTool,
} = await import('../server/services/codexAppServerTool.js')
const { executeServerTool } = await import('../server/services/loop/heuristics/toolExecutor.js')
const { resolveTurnToolSpecs } = await import('../server/services/turnToolSpecs.js')
const { getBuiltinSpec } = await import('../server/services/toolRegistry.js')
const {
  buildRememberedGrant,
  classifyToolRisk,
  requiresPerCallApproval,
} = await import('../server/utils/approvalPolicy.js')
const { codexAppServerLimiter } = await import('../server/utils/rateLimiter.js')
const { writeToolAudit } = await import('../server/utils/audit.js')

const userId = `codex-models-tool-${process.pid}`
createUser({ id: userId, email: `${userId}@example.com` })

function fakeChild(onMessage) {
  const child = new EventEmitter()
  child.pid = 4242
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  let pending = ''
  let exited = false
  child.emitExit = () => {
    if (exited) return
    exited = true
    child.emit('exit', 0, null)
  }
  child.stdin.on('data', (chunk) => {
    pending += chunk.toString('utf8')
    for (;;) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (!line) continue
      Promise.resolve(onMessage(JSON.parse(line), child))
        .catch((error) => child.emit('error', error))
    }
  })
  return child
}

function startOptions(onMessage) {
  return {
    cwd: 'D:\\workspace',
    env: { CODEX_APP_SERVER_ENABLED: '1' },
    platform: 'win32',
    resolveExecutable: () => ({
      configured: false,
      found: true,
      path: 'C:\\Codex\\codex.exe',
      source: 'desktop-install',
      reasonCode: null,
    }),
    snapshotExecutable: (executable) => ({ path: executable, cleanup() {} }),
    verifySignature: async () => true,
    readVersion: async () => '0.150.0-test',
    spawnImpl: () => fakeChild((message, child) => {
      if (message.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`)
        return
      }
      return onMessage?.(message, child)
    }),
    terminate: async ({ child }) => {
      child.emitExit()
      return true
    },
    handshakeTimeoutMs: 500,
    signatureTimeoutMs: 500,
    versionTimeoutMs: 500,
    exitTimeoutMs: 100,
  }
}

async function closeRuntime() {
  await closeCodexAppServerRuntime({
    terminate: async ({ child }) => {
      child?.emitExit?.()
      return true
    },
    exitTimeoutMs: 100,
  })
}

test.beforeEach(async () => {
  await closeRuntime()
  setUserToolPermission({ userId, toolName: CODEX_MODELS_TOOL_NAME, enabled: true })
  codexAppServerLimiter.reset(userId, CODEX_MODELS_TOOL_NAME)
  getDb().prepare('DELETE FROM tool_audit WHERE user_id = ? AND tool_name = ?')
    .run(userId, CODEX_MODELS_TOOL_NAME)
})

test.after(async () => {
  await closeRuntime()
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('codex_models exposes only a fixed bounded model/list contract when the bridge is ready', async () => {
  const spec = CODEX_APP_SERVER_TOOL_SPECS[0]
  assert.equal(spec.function.name, CODEX_MODELS_TOOL_NAME)
  assert.equal(spec.function.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(spec.function.parameters.properties).sort(), [
    'cursor',
    'include_hidden',
    'limit',
  ])
  assert.doesNotMatch(JSON.stringify(spec), /method|params|account|thread|command/iu)

  const hidden = await resolveTurnToolSpecs({
    userId,
    baseSpecs: [getBuiltinSpec(CODEX_MODELS_TOOL_NAME)],
    enabledConnectorTools: [],
  })
  assert.equal(hidden.some((entry) => entry.function.name === CODEX_MODELS_TOOL_NAME), false)

  await startCodexAppServerRuntime(startOptions())
  const visible = await resolveTurnToolSpecs({
    userId,
    baseSpecs: [getBuiltinSpec(CODEX_MODELS_TOOL_NAME)],
    enabledConnectorTools: [],
  })
  assert.equal(visible.some((entry) => entry.function.name === CODEX_MODELS_TOOL_NAME), true)
})

test('Agent executor consumes model/list and returns only the public model projection', async () => {
  const messages = []
  await startCodexAppServerRuntime(startOptions((message, child) => {
    messages.push(message)
    if (message.method !== 'model/list') return
    child.stdout.write(`${JSON.stringify({
      id: message.id,
      result: {
        data: [{
          id: 'gpt-5-codex',
          model: 'gpt-5-codex',
          displayName: 'GPT-5 Codex',
          description: 'Coding model',
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'private' }],
          inputModalities: ['text', 'image'],
          supportsPersonality: true,
          isDefault: true,
          privateCredential: 'must-not-cross-boundary',
        }],
        nextCursor: 'page-2',
        privateServerState: 'must-not-cross-boundary',
      },
    })}\n`)
  }))

  const result = await executeServerTool({
    name: CODEX_MODELS_TOOL_NAME,
    args: { limit: 1, include_hidden: false },
    job: { userId },
    signal: new AbortController().signal,
  })

  assert.equal(result.ok, true)
  const modelListMessages = messages.filter((message) => message.method === 'model/list')
  assert.equal(modelListMessages.length, 1)
  assert.deepEqual(modelListMessages[0].params, { cursor: null, limit: 1, includeHidden: false })
  assert.deepEqual(result, {
    ok: true,
    models: [{
      id: 'gpt-5-codex',
      model: 'gpt-5-codex',
      displayName: 'GPT-5 Codex',
      description: 'Coding model',
      hidden: false,
      reasoningEfforts: ['high'],
      inputModalities: ['text', 'image'],
      supportsPersonality: true,
      isDefault: true,
    }],
    next_cursor: 'page-2',
  })
  assert.doesNotMatch(JSON.stringify(result), /privateCredential|privateServerState|must-not-cross/iu)
  const row = getDb().prepare(`
    SELECT origin, status, args_json, result_preview FROM tool_audit
    WHERE user_id = ? AND tool_name = ? ORDER BY id DESC LIMIT 1
  `).get(userId, CODEX_MODELS_TOOL_NAME)
  assert.equal(row.origin, 'codex_app_server')
  assert.equal(row.status, 'ok')
  assert.doesNotMatch(`${row.args_json}${row.result_preview}`, /gpt-5|private/iu)
})

test('generic Agent-loop audit also minimizes codex_models cursors and catalog data', () => {
  const callId = 'generic-codex-models-audit'
  writeToolAudit({
    userId,
    origin: 'chat',
    toolName: CODEX_MODELS_TOOL_NAME,
    callId,
    stage: 'finished',
    args: {
      cursor: 'opaque-cursor-must-not-be-persisted',
      limit: 2,
      include_hidden: true,
    },
    result: {
      ok: true,
      models: [{
        id: 'private-model-id',
        model: 'private-model-name',
        description: 'private-model-description',
      }],
      next_cursor: 'next-cursor-must-not-be-persisted',
      privateServerState: 'private-server-state',
    },
    status: 'ok',
  })

  const row = getDb().prepare(`
    SELECT args_json, result_preview FROM tool_audit
    WHERE user_id = ? AND tool_name = ? AND call_id = ?
  `).get(userId, CODEX_MODELS_TOOL_NAME, callId)
  assert.deepEqual(JSON.parse(row.args_json), {
    limit: 2,
    includeHidden: true,
    hasCursor: true,
  })
  assert.deepEqual(JSON.parse(row.result_preview), {
    ok: true,
    modelCount: 1,
    hasNextCursor: true,
  })
  assert.doesNotMatch(`${row.args_json}${row.result_preview}`, /opaque|private|cursor-must-not/iu)
})

test('codex_models enforces identity, readiness, static permission, and rate limiting', async () => {
  assert.equal((await dispatchCodexAppServerTool(CODEX_MODELS_TOOL_NAME, {}, {})).code,
    'CODEX_APP_SERVER_USER_REQUIRED')
  assert.equal((await dispatchCodexAppServerTool(CODEX_MODELS_TOOL_NAME, {}, { userId })).code,
    'CODEX_APP_SERVER_UNAVAILABLE')

  await startCodexAppServerRuntime(startOptions((message, child) => {
    if (message.method === 'model/list') {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`)
    }
  }))
  setUserToolPermission({ userId, toolName: CODEX_MODELS_TOOL_NAME, enabled: false })
  assert.equal((await dispatchCodexAppServerTool(CODEX_MODELS_TOOL_NAME, {}, { userId })).code,
    'TOOL_DISABLED')
  setUserToolPermission({ userId, toolName: CODEX_MODELS_TOOL_NAME, enabled: true })

  for (let index = 0; index < 3; index += 1) {
    assert.equal(codexAppServerLimiter.tryConsume(userId, CODEX_MODELS_TOOL_NAME), true)
  }
  assert.equal((await dispatchCodexAppServerTool(CODEX_MODELS_TOOL_NAME, {}, { userId })).code,
    'CODEX_APP_SERVER_RATE_LIMITED')
})

test('codex_models is always a fresh human decision, including bypass mode', () => {
  assert.equal(requiresPerCallApproval(CODEX_MODELS_TOOL_NAME), true)
  assert.throws(() => buildRememberedGrant(CODEX_MODELS_TOOL_NAME, {}), /cannot be remembered/iu)
  for (const permissionMode of ['normal', 'acceptEdits', 'bypass']) {
    const result = classifyToolRisk(CODEX_MODELS_TOOL_NAME, {}, {
      origin: 'chat',
      mode: 'unattended',
      permissionMode,
      metadata: { riskClass: 'external', requiresApproval: true },
    })
    assert.equal(result.needsApproval, true, permissionMode)
    assert.equal(result.risk, 'high', permissionMode)
  }
  const plan = classifyToolRisk(CODEX_MODELS_TOOL_NAME, {}, {
    origin: 'chat',
    mode: 'unattended',
    permissionMode: 'plan',
  })
  assert.equal(plan.denied, true)
  const queueOff = classifyToolRisk(CODEX_MODELS_TOOL_NAME, {}, {
    origin: 'chat',
    mode: 'off',
    permissionMode: 'normal',
  })
  assert.equal(queueOff.denied, true)
})

test('an in-flight codex_models request is cancellable without exposing protocol details', async () => {
  await startCodexAppServerRuntime(startOptions())
  const controller = new AbortController()
  const pending = executeServerTool({
    name: CODEX_MODELS_TOOL_NAME,
    args: { limit: 1 },
    job: { userId },
    signal: controller.signal,
  })
  setImmediate(() => controller.abort(new DOMException('private cancellation', 'AbortError')))
  const result = await pending
  assert.deepEqual(result, {
    ok: false,
    code: 'CODEX_APP_SERVER_REQUEST_CANCELLED',
    error: 'CODEX_APP_SERVER_REQUEST_CANCELLED',
    retryable: false,
    cancelled: true,
  })
  const row = getDb().prepare(`
    SELECT status, result_preview FROM tool_audit
    WHERE user_id = ? AND tool_name = ? ORDER BY id DESC LIMIT 1
  `).get(userId, CODEX_MODELS_TOOL_NAME)
  assert.equal(row.status, 'cancelled')
  assert.doesNotMatch(row.result_preview, /private cancellation/iu)
})

test('codex_models rejects request-shaped responses and locally filters hidden models', async () => {
  await startCodexAppServerRuntime(startOptions((message, child) => {
    if (message.method !== 'model/list') return
    child.stdout.write(`${JSON.stringify({
      id: message.id,
      method: 'thread/start',
      result: { data: [] },
    })}\n`)
  }))
  const forged = await dispatchCodexAppServerTool(CODEX_MODELS_TOOL_NAME, {}, { userId })
  assert.equal(forged.code, 'CODEX_APP_SERVER_RESPONSE_INVALID')
  await closeRuntime()

  await startCodexAppServerRuntime(startOptions((message, child) => {
    if (message.method !== 'model/list') return
    child.stdout.write(`${JSON.stringify({
      id: message.id,
      result: {
        data: [
          { id: 'hidden', model: 'hidden', hidden: true, description: 'confidential' },
          { id: 'visible', model: 'visible', hidden: false },
        ],
      },
    })}\n`)
  }))
  const filtered = await dispatchCodexAppServerTool(
    CODEX_MODELS_TOOL_NAME,
    { include_hidden: false },
    { userId },
  )
  assert.deepEqual(filtered.models.map((entry) => entry.id), ['visible'])
})
