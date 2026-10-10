import assert from 'node:assert/strict'
import test from 'node:test'

import { compareLabel, COMPARE_MODES, filesFromStatusPayload, normalizeChangedFile } from '../src/lib/diffReviewModel.js'

const t = (key, vars = {}) => key.replace(/\{(\w+)\}/gu, (_, name) => String(vars[name] ?? ''))

test('the breadcrumb names the three comparison targets', () => {
  assert.deepEqual([...COMPARE_MODES], ['all', 'uncommitted', 'branch'])
  assert.equal(compareLabel({ mode: 'all' }, t), 'diffReview.allChanges')
  assert.equal(compareLabel({ mode: 'uncommitted', branch: 'main' }, t), 'main ▸ diffReview.workingTree')
  assert.equal(compareLabel({ mode: 'branch', branch: 'release' }, t), 'diffReview.compareAgainst release')
})

test('git status payloads are read defensively, and directories are dropped', () => {
  assert.deepEqual(normalizeChangedFile({ path: 'src/a.js', status: 'M', additions: 2, deletions: 1 }), {
    path: 'src/a.js', status: 'M', additions: 2, deletions: 1,
  })
  // Alternate key names and nested stats are accepted.
  assert.deepEqual(normalizeChangedFile({ file: 'docs/b.md', state: 'A', stats: { added: 3, removed: 0 } }), {
    path: 'docs/b.md', status: 'A', additions: 3, deletions: 0,
  })
  assert.equal(normalizeChangedFile({}).path, '')
  assert.deepEqual(filesFromStatusPayload({ files: [{ path: 'a.js' }, { path: 'empty-dir/' }] }).map((file) => file.path), ['a.js'])
  assert.deepEqual(filesFromStatusPayload([{ path: 'only-entry.js' }]).map((file) => file.path), ['only-entry.js'])
  assert.deepEqual(filesFromStatusPayload(null), [])
})
