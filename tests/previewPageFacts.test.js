import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelPendingPageFacts,
  countPendingPageFacts,
  listPendingPageFacts,
  requestPageFacts,
  resolvePageFacts,
  _testing,
} from '../server/services/previewPageFacts.js'

const SCOPE = { userId: 'facts-user', workspaceRoot: 'D:/work/app' }

test.afterEach(() => {
  cancelPendingPageFacts({ userId: SCOPE.userId })
  _testing.pending.clear()
})

test('a request waits until the window answers it', async () => {
  const pending = requestPageFacts({ ...SCOPE, ops: [{ kind: 'screenshot' }] })
  const [queued] = listPendingPageFacts(SCOPE)
  assert.ok(queued?.id, 'the request is parked where the panel polls')
  assert.deepEqual(queued.ops, [{ kind: 'screenshot' }])
  assert.equal(countPendingPageFacts(SCOPE), 1)

  const matched = resolvePageFacts({ ...SCOPE, id: queued.id, result: { results: [{ kind: 'screenshot', ok: true }] } })
  assert.equal(matched.matched, true)
  const answer = await pending
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.results, [{ kind: 'screenshot', ok: true }])
  assert.equal(countPendingPageFacts(SCOPE), 0)
})

test('a result that is not this scope\'s is dropped rather than delivered', async () => {
  const pending = requestPageFacts({ ...SCOPE, ops: [{ kind: 'dom' }] })
  const [queued] = listPendingPageFacts(SCOPE)

  // Another user's window, and another project's window, both look like an
  // answer but are not this request's.
  assert.equal(resolvePageFacts({ userId: 'someone-else', workspaceRoot: SCOPE.workspaceRoot, id: queued.id, result: {} }).matched, false)
  assert.equal(resolvePageFacts({ ...SCOPE, workspaceRoot: 'D:/work/other', id: queued.id, result: {} }).matched, false)
  assert.equal(resolvePageFacts({ ...SCOPE, id: 'not-a-request', result: {} }).matched, false)
  assert.equal(countPendingPageFacts(SCOPE), 1, 'the real request is still waiting')

  resolvePageFacts({ ...SCOPE, id: queued.id, result: { results: [] } })
  assert.equal((await pending).ok, true)
})

test('a panel that never answers ends as a timeout the tool can report', async () => {
  const answer = await requestPageFacts({ ...SCOPE, ops: [{ kind: 'console' }], timeoutMs: 1_000 })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'PREVIEW_FACTS_TIMEOUT')
  assert.match(answer.error, /预览面板/)
  assert.equal(countPendingPageFacts(SCOPE), 0, 'a timed-out request is not left parked')
})

test('cancelling a turn releases everything it was waiting for', async () => {
  const first = requestPageFacts({ ...SCOPE, ops: [{ kind: 'dom' }] })
  const second = requestPageFacts({ userId: SCOPE.userId, workspaceRoot: 'D:/work/other', ops: [{ kind: 'dom' }] })
  assert.equal(cancelPendingPageFacts({ userId: SCOPE.userId, workspaceRoot: SCOPE.workspaceRoot }), 1)
  assert.equal((await first).code, 'PREVIEW_FACTS_CANCELLED')
  assert.equal(cancelPendingPageFacts({ userId: SCOPE.userId }), 1)
  assert.equal((await second).code, 'PREVIEW_FACTS_CANCELLED')
})

test('an aborted signal and a burst of requests are both refused early', async () => {
  const controller = new AbortController()
  controller.abort()
  const aborted = await requestPageFacts({ ...SCOPE, ops: [{ kind: 'dom' }], signal: controller.signal })
  assert.equal(aborted.code, 'PREVIEW_ABORTED')

  const empty = await requestPageFacts({ ...SCOPE, ops: [] })
  assert.equal(empty.code, 'PREVIEW_FACTS_EMPTY')

  // One panel, one page: a burst is refused rather than queued behind itself.
  const held = []
  for (let index = 0; index < _testing.MAX_PENDING_PER_WORKSPACE; index += 1) {
    held.push(requestPageFacts({ ...SCOPE, ops: [{ kind: 'dom' }] }))
  }
  const overflow = await requestPageFacts({ ...SCOPE, ops: [{ kind: 'dom' }] })
  assert.equal(overflow.code, 'PREVIEW_FACTS_BUSY')
  cancelPendingPageFacts({ userId: SCOPE.userId })
  await Promise.all(held)
})
