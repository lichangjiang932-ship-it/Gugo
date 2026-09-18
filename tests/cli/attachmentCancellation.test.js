import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { prepareHeadlessAttachments } from '../../server/adapters/headlessAttachmentPreparation.js'
import { startInteractiveSession } from '../../bin/cli/interactiveSession.js'

function files(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-attachment-cancel-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  fs.writeFileSync(path.join(cwd, 'first.txt'), 'first staged receipt')
  fs.writeFileSync(path.join(cwd, 'second.txt'), 'second upload\n'.repeat(20000))
  return { cwd, userId: 'fixture-owner', sessionId: 'fixture-session', env: {},
    requests: [{ path: 'first.txt' }, { path: 'second.txt' }] }
}

function staging(abort, discarded, cleanupError = null) {
  return {
    async stage({ name, source }) {
      for await (const chunk of source) {
        assert.ok(chunk.byteLength > 0, 'read actual file bytes before cancelling')
        if (name === 'second.txt') abort()
      }
      return { id: name, mimeType: 'text/plain' }
    },
    async discard({ id }) {
      discarded.push(id)
      if (cleanupError) throw cleanupError
    },
  }
}

test('mid-stream attachment cancellation preserves the exact turn reason after receipt cleanup', async (t) => {
  const input = files(t)
  const controller = new AbortController()
  const reason = Object.assign(new Error('local turn cancelled'), { code: 'CLI_INTERACTIVE_CANCELLED' })
  const discarded = []
  await assert.rejects(prepareHeadlessAttachments({ ...input, signal: controller.signal },
    staging(() => controller.abort(reason), discarded)), (error) => error === reason)
  assert.deepEqual(discarded, ['first.txt'])
})

test('attachment cleanup failure remains fatal even when the underlying read was cancelled', async (t) => {
  const input = files(t)
  const controller = new AbortController()
  const reason = new Error('cancelled')
  const cleanup = Object.assign(new Error('receipt cleanup failed'), { code: 'SQLITE_IOERR' })
  const discarded = []
  await assert.rejects(prepareHeadlessAttachments({ ...input, signal: controller.signal },
    staging(() => controller.abort(reason), discarded, cleanup)), (error) => {
    assert.equal(error.code, 'CLI_ATTACHMENT_CLEANUP_FAILED')
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors[1], cleanup)
    return true
  })
  assert.deepEqual(discarded, ['first.txt'])
})

test('an unrelated upload failure is not reclassified by concurrent cancellation', async (t) => {
  const input = files(t)
  for (const code of ['EIO', 'ABORT_ERR']) {
    const controller = new AbortController()
    const failure = Object.assign(new Error('independent upload failure'), { code, cause: new Error('different reason') })
    await assert.rejects(prepareHeadlessAttachments({ ...input, signal: controller.signal }, {
      async stage({ source }) {
        source.on('error', () => {})
        controller.abort(new Error('local cancellation'))
        throw failure
      },
      discard: async () => assert.fail('no receipt was staged'),
    }), (error) => error === failure)
  }
})

test('Ctrl-C during an attachment stream returns chat to its next prompt without replay', { timeout: 5000 }, async (t) => {
  const input = files(t)
  const chunks = []
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done() } })
  const stdin = new Readable({ read() {} })
  t.after(() => stdin.destroy())
  let calls = 0
  const discarded = []
  const exit = await startInteractiveSession({
    options: { cwd: input.cwd, sessionId: input.sessionId, files: ['first.txt', 'second.txt'] },
    lines: ['first task', 'next task', '/exit'], env: {},
    stdin, stdout: output, stderr: output,
    resolveUserId: async () => input.userId, readModelProviders: async () => [],
    runTurn: async (turn) => {
      calls++
      if (calls === 1) {
        await prepareHeadlessAttachments({ ...input, requests: turn.attachmentRequests, signal: turn.signal },
          staging(() => process.emit('SIGINT'), discarded))
        assert.fail('cancelled upload must not submit a model request')
      }
      assert.equal(turn.prompt, 'next task')
      assert.equal(turn.attachmentRequests, undefined, 'cancelled files are not replayed')
      assert.equal(turn.signal.aborted, false)
      return { status: 'completed', exitCode: 0, sessionId: input.sessionId }
    },
  })
  assert.equal(exit, 0)
  assert.equal(calls, 2)
  assert.deepEqual(discarded, ['first.txt'])
  assert.match(chunks.join(''), /\[turn cancelled\]/u)
})
