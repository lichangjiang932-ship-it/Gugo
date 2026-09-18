import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { startInteractiveSession } from '../../bin/cli/interactiveSession.js'

test('external session cancellation closes a pending approval and never consumes a queued next prompt', { timeout: 5000 }, async () => {
  const stdin = new Readable({ read() {} })
  stdin.isTTY = true
  const stream = new Writable({ write(_chunk, _encoding, done) { done() } })
  stream.isTTY = true
  const controller = new AbortController()
  const reason = new Error('external shutdown')
  let turns = 0
  let decisions = 0
  try {
    await assert.rejects(startInteractiveSession({ lines: ['first task', 'never run'], signal: controller.signal,
      stdin, stdout: stream, stderr: stream, env: {}, resolveUserId: async () => 'owner', readModelProviders: async () => [],
      runTurn: async (input) => {
        turns++
        const pending = input.onApproval({ payload: { toolName: 'write_file', args: { path: 'fixture' } } })
        controller.abort(reason)
        assert.deepEqual(await pending, { decision: 'deny' })
        decisions++
        throw reason
      },
    }), (error) => error === reason)
    assert.equal(turns, 1)
    assert.equal(decisions, 1)
  } finally { stdin.destroy() }
})
