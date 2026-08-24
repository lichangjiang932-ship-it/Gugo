import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  groupSessionsByProject,
  pinnedTimestampOf,
  sortSessions,
  timestampOf,
} from '../src/components/leftRail/sessionListUtils.js'

const sessionListSource = fs.readFileSync(
  new URL('../src/components/leftRail/SessionList.jsx', import.meta.url),
  'utf8',
)

test('session history is one continuous newest-first list', () => {
  const sessions = [
    { id: 'last-week', updatedAt: new Date(2026, 7, 9, 23).toISOString() },
    { id: 'today-old', updatedAt: new Date(2026, 7, 10, 8).toISOString() },
    { id: 'today-new', updatedAt: new Date(2026, 7, 10, 11).toISOString() },
  ]

  assert.deepEqual(sortSessions(sessions).map(({ id }) => id), ['today-new', 'today-old', 'last-week'])
  assert.deepEqual(sortSessions([]), [])
})

test('session rows stay compact while workspace sessions can render under project groups', () => {
  assert.match(sessionListSource, /orderedSessions\.map\(\(session, index\) => renderSession\(session, index\)\)/)
  assert.match(sessionListSource, /block truncate text-\[13px\] leading-\[18px\]/)
  assert.match(sessionListSource, /truncate text-\[13px\] font-medium leading-\[18px\] text-ink/)
  assert.equal((sessionListSource.match(/flex h-8 items-/g) || []).length, 2)
  assert.equal((sessionListSource.match(/\{session\.title\}/g) || []).length, 1)
  assert.doesNotMatch(
    sessionListSource,
    /formatRelative|relativeTime|data-session-time/,
  )
  assert.match(sessionListSource, /data-session-project/)
  assert.match(sessionListSource, /data-project-toggle/)
  assert.match(sessionListSource, /data-new-project-chat/)
  assert.match(sessionListSource, /chatMessages\.workspaceProjects/)
  assert.match(sessionListSource, /chatMessages\.workspaceRecent/)
  assert.doesNotMatch(sessionListSource, /setExpanded|nav\.history/)
})

test('workspace sessions group by normalized path while plain sessions remain in history', () => {
  const grouped = groupSessionsByProject([
    { id: 'plain', title: 'Plain', updatedAt: 40 },
    { id: 'older', workspacePath: 'D:\\Work\\alpha', updatedAt: 10 },
    { id: 'newer', workspacePath: 'd:\\work\\alpha\\', updatedAt: 30 },
  ], [
    { path: 'D:\\Work\\alpha', name: 'Alpha custom', usedAt: 20 },
    { path: '/work/empty', name: 'Empty project', usedAt: 5 },
  ])

  assert.deepEqual(grouped.ungrouped.map(({ id }) => id), ['plain'])
  assert.deepEqual(grouped.projects.map(({ name }) => name), ['Alpha custom', 'Empty project'])
  assert.deepEqual(grouped.projects[0].sessions.map(({ id }) => id), ['newer', 'older'])
  assert.deepEqual(grouped.projects[1].sessions, [])
})

test('timestampOf accepts message timestamps and rejects invalid values', () => {
  assert.equal(timestampOf({ messages: [{ timestamp: '2026-08-07T08:00:00.000Z' }] }), Date.parse('2026-08-07T08:00:00.000Z'))
  assert.equal(timestampOf({ updatedAt: 'not-a-date' }), 0)
})

test('pinned sessions stay above recent sessions with stable pin ordering', () => {
  const sessions = [
    { id: 'recent', updatedAt: 9000 },
    { id: 'pin-older', pinnedAt: 4000, updatedAt: 2000 },
    { id: 'pin-newer', pinnedAt: 5000, updatedAt: 1000 },
    { id: 'older', updatedAt: 3000 },
  ]

  assert.equal(pinnedTimestampOf(sessions[2]), 5000)
  assert.deepEqual(sortSessions(sessions).map(({ id }) => id), [
    'pin-newer', 'pin-older', 'recent', 'older',
  ])

  const tied = [
    { id: 'pin-b', pinnedAt: 6000, updatedAt: 9000 },
    { id: 'pin-a', pinnedAt: 6000, updatedAt: 1000 },
  ]
  assert.deepEqual(sortSessions(tied).map(({ id }) => id), ['pin-a', 'pin-b'])
})
