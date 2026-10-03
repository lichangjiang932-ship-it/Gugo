import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_VERIFY_ROUNDS,
  createPreviewVerification,
  previewVerificationStatus,
  resetPreviewVerification,
} from '../server/services/previewVerification.js'
import { previewConfigPath } from '../server/services/previewConfig.js'
import { _testing as factsTesting, markPreviewWindowSeen } from '../server/services/previewPageFacts.js'
import { stopPreviewServer } from '../server/services/previewServerStore.js'

/**
 * The verification loop's decisions, without a real page: a project that has not
 * opted in verifies nothing, a project that has gets exactly one observation per
 * edit, and the loop stops asking after it has used up its rounds.
 */

function makeWorkspace({ autoVerify = true, launch = true } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-preview-verify-'))
  const configDir = path.join(workspace, '.gugo')
  fs.mkdirSync(configDir)
  if (launch) {
    fs.writeFileSync(previewConfigPath(workspace), JSON.stringify({
      version: '0.0.1',
      autoVerify,
      configurations: [{
        name: 'dev-server',
        program: 'node',
        args: ['--version'],
        port: 3000,
        cwd: '${workspaceFolder}',
        env: {},
        autoPort: true,
      }],
    }, null, 2), 'utf8')
  }
  return workspace
}

test.afterEach(() => {
  factsTesting.pending.clear()
  resetPreviewVerification({ sessionId: '' })
})

test('a project with no preview configuration is left alone', async () => {
  const workspace = makeWorkspace({ launch: false })
  try {
    const messages = []
    const verification = createPreviewVerification({ userId: 'u1', sessionId: 's1', workspaceRoot: workspace })
    const started = verification.observe({ result: {}, onMessage: (content) => messages.push(content) })
    assert.equal(started.skipped, true)
    assert.equal(started.reason, 'no-config')
    assert.equal(await verification.settle(), null)
    assert.deepEqual(messages, [])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('autoVerify: false means the app is never started', async () => {
  const workspace = makeWorkspace({ autoVerify: false })
  try {
    markPreviewWindowSeen({ userId: 'u1', workspaceRoot: workspace })
    const verification = createPreviewVerification({ userId: 'u1', sessionId: 's2', workspaceRoot: workspace })
    const started = verification.observe({ result: {} })
    assert.equal(started.reason, 'disabled')
    await verification.settle()
    // Nothing was started: the port was never taken by this workspace's server.
    assert.equal(previewVerificationStatus({ userId: 'u1', sessionId: 's2' }).rounds, 0)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a workspace that is not this conversation\'s is not verified', async () => {
  const verification = createPreviewVerification({ userId: 'u1', sessionId: 's3', workspaceRoot: '' })
  assert.equal(verification.observe({}).reason, 'no-workspace')
  assert.equal(await verification.settle(), null)
})

test('nothing is verified while no window is watching the page', async () => {
  const workspace = makeWorkspace()
  try {
    // Recording the connection exists in tests for the same reason every batch
    // in the app records one: the facts come from a window, and a batch that
    // waits for one that is not there is a stall on the reader's own turn.
    const omitted = createPreviewVerification({ userId: 'u1', sessionId: 's6', workspaceRoot: workspace })
    const skippedAgain = omitted.observe({ result: {} })
    assert.equal(skippedAgain.reason, 'no-window')
    assert.equal(await omitted.settle(), null, 'and it starts no work at all')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('the loop uses at most its rounds, then says a person has to look', async () => {
  const workspace = makeWorkspace()
  const messages = []
  try {
    markPreviewWindowSeen({ userId: 'u1', workspaceRoot: workspace })
    const verification = createPreviewVerification({ userId: 'u1', sessionId: 's4', workspaceRoot: workspace })
    // Stand in for the panel so the rounds do not wait on a real page.
    for (let round = 0; round < MAX_VERIFY_ROUNDS + 2; round += 1) {
      verification.observe({ result: {}, onMessage: (content) => messages.push(content) })
      await verification.settle()
    }
    const last = messages.at(-1)
    assert.match(String(last), /自动验证未通过，请人工检查/)
    const rounds = previewVerificationStatus({ userId: 'u1', sessionId: 's4' }).rounds
    assert.equal(rounds, MAX_VERIFY_ROUNDS, 'the cap is what stopped it, not the page')
  } finally {
    await stopPreviewServer({ userId: 'u1', workspaceRoot: workspace })
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('an observation never throws, whatever the project does', async () => {
  const workspace = makeWorkspace()
  try {
    markPreviewWindowSeen({ userId: 'u1', workspaceRoot: workspace })
    const verification = createPreviewVerification({ userId: 'u1', sessionId: 's5', workspaceRoot: workspace })
    const result = {}
    const messages = []
    // The server is asked to start, and the panel is asked for facts; neither
    // answers here, and the batch still gets an answer it can read.
    verification.observe({ result, onMessage: (content) => messages.push(content) })
    await verification.settle()
    assert.ok(Array.isArray(messages))
    assert.equal(typeof result, 'object')
  } finally {
    await stopPreviewServer({ userId: 'u1', workspaceRoot: workspace })
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
