import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function forceKillProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !processExists(pid)
}

test('test runner terminates a hung batch and its descendant process', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'yma-run-tests-harness-'))
  const descendantPidFile = join(fixtureRoot, 'descendant.pid')
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  childEnv.TEST_BATCH_TIMEOUT_MS = '500'
  childEnv.RUN_TESTS_TIMEOUT_PROBE_PID_FILE = descendantPidFile

  let descendantPid = null
  try {
    const startedAt = Date.now()
    const result = spawnSync(process.execPath, [
      'scripts/run-tests.js',
      'tests/fixtures/runTestsTimeoutProbe.test.mjs',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: childEnv,
      timeout: 10_000,
    })

    const output = `${result.stdout || ''}\n${result.stderr || ''}`
    descendantPid = Number(readFileSync(descendantPidFile, 'utf8'))
    assert.equal(result.status, 1)
    assert.equal(result.error, undefined)
    assert.ok(Date.now() - startedAt < 8_000, 'runner should return before the outer guard')
    assert.match(output, /batch 1\/1 \(1 files\) exceeded 500ms and was terminated/u)
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0)
    assert.equal(
      await waitForProcessExit(descendantPid),
      true,
      `descendant process ${descendantPid} survived the runner timeout`,
    )
  } finally {
    if (descendantPid && processExists(descendantPid)) forceKillProcess(descendantPid)
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
