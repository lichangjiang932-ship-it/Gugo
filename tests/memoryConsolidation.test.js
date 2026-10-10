import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

import { closeDb, getDb } from '../server/db.js'
import { issueEmailCode, verifyEmailCode } from '../server/adapters/authAccount.js'
import { upsertMemory, listMemories } from '../server/services/memoryStore.js'
import { consolidateMemoryPass } from '../server/services/memoryConsolidation.js'

// The DB binds APP_DATA_DIR/APP_DB_PATH at module load, so set them before the
// first getDb().
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-memconsolidate-'))
process.env.APP_DATA_DIR = dataDir
process.env.APP_DB_PATH = path.join(dataDir, 'app.db')

let userId

before(() => {
  const issued = issueEmailCode({ email: 'memconsolidate@example.com' })
  userId = verifyEmailCode({ email: issued.email, code: issued.devCode }).user.id
})

after(() => {
  try { closeDb() } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test('dry run reports duplicates without removing them', () => {
  upsertMemory({ userId, type: 'project', title: 'Deploy', body: 'deploy with docker' })
  upsertMemory({ userId, type: 'project', title: 'Deploy (again)', body: 'deploy with docker' })
  const before = listMemories({ userId }).length

  const report = consolidateMemoryPass({ userId, dryRun: true })
  assert.equal(report.merged.length, 1, 'one duplicate group')
  assert.equal(report.removed.length, 1, 'one entry marked for removal')
  assert.equal(listMemories({ userId }).length, before, 'dry run must not delete')
})

test('merging removes redundant exact duplicates and keeps one survivor', () => {
  const report = consolidateMemoryPass({ userId, dryRun: false })
  const survivors = listMemories({ userId }).filter((m) => m.body === 'deploy with docker')
  assert.equal(survivors.length, 1, 'only one exact-duplicate body survives')
  assert.equal(report.removed.length >= 1, true)
})

test('contradictions (same title, different body) are flagged, never auto-merged', () => {
  upsertMemory({ userId, type: 'project', title: 'API port', body: 'the port is 8080' })
  upsertMemory({ userId, type: 'project', title: 'API port', body: 'the port is 9090' })
  const report = consolidateMemoryPass({ userId, dryRun: true })
  const flagged = report.contradictions.find((c) => /api port/i.test(c.title))
  assert.ok(flagged, 'contradiction is surfaced')
  assert.equal(flagged.entries.length, 2)
  // Both survive — consolidation never guesses which fact is true.
  const bodies = listMemories({ userId }).map((m) => m.body)
  assert.ok(bodies.includes('the port is 8080'))
  assert.ok(bodies.includes('the port is 9090'))
})

test('a duplicate another memory links to is kept, not orphaned', () => {
  // Pinning the sibling makes it the keeper, so the linked clone is the one that
  // would be dropped — and must survive so its [[slug]] is not stranded.
  const linked = upsertMemory({ userId, type: 'reference', title: 'Linked clone', body: 'shared reference body', pinned: false })
  upsertMemory({ userId, type: 'reference', title: 'Pinned keeper', body: 'shared reference body', pinned: true })
  upsertMemory({ userId, type: 'project', title: 'Pointer', body: `see [[${linked.slug}]] for details` })

  const report = consolidateMemoryPass({ userId, dryRun: false })
  assert.ok(report.skippedLinked.includes(linked.id), 'linked duplicate is skipped')
  const db = getDb()
  const still = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(linked.id).n
  assert.equal(still, 1, 'linked duplicate is not deleted')
})
