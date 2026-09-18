import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bashExecTool } from '../server/adapters/fsShellExecution.js'
import { runCommandTool, runTestTool } from '../server/adapters/codingAgentTools.js'
import { closeAllShellSessions } from '../server/services/shellSessionStore.js'
import { verifyStepEvidence } from '../server/services/goalPlanEvidence.js'

const PRINT_CWD = 'node -e "process.stdout.write(process.cwd())"'
const savedEnv = Object.fromEntries([
  'WORKSPACE_ROOT', 'WORKSPACE_SHELL_ENABLED', 'WORKSPACE_SHARED_TRUSTED',
  'SHELL_SANDBOX_MODE', 'SHELL_REQUIRE_OS_ISOLATION',
].map((key) => [key, process.env[key]]))
let workspace
let outside

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-execution-cwd-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-execution-cwd-outside-'))
  fs.mkdirSync(path.join(workspace, 'nested cwd'))
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_SHELL_ENABLED = '1'
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
  process.env.SHELL_SANDBOX_MODE = 'host'
  process.env.SHELL_REQUIRE_OS_ISOLATION = '0'
})
beforeEach(async () => closeAllShellSessions())
after(async () => {
  await closeAllShellSessions()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const directory of [workspace, outside]) {
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

function canonical(value) {
  assert.equal(typeof value, 'string', 'execution cwd must be a recorded absolute string')
  assert.equal(path.isAbsolute(value), true)
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function evidence(result, { requestedCwd = workspace, expectedCwd = workspace, command = PRINT_CWD, name = 'bash_exec' } = {}) {
  const args = { command, cwd: requestedCwd }
  const scope = { turnId: 'cwd-turn', sessionId: 'cwd-session' }
  return verifyStepEvidence({
    sessionId: scope.sessionId, evidence: { turnId: scope.turnId, toolCallId: 'cwd-call' },
    acceptance: [{ kind: 'command', tools: [name], command, cwd: expectedCwd }],
    events: [
      { ...scope, type: 'tool.started', payload: { toolCallId: 'cwd-call', name, args } },
      { ...scope, type: 'tool.completed', payload: { toolCallId: 'cwd-call', name, result } },
    ],
  })
}

test('a fresh real Shell records its absolute execution cwd without changing display cwd', async () => {
  const result = await bashExecTool({ command: PRINT_CWD, timeout_ms: 20_000, executionCwd: outside })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.cwd, '', 'workspace-root display paths stay compatible')
  assert.equal(canonical(result.executionCwd), canonical(fs.realpathSync(workspace)))
  assert.equal(canonical(result.stdout.trim()), canonical(result.executionCwd))
})

test('a reused real Shell distinguishes cwd before cd from cwd after it and from the next requested cwd', async () => {
  const changed = await bashExecTool({ command: 'cd "nested cwd"', session: 'reuse', timeout_ms: 20_000 })
  assert.equal(changed.ok, true, JSON.stringify(changed))
  assert.equal(changed.cwd, 'nested cwd')
  assert.equal(canonical(changed.executionCwd), canonical(workspace), 'the cd command began at the root')
  const observed = await bashExecTool({ command: PRINT_CWD, session: 'reuse', cwd: workspace, timeout_ms: 20_000 })
  assert.equal(observed.ok, true, JSON.stringify(observed))
  assert.equal(canonical(observed.executionCwd), canonical(path.join(workspace, 'nested cwd')))
  assert.equal(canonical(observed.stdout.trim()), canonical(observed.executionCwd))
  assert.equal(evidence(observed).verified, false, 'the requested root cannot conceal execution in a retained subdirectory')
  assert.equal(evidence(observed, { expectedCwd: path.join(workspace, 'nested cwd') }).verified, true)
})

test('a host execution cwd overrides a conflicting requested cwd in command evidence', () => {
  const result = { ok: true, exitCode: 0, cwd: '', executionCwd: path.join(workspace, 'nested cwd') }
  assert.equal(evidence(result).verified, false)
  assert.equal(evidence(result, { expectedCwd: result.executionCwd }).verified, true)
})

test('a present but invalid execution cwd never falls back to requested location', () => {
  for (const executionCwd of [null, '', 'nested cwd', 42, { path: workspace }]) {
    assert.equal(evidence({ ok: true, exitCode: 0, cwd: workspace, executionCwd }).verified, false)
  }
})

test('legacy receipts without executionCwd retain their existing comparison behavior', () => {
  assert.equal(evidence({ ok: true, exitCode: 0, cwd: '' }).verified, true)
  assert.equal(evidence({ ok: true, exitCode: 0, cwd: workspace }, { requestedCwd: '' }).verified, true)
  assert.equal(evidence({ ok: true, exitCode: 0, cwd: '' }, { requestedCwd: outside }).verified, false)
})

test('command and test wrappers retain the host cwd receipt', async () => {
  for (const [invoke, name] of [[runCommandTool, 'run_command'], [runTestTool, 'run_test']]) {
    const result = await invoke({ command: PRINT_CWD, cwd: workspace, timeout_ms: 20_000 })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(canonical(result.executionCwd), canonical(workspace), name)
    assert.equal(evidence(result, { name }).verified, true)
  }
})

test('directory denial precedes execution and cannot mint an execution cwd receipt', async () => {
  let calls = 0
  await assert.rejects(bashExecTool({ command: PRINT_CWD, cwd: outside }, {
    runProcessWithGroupFn: async () => { calls += 1; throw new Error('must not run') },
  }), (error) => {
    assert.equal(error.statusCode, 403)
    assert.equal(Object.hasOwn(error, 'executionCwd'), false)
    return true
  })
  assert.equal(calls, 0)
})

test('a pre-cancelled reused command creates no execution receipt or passing evidence', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await bashExecTool({ command: PRINT_CWD, cwd: workspace, session: 'reuse', signal: controller.signal })
  assert.equal(result.ok, false)
  assert.equal(result.cancelled, true)
  assert.equal(Object.hasOwn(result, 'executionCwd'), false)
  assert.equal(evidence(result).verified, false)
})
