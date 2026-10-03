import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  groupSessionsByProject,
  pinnedTimestampOf,
  sortSessions,
  timestampOf,
  sessionTimePresentation,
  workspacePathKey,
} from '../src/components/leftRail/sessionListUtils.js'

const sessionListSource = fs.readFileSync(
  new URL('../src/components/leftRail/SessionList.jsx', import.meta.url),
  'utf8',
)
const leftRailSource = fs.readFileSync(
  new URL('../src/components/LeftRail.jsx', import.meta.url),
  'utf8',
)
const leftRailStyles = fs.readFileSync(
  new URL('../src/components/leftRail/LeftRail.css', import.meta.url),
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

test('session rows stay single-line and keep quiet selection while project groups retain disclosure controls', () => {
  assert.match(sessionListSource, /orderedSessions\.map\(\(session, index\) => renderSession\(session, index\)\)/)
  assert.match(sessionListSource, /truncate text-ui leading-5/)
  assert.match(sessionListSource, /title=\{sessionTooltip\(title, time\)\}/)
  assert.doesNotMatch(sessionListSource, /formatSessionRelativeTime|Intl\.RelativeTimeFormat|bg-accent/)
  assert.match(leftRailStyles, /\.left-rail-session-row\s*\{[^}]*min-height: 38px;/)
  assert.match(leftRailStyles, /\.left-rail-session-row\[data-active="true"\][\s\S]*?--color-ink-rgb/)
  assert.match(sessionListSource, /isCollapsed \? Folder : FolderOpen/)
  assert.match(sessionListSource, /data-session-title/)
  assert.match(sessionListSource, /<time className="left-rail-session-time"/)
  assert.match(sessionListSource, /data-session-pinned/)
  assert.match(sessionListSource, /data-session-project/)
  assert.match(sessionListSource, /data-project-toggle/)
  assert.match(sessionListSource, /data-new-project-chat/)
  assert.match(sessionListSource, /chatMessages\.workspaceProjects/)
  assert.match(sessionListSource, /chatMessages\.workspaceRecent/)
  assert.doesNotMatch(sessionListSource, /setExpanded|nav\.history/)
})

test('sidebar hover actions remain available to keyboard and touch and history survives whole-rail collapse', () => {
  assert.match(leftRailStyles, /\.left-rail-action-scope:focus-within \.left-rail-action/)
  assert.match(leftRailStyles, /\.left-rail-action\[aria-expanded="true"\]/)
  assert.match(leftRailStyles, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.left-rail-action\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/)
  assert.match(leftRailSource, /id="left-rail-history" hidden=\{collapsed\}/)
  assert.doesNotMatch(leftRailSource, /!collapsed && <div[^>]*><SessionList/)
  assert.match(sessionListSource, /left-rail-session-menu fixed/)
  assert.doesNotMatch(sessionListSource, /absolute right-0 top-9/)
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

test('the production session rail derives project groups only from visible sessions', () => {
  assert.doesNotMatch(leftRailSource, /readStoredChatProjects|CHAT_PROJECTS_STORAGE_KEY/)
  assert.doesNotMatch(leftRailSource, /storedProjects=/)
})

test('timestampOf accepts message timestamps and rejects invalid values', () => {
  assert.equal(timestampOf({ messages: [{ timestamp: '2026-08-07T08:00:00.000Z' }] }), Date.parse('2026-08-07T08:00:00.000Z'))
  assert.equal(timestampOf({ updatedAt: 'not-a-date' }), 0)
})

test('project grouping merges Windows separator variants and handles filesystem roots without crashing', () => {
  const grouped = groupSessionsByProject([
    { id: 'slash', workspacePath: 'D:/Work/Alpha/', updatedAt: 30 },
    { id: 'backslash', workspacePath: 'd:\\work\\alpha', updatedAt: 20 },
    { id: 'root', workspacePath: '/', updatedAt: 10 },
    { id: 'drive', workspacePath: 'D:\\', updatedAt: 5 },
    { id: 'drive-slash', workspacePath: 'd:/', updatedAt: 4 },
  ])
  assert.equal(grouped.projects.length, 3)
  assert.deepEqual(grouped.projects[0].sessions.map((session) => session.id), ['slash', 'backslash'])
  assert.equal(grouped.projects[1].path, '/')
  assert.equal(grouped.projects[1].name, '/')
  assert.equal(grouped.projects[2].sessions.length, 2)
  assert.equal(workspacePathKey('\\\\Server\\Share\\Demo\\'), workspacePathKey('//server/share/demo/'))
  assert.notEqual(workspacePathKey('/Work/Alpha'), workspacePathKey('/work/alpha'), 'POSIX paths stay case-sensitive')
})

test('activity timestamps fall back from corrupt metadata and accept numeric strings without inventing pin state', () => {
  assert.equal(timestampOf({ updatedAt: 'invalid', createdAt: 1000, messages: [{ timestamp: '2000' }] }), 2000)
  assert.equal(timestampOf({ updatedAt: 1000, createdAt: 500, messages: [{ timestamp: 2000 }] }), 2000)
  assert.equal(timestampOf({ updatedAt: Infinity, createdAt: -1 }), 0)
  assert.deepEqual(sortSessions([
    { id: 'invalid-pin', pinnedAt: 'invalid', updatedAt: 1 },
    { id: 'recent', pinnedAt: 0, updatedAt: 2 },
    { id: 'pinned', pinnedAt: '3000', updatedAt: 1 },
  ]).map((session) => session.id), ['pinned', 'recent', 'invalid-pin'])
})

test('compact absolute times use the selected language and retain an exact accessible timestamp', () => {
  const now = new Date(2026, 8, 8, 12).getTime()
  const timestamp = new Date(2026, 8, 8, 9, 5).getTime()
  const today = sessionTimePresentation({ updatedAt: timestamp }, { locale: 'en', now })
  assert.equal(today.compact, '09:05')
  assert.equal(today.dateTime, new Date(timestamp).toISOString())
  const yesterday = sessionTimePresentation({ updatedAt: new Date(2026, 8, 7).getTime() }, { locale: 'en', now })
  assert.equal(yesterday.compact, '09/07')
  assert.notEqual(sessionTimePresentation({ updatedAt: timestamp }, { locale: 'zh', now }).full, today.full)
  assert.equal(sessionTimePresentation({ updatedAt: 'invalid' }, { now }), null)
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
