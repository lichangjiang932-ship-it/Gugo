import assert from 'node:assert/strict'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { cmdRun, parseRunArgs } from '../../bin/yma-cli.js'
import { startInteractiveSession } from '../../bin/cli/interactiveSession.js'
import { createAttachmentQueue } from '../../bin/cli/interactiveAttachmentQueue.js'
import { startHeadlessWithAttachments } from '../../server/services/headlessAttachmentStart.js'

function capture() {
  let text = ''
  return { stream: new Writable({ write(chunk, _encoding, done) { text += chunk; done() } }), text: () => text }
}

test('resume with attachments fails during parsing, before stdin/file/runtime I/O', async () => {
  for (const flag of ['--file', '--image']) {
    assert.throws(() => parseRunArgs(['--resume', 'persisted', flag, 'does-not-exist']), { code: 'CLI_RESUME_ATTACHMENT_CONFLICT' })
    const io = capture()
    const code = await cmdRun(['--resume', 'persisted', flag, 'does-not-exist'], {
      stdin: { isTTY: false, [Symbol.asyncIterator]() { assert.fail('must not read stdin') } }, stdout: io.stream, stderr: io.stream,
      runTurn: async () => assert.fail('must not start runtime'),
    })
    assert.equal(code, 2)
    assert.match(io.text(), /CLI_RESUME_ATTACHMENT_CONFLICT/u)
  }
})

test('attachment-only run forwards bounded requests, never file content or invented resume input', async () => {
  const io = capture()
  let submitted
  const code = await cmdRun(['--file', 'content.txt', '--image', 'picture.png'], {
    stdin: Readable.from([]), stdout: io.stream, stderr: io.stream,
    runTurn: async (input) => { submitted = input; return { status: 'completed', exitCode: 0 } },
  })
  assert.equal(code, 0)
  assert.equal(submitted.prompt, '')
  assert.deepEqual(submitted.attachmentRequests, [{ path: 'content.txt', kind: 'auto' }, { path: 'picture.png', kind: 'image' }])
  assert.equal(Object.hasOwn(submitted, 'files'), false)
})

test('chat attachments apply once, are removed on explicit detach/session switch, and never silently disappear', async () => {
  const io = capture()
  const calls = []
  const cwd = process.cwd()
  await startInteractiveSession({ options: { sessionId: 'attachments', cwd, files: ['first.txt'] },
    env: {}, stdout: io.stream, stderr: io.stream, resolveUserId: async () => 'owner', readModelProviders: async () => [],
    lines: ['first', 'second', '/attach "with spaces.txt"', '/attachments', 'third', '/attach removed.txt', '/detach all', 'fourth',
      '/attach scoped.txt', '/new', 'fifth', '/exit'],
    runTurn: async (input) => { calls.push(input); return { status: 'completed', exitCode: 0 } },
  })
  assert.equal(calls.length, 5)
  assert.deepEqual(calls[0].attachmentRequests, [{ path: path.resolve(cwd, 'first.txt'), kind: 'auto' }])
  assert.equal(calls[1].attachmentRequests, undefined)
  assert.equal(calls[2].attachmentRequests[0].path, path.resolve(cwd, 'with spaces.txt'))
  assert.equal(calls[3].attachmentRequests, undefined)
  assert.equal(calls[4].attachmentRequests, undefined)
  assert.match(io.text(), /1\. .*with spaces\.txt/u)
  const queue = createAttachmentQueue({ cwd })
  for (let index = 0; index < 8; index++) queue.handle({ name: '/attach', args: 'file.txt' }, { cwd, stdout: io.stream })
  assert.throws(() => queue.handle({ name: '/attach', args: 'ninth.txt' }, { cwd, stdout: io.stream }), { code: 'CLI_TOO_MANY_ATTACHMENTS' })
})

test('headless start carries only managed IDs and preserves a primary unknown outcome during cleanup failure', async () => {
  let request
  let cleaned = 0
  const runtime = { input: { attachmentRequests: [{ path: 'explicit.txt' }] }, scope: { userId: 'owner', sessionId: 's', turnId: 't' },
    workspace: {}, executionEnv: {}, dependencies: { prepareAttachments: async () => ({ attachments: ['managed-id'], discard: async () => { cleaned++ } }) },
    startTurn: async (value) => { request = value },
  }
  await startHeadlessWithAttachments(runtime, { content: 'read it' })
  assert.deepEqual(request, { content: 'read it', attachments: ['managed-id'] })
  assert.equal(cleaned, 1)
  const primary = Object.assign(new Error('unknown'), { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', retryable: false })
  runtime.startTurn = async () => { throw primary }
  runtime.dependencies.prepareAttachments = async () => ({ attachments: ['managed-id'], discard: async () => { throw new Error('cleanup') } })
  await assert.rejects(startHeadlessWithAttachments(runtime, { content: 'read it' }), (error) => (
    error.code === primary.code && error.cause === primary && error.retryable === false && error.errors.length === 2
  ))
})
