import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionRenameCoordinator } from '../src/lib/sessionRenameCoordinator.js'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(writeOverride) {
  let remote = { id: 's', title: 'Original', revision: 0 }, scope = 'owner1'
  const writes = [], commits = [], failures = []
  const rename = createSessionRenameCoordinator({ getScope: () => scope, canWrite: () => true, read: async () => remote,
    write: async (id, title, options) => { writes.push({ id, title, ...options }); await writeOverride?.(title); remote = { ...remote, title, revision: remote.revision + 1 }; return { session: remote } },
    optimistic: () => {}, commit: (id, value) => commits.push(value), failed: (...args) => failures.push(args) })
  return { rename, writes, commits, failures, changeScope: () => { scope = 'owner2' }, session: remote }
}
test('a slow A cannot replace optimistic B; B uses the revision actually committed by A', async () => {
  const gate = deferred(), f = fixture(title => title === 'A' ? gate.promise : null)
  const a = f.rename(f.session, 'A'), b = f.rename({ ...f.session, title: 'A' }, 'B')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.writes.length, 1)
  gate.resolve()
  assert.deepEqual(await Promise.all([a, b]), [true, true])
  assert.deepEqual(f.commits.map(value => value.title), ['B'])
  assert.deepEqual(f.writes.map(value => value.expectedRevision), [0, 1])
})
test('unknown A stops queued B without replaying either write and never exposes server prose', async () => {
  const f = fixture(() => { throw new Error('PRIVATE_DIAGNOSTIC') })
  assert.deepEqual(await Promise.all([f.rename(f.session, 'A'), f.rename({ ...f.session, title: 'A' }, 'B')]), [false, false])
  assert.equal(f.writes.length, 1)
  assert.equal(f.failures.length, 1)
  assert.equal(f.failures[0][2].outcome, 'unknown')
  assert.doesNotMatch(JSON.stringify(f.failures), /PRIVATE_DIAGNOSTIC/)
})
test('owner changes suppress old callbacks and prevent queued writes', async () => {
  const gate = deferred(), f = fixture(() => gate.promise)
  const a = f.rename(f.session, 'A'), b = f.rename({ ...f.session, title: 'A' }, 'B')
  await new Promise(resolve => setImmediate(resolve))
  f.changeScope(); gate.resolve()
  await Promise.all([a, b])
  assert.equal(f.writes.length, 1)
  assert.equal(f.commits.length + f.failures.length, 0)
})
