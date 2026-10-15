import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWorktreeReview } from '../scripts/review-worktree.mjs'
test('worktree candidate groups cover each file once and flag shared hunks without authorizing git mutations', () => {
  const files = ['shared/turnEvents.js', 'src/components/LeftRail.jsx', 'tests/taskAcceptanceContract.test.js', 'docs/CURRENT_STATE.md', 'shared/turnEvents.js']
  const report = buildWorktreeReview(files)
  assert.equal(report.automaticStaging, false)
  assert.equal(report.automaticCommit, false)
  assert.equal(report.automaticPush, false)
  assert.equal(report.batches.flatMap(batch => batch.files).length, 4)
  assert.ok(report.hunkReviewRequired.includes('shared/turnEvents.js'))
})
test('the current-state entry links to existing local authorities rather than inventing parallel specifications', () => {
  const root = fileURLToPath(new URL('../docs/', import.meta.url))
  const text = fs.readFileSync(path.join(root, 'CURRENT_STATE.md'), 'utf8')
  const links = [...text.matchAll(/\]\(([^)]+)\)/gu)].map(match => match[1]).filter(link => !/^https?:/u.test(link))
  assert.ok(links.includes('DEBT.md') && links.includes('KERNEL_BOUNDARY.md') && links.includes('TASK_ACCEPTANCE.md'))
  for (const link of links) assert.ok(fs.existsSync(path.resolve(root, link)), `missing local authority: ${link}`)
})
