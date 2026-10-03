import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  archiveExperienceEntries,
  readExperienceJournal,
  recordExperience,
} from '../server/services/experienceRecorder.js'
import { experienceJournalPath, parseExperienceJournal } from '../server/services/experienceJournal.js'
import { closeDb, createUser } from '../server/db.js'
import { setApprovalMode } from '../server/services/approvalSettingsStore.js'

let workspace
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}
const USER = 'experience-user'

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-experience-recorder-'))
  process.env.APP_DB_PATH = path.join(workspace, 'experience-test.db')
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_FS_ENABLED = '1'
  // Writing the journal is a file write inside the workspace, so it needs the same
  // workspace authority as any other write: without trust the recorder must refuse
  // rather than sneak a file into a directory the user never approved.
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
})

after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(workspace, { recursive: true, force: true })
})

beforeEach(() => {
  closeDb()
  fs.rmSync(process.env.APP_DB_PATH, { force: true })
  createUser({ id: USER, email: 'experience@example.com' })
  setApprovalMode({ userId: USER, mode: 'normal' })
  fs.rmSync(experienceJournalPath(workspace), { force: true })
})

const episode = (overrides = {}) => ({
  topic: 'sidebar-browser',
  scope: 'project',
  evidence: 'turn-1;src/components/EmbeddedBrowser.jsx',
  goal: '让侧栏浏览器能打开禁止嵌入的站点',
  blocker: 'iframe 被拒绝时没有任何事件',
  solution: '桌面端换 WebContentsView',
  ...overrides,
})

test('an episode lands in the workspace journal, not in the app database', async () => {
  const result = await recordExperience({ userId: USER, workspaceRoot: workspace, episode: episode() })
  assert.equal(result.ok, true, result.error)

  // The file is the record; it must be readable markdown a human can open.
  const text = fs.readFileSync(experienceJournalPath(workspace), 'utf8')
  assert.match(text, /^# 经验日志/u)
  assert.match(text, /goal: 让侧栏浏览器/u)
  assert.match(text, /solution: 桌面端换 WebContentsView/u)

  // And a second call appends rather than replacing the first episode.
  const second = await recordExperience({
    userId: USER, workspaceRoot: workspace,
    episode: episode({ topic: 'other', goal: '第二件事', solution: '第二种解法', evidence: 'turn-2' }),
  })
  assert.equal(second.ok, true, second.error)
  assert.equal(second.pendingCount, 2)
  assert.deepEqual(readExperienceJournal({ userId: USER, workspaceRoot: workspace }).entries.map((entry) => entry.goal),
    ['让侧栏浏览器能打开禁止嵌入的站点', '第二件事'])
})

test('two episodes finishing at once both survive', async () => {
  // Both turns read the same file and both write; without serializing the append
  // one episode is silently lost, which is the failure this lock exists for.
  const results = await Promise.all(Array.from({ length: 5 }, (_value, index) => recordExperience({
    userId: USER, workspaceRoot: workspace,
    episode: episode({ topic: `task-${index}`, goal: `任务 ${index}`, solution: `解法 ${index}`, evidence: `turn-${index}` }),
  })))
  assert.deepEqual(results.map((result) => result.ok), [true, true, true, true, true])
  const { entries } = readExperienceJournal({ userId: USER, workspaceRoot: workspace })
  assert.equal(entries.length, 5)
  // Ids must be unique: deriving them from a counter that survives a restart is
  // what stops two appends colliding on the same id.
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 5)
})

test('an incomplete episode is refused with the reason, and nothing is written', async () => {
  const result = await recordExperience({ userId: USER, workspaceRoot: workspace, episode: episode({ evidence: '' }) })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXPERIENCE_INVALID')
  assert.match(result.error, /evidence 必填/u)
  // A refused episode must not leave a half-written journal behind.
  assert.equal(fs.existsSync(experienceJournalPath(workspace)), false)
})

test('a workspace with file writing switched off refuses the journal without throwing', async () => {
  // This runs at the end of a completed task: a bookkeeping refusal must report
  // itself, never turn the task into a failure.
  const previous = process.env.WORKSPACE_FS_ENABLED
  process.env.WORKSPACE_FS_ENABLED = '0'
  try {
    const result = await recordExperience({ userId: USER, workspaceRoot: workspace, episode: episode() })
    assert.equal(result.ok, false)
    assert.match(String(result.error), /WORKSPACE_FS_ENABLED/u)
    assert.equal(fs.existsSync(experienceJournalPath(workspace)), false)
  } finally {
    process.env.WORKSPACE_FS_ENABLED = previous
  }
})

test('without a user the journal refuses instead of writing somewhere global', async () => {
  const result = await recordExperience({ workspaceRoot: workspace, episode: episode() })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXPERIENCE_NO_USER')
})

test('archiving moves digested episodes out of the journal and keeps them', async () => {
  await recordExperience({ userId: USER, workspaceRoot: workspace, episode: episode({ evidence: 'turn-a' }) })
  await recordExperience({ userId: USER, workspaceRoot: workspace, episode: episode({ topic: 'b', goal: '第二件', solution: '解法', evidence: 'turn-b' }) })
  const before = readExperienceJournal({ userId: USER, workspaceRoot: workspace })
  const archivedId = before.entries[0].id

  const result = await archiveExperienceEntries({ userId: USER, workspaceRoot: workspace, entryIds: [archivedId] })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.archived, [archivedId])
  assert.equal(result.remaining, 1)

  // The journal keeps only what has not been abstracted yet...
  const after = readExperienceJournal({ userId: USER, workspaceRoot: workspace })
  assert.deepEqual(after.entries.map((entry) => entry.evidence), ['turn-b'])
  // ...and the archive still carries the evidence trail, marked as consumed.
  const archive = parseExperienceJournal(fs.readFileSync(result.archivePath, 'utf8'))
  assert.equal(archive.entries.length, 1)
  assert.equal(archive.entries[0].id, archivedId)
  assert.equal(archive.entries[0].status, 'digested')
  assert.match(archive.entries[0].evidence, /turn-a/u)
})

test('archiving an episode that is not in the journal is refused, not quietly ignored', async () => {
  const result = await archiveExperienceEntries({ userId: USER, workspaceRoot: workspace, entryIds: ['exp-19700101-001'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXPERIENCE_NOTHING_TO_ARCHIVE')
})
