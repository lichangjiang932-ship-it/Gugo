import '../scripts/testEnvironment.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

const { createUser } = await import('../server/db.js')
const { getSession, renameSession, upsertSession } = await import('../server/services/sessionStore.js')
const { SQLITE_SESSION_ADMIN_PORT } = await import('../server/services/sqliteSessionAdminPort.js')

let sequence = 0
function seed(title = 'Original name') {
  sequence += 1
  const userId = `rename-user-${sequence}`
  const sessionId = `rename-session-${sequence}`
  createUser({ id: userId, email: `${userId}@example.com` })
  upsertSession({ id: sessionId, userId, title })
  return { userId, sessionId }
}

test('a renamed conversation keeps the name the reader chose', async () => {
  const { userId, sessionId } = seed()
  // Through the port, not the store directly: the port normalizes every input,
  // and a `title` that the normalizer drops would look like a successful rename
  // that silently kept the old name.
  const renamed = await SQLITE_SESSION_ADMIN_PORT.renameSession({
    userId,
    sessionId,
    title: '   A   name the reader   chose  ',
  })
  assert.equal(renamed.title, 'A name the reader chose')
  assert.equal(getSession({ userId, sessionId }).title, 'A name the reader chose')
})

test('conditional rename refuses stale revision without modifying the newer name', async () => {
  const scope = seed()
  const before = getSession(scope)
  await SQLITE_SESSION_ADMIN_PORT.renameSession({ ...scope, title: 'New', expectedRevision: before.revision })
  const error = await rejectionFrom(() => SQLITE_SESSION_ADMIN_PORT.renameSession({ ...scope, title: 'Stale', expectedRevision: before.revision }))
  assert.equal(error.code, 'SESSION_REVISION_CONFLICT')
  assert.equal(getSession(scope).title, 'New')
})

test('renaming leaves the conversation itself alone', async () => {
  const { userId, sessionId } = seed()
  const before = getSession({ userId, sessionId })
  await SQLITE_SESSION_ADMIN_PORT.renameSession({ userId, sessionId, title: 'Renamed' })
  const after = getSession({ userId, sessionId })
  assert.equal(after.title, 'Renamed')
  assert.equal(after.id, before.id)
  assert.equal(after.createdAt, before.createdAt)
  assert.ok(after.revision > before.revision, 'the revision moves so clients resync')
})

/** The port rejects bad input while normalizing, which is synchronous. */
async function rejectionFrom(call) {
  try {
    await call()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to be refused')
}

test('a blank name is refused rather than written', async () => {
  const { userId, sessionId } = seed()
  for (const title of ['', '   ', '\n\t ']) {
    const error = await rejectionFrom(
      () => SQLITE_SESSION_ADMIN_PORT.renameSession({ userId, sessionId, title }),
    )
    assert.equal(error.code, 'SESSION_ADMIN_INPUT_INVALID', JSON.stringify(title))
  }
  assert.equal(getSession({ userId, sessionId }).title, 'Original name')
})

test('a name longer than the rail can draw is refused', async () => {
  const { userId, sessionId } = seed()
  const error = await rejectionFrom(
    () => SQLITE_SESSION_ADMIN_PORT.renameSession({ userId, sessionId, title: 'x'.repeat(201) }),
  )
  assert.equal(error.code, 'SESSION_ADMIN_INPUT_INVALID')
  assert.equal(getSession({ userId, sessionId }).title, 'Original name')
})

test('renaming a conversation that is not there changes nothing', async () => {
  const { userId } = seed()
  assert.equal(
    await SQLITE_SESSION_ADMIN_PORT.renameSession({ userId, sessionId: 'no-such-session', title: 'Nope' }),
    null,
  )
  // And the store's own guard, which the port does not go through.
  assert.equal(renameSession({ userId, sessionId: '', title: 'Nope' }), null)
  assert.equal(renameSession({ userId, sessionId: 'no-such-session', title: '   ' }), null)
})

test('one reader cannot rename another reader\'s conversation', async () => {
  const mine = seed('Mine')
  const theirs = seed('Theirs')
  assert.equal(
    await SQLITE_SESSION_ADMIN_PORT.renameSession({
      userId: theirs.userId,
      sessionId: mine.sessionId,
      title: 'Taken over',
    }),
    null,
  )
  assert.equal(getSession({ userId: mine.userId, sessionId: mine.sessionId }).title, 'Mine')
})
