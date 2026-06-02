import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkWorkspaceSize } from '../server/utils/workspaceSize.js'

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yma-wssize-'))
}

test('checkWorkspaceSize warns when total exceeds threshold, never blocks', () => {
  const root = mkTmp()
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(2000))
    const calls = []
    const logger = { warn: (m) => calls.push(m) }
    const res = checkWorkspaceSize(root, { thresholdBytes: 1000, logger })
    assert.ok(res.totalBytes >= 2000)
    assert.equal(res.exceeded, true)
    assert.equal(calls.length, 1)
    assert.match(calls[0], /workspace/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkWorkspaceSize stays silent under threshold', () => {
  const root = mkTmp()
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'tiny')
    const calls = []
    const logger = { warn: (m) => calls.push(m) }
    const res = checkWorkspaceSize(root, { thresholdBytes: 1024 * 1024, logger })
    assert.equal(res.exceeded, false)
    assert.equal(calls.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkWorkspaceSize throttles repeat warnings within window', () => {
  const root = mkTmp()
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(2000))
    const calls = []
    const logger = { warn: (m) => calls.push(m) }
    const state = {}
    let now = 1000
    const clock = () => now
    checkWorkspaceSize(root, { thresholdBytes: 1000, logger, state, now: clock })
    checkWorkspaceSize(root, { thresholdBytes: 1000, logger, state, now: clock })
    assert.equal(calls.length, 1, 'second call within window should not re-warn')
    now += 5 * 60 * 1000 + 1
    checkWorkspaceSize(root, { thresholdBytes: 1000, logger, state, now: clock })
    assert.equal(calls.length, 2, 'after window, warns again')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
