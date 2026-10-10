import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeGitBase, parseNumstat } from '../server/adapters/gitWorkbenchBase.js'

test('a comparison base is a revision name, never an option', () => {
  for (const valid of ['main', 'origin/main', 'HEAD', 'HEAD~2', 'v0.11.70', 'abc1234', 'feature/review-panel']) {
    assert.equal(normalizeGitBase(valid), valid)
  }
  assert.equal(normalizeGitBase(''), '')
  assert.equal(normalizeGitBase('   '), '')
  for (const invalid of ['-x', '--cached', 'main; rm -rf /', 'main branch', '$(whoami)', 'a'.repeat(121)]) {
    assert.throws(() => normalizeGitBase(invalid), /invalid git comparison base/u, invalid)
  }
})

test('numstat rows carry counts, and name-status supplies the letter', () => {
  const files = parseNumstat(
    ['12\t3\tsrc/a.js', '0\t7\tdocs/b.md', '-\t-\tassets/logo.png', ''].join('\n'),
    ['M\tsrc/a.js', 'D\tdocs/b.md', 'A\tassets/logo.png'].join('\n'),
  )
  assert.deepEqual(files, [
    { path: 'src/a.js', status: 'M', additions: 12, deletions: 3 },
    { path: 'docs/b.md', status: 'D', additions: 0, deletions: 7 },
    { path: 'assets/logo.png', status: 'A', additions: 0, deletions: 0 },
  ])
  // Without a name-status run the letter falls back to a modification.
  assert.deepEqual(parseNumstat('5\t1\tx.js', ''), [{ path: 'x.js', status: 'M', additions: 5, deletions: 1 }])
  assert.deepEqual(parseNumstat('', ''), [])
})

test('a rename keeps its counted path and does not invent a file', () => {
  const files = parseNumstat('2\t2\tsrc/new-name.js', 'R100\tsrc/old-name.js\tsrc/new-name.js')
  assert.deepEqual(files, [{ path: 'src/new-name.js', status: 'M', additions: 2, deletions: 2 }])
})
