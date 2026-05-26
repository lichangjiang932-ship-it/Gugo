import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-notifications-store-tests', String(process.pid))

const { createUser, getDb } = await import('../server/db.js')
const {
  countUnreadNotifications,
  createNotification,
  listNotifications,
  markRead,
} = await import('../server/services/notificationsStore.js')

function cleanDb() {
  const db = getDb()
  db.exec('DELETE FROM notifications; DELETE FROM sessions; DELETE FROM users;')
}

test.beforeEach(() => {
  cleanDb()
  createUser({ id: 'user-notify', email: 'notify@example.com' })
})

test.after(() => {
  cleanDb()
})

test('createNotification persists a notification for a user', () => {
  const notification = createNotification({
    id: 'n-create',
    userId: 'user-notify',
    kind: 'success',
    title: 'Saved',
    body: 'Changes were saved',
    link: '/settings',
    data: { source: 'test' },
    now: 1000,
  })

  assert.equal(notification.id, 'n-create')
  assert.equal(notification.userId, 'user-notify')
  assert.equal(notification.kind, 'success')
  assert.deepEqual(notification.data, { source: 'test' })
  assert.equal(notification.readAt, null)
})

test('listNotifications returns newest notifications and supports unread filter', () => {
  createNotification({ id: 'n-old', userId: 'user-notify', title: 'Old', now: 1000 })
  createNotification({ id: 'n-new', userId: 'user-notify', title: 'New', now: 2000 })
  markRead(['n-old'], { userId: 'user-notify', now: 3000 })

  assert.deepEqual(
    listNotifications({ userId: 'user-notify' }).map((item) => item.id),
    ['n-new', 'n-old'],
  )
  assert.deepEqual(
    listNotifications({ userId: 'user-notify', unread: true }).map((item) => item.id),
    ['n-new'],
  )
})

test('markRead marks selected notifications only', () => {
  createNotification({ id: 'n-a', userId: 'user-notify', title: 'A', now: 1000 })
  createNotification({ id: 'n-b', userId: 'user-notify', title: 'B', now: 2000 })

  assert.equal(markRead(['n-a'], { userId: 'user-notify', now: 5000 }), 1)
  const rows = listNotifications({ userId: 'user-notify' })
  assert.equal(rows.find((item) => item.id === 'n-a')?.readAt, 5000)
  assert.equal(rows.find((item) => item.id === 'n-b')?.readAt, null)
})

test('countUnreadNotifications returns unread count', () => {
  createNotification({ id: 'n-1', userId: 'user-notify', title: 'One', now: 1000 })
  createNotification({ id: 'n-2', userId: 'user-notify', title: 'Two', now: 2000 })
  markRead(['n-1'], { userId: 'user-notify', now: 3000 })

  assert.equal(countUnreadNotifications('user-notify'), 1)
})
