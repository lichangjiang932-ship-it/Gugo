import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFileTree,
  compareLabel,
  COMPARE_MODES,
  diffTextFromPayload,
  filesFromStatusPayload,
  isSpecialFile,
  normalizeChangedFile,
  truncateMiddle,
  WIRED_COMPARE_MODES,
} from '../src/lib/diffReviewModel.js'
import {
  diffTextFromEdits,
  publishSessionChanges,
  readSessionChanges,
  resetSessionChangesForTests,
  subscribeSessionChanges,
} from '../src/lib/sessionChangesFeed.js'

const t = (key, vars = {}) => key.replace(/\{(\w+)\}/gu, (_, name) => String(vars[name] ?? ''))

test('the conversation changes can be offered as a comparison target', () => {
  assert.ok(COMPARE_MODES.includes('session'))
  assert.ok(WIRED_COMPARE_MODES.includes('session'))
  assert.equal(compareLabel({ mode: 'session' }, t), 'diffReview.sessionChanges')
})

test('the feed notifies subscribers, and identical content is not a new revision', () => {
  resetSessionChangesForTests()
  const seen = []
  const unsubscribe = subscribeSessionChanges((state) => seen.push(state.revision))
  const first = publishSessionChanges({ files: [{ path: 'a.js', additions: 1, deletions: 0 }], diffs: { 'a.js': '@@ -1 +1 @@\n-x\n+y\n' } })
  assert.equal(first.revision, 1)
  // Publishing the same list again must not look like fresh work.
  const second = publishSessionChanges({ files: [{ path: 'a.js', additions: 1, deletions: 0 }], diffs: { 'a.js': 'same' } })
  assert.equal(second.revision, 1)
  const third = publishSessionChanges({ files: [{ path: 'a.js', additions: 2, deletions: 0 }], diffs: {} })
  assert.equal(third.revision, 2)
  assert.deepEqual(seen, [0, 1, 1, 2])
  assert.equal(readSessionChanges().files.length, 1)
  unsubscribe()
  resetSessionChangesForTests()
})

test('recorded edits become a unified diff the panel can parse', () => {
  const text = diffTextFromEdits([
    { removed: ['const two = 2'], added: ['const two = 22', 'const four = 4'] },
    { removed: [], added: [] },
  ])
  assert.match(text, /^@@ -1 \+1 @@/u)
  assert.match(text, /-const two = 2/u)
  assert.match(text, /\+const four = 4/u)
  assert.equal(diffTextFromEdits([]), '')
  assert.equal(diffTextFromEdits([{ removed: [], added: [] }]), '')
})

test('the breadcrumb names the three comparison targets', () => {
  assert.deepEqual([...COMPARE_MODES], ['all', 'uncommitted', 'branch', 'session'])
  assert.equal(compareLabel({ mode: 'all' }, t), 'diffReview.allChanges')
  assert.equal(compareLabel({ mode: 'uncommitted', branch: 'main' }, t), 'main ▸ diffReview.workingTree')
  assert.equal(compareLabel({ mode: 'branch', branch: 'release' }, t), 'diffReview.compareAgainst release')
})

test('git status payloads are read defensively, and directories are dropped', () => {
  assert.deepEqual(normalizeChangedFile({ path: 'src/a.js', status: 'M', additions: 2, deletions: 1 }), {
    path: 'src/a.js', status: 'M', additions: 2, deletions: 1,
  })
  assert.deepEqual(normalizeChangedFile({ file: 'docs/b.md', state: 'A', stats: { added: 3, removed: 0 } }), {
    path: 'docs/b.md', status: 'A', additions: 3, deletions: 0,
  })
  assert.equal(normalizeChangedFile({}).path, '')
  assert.deepEqual(filesFromStatusPayload({ files: [{ path: 'a.js' }, { path: 'empty-dir/' }] }).map((file) => file.path), ['a.js'])
  assert.deepEqual(filesFromStatusPayload([{ path: 'only-entry.js' }]).map((file) => file.path), ['only-entry.js'])
  assert.deepEqual(filesFromStatusPayload(null), [])
})

test('diff payloads are read from whichever key the server used', () => {
  assert.equal(diffTextFromPayload('raw diff'), 'raw diff')
  assert.equal(diffTextFromPayload({ diff: 'from diff' }), 'from diff')
  assert.equal(diffTextFromPayload({ patch: 'from patch' }), 'from patch')
  assert.equal(diffTextFromPayload({ text: 'from text' }), 'from text')
  assert.equal(diffTextFromPayload({ other: 1 }), '')
  assert.equal(diffTextFromPayload(null), '')
})

test('long names keep both ends so the file stays recognisable', () => {
  assert.equal(truncateMiddle('short.js'), 'short.js')
  const cut = truncateMiddle('interval-overlap-repair', 12)
  assert.ok(cut.length <= 12, cut)
  assert.match(cut, /…/u)
  assert.ok(cut.startsWith('interva'), cut)
  assert.ok(cut.endsWith('pair'), cut)
  assert.equal(truncateMiddle('x', 1), 'x')
})

test('test, build and generated files are recognised', () => {
  for (const path of ['tests/a.js', 'src/x.spec.js', 'packages/a/dist/b.js', 'app.min.js']) {
    assert.equal(isSpecialFile(path), true, path)
  }
  for (const path of ['src/index.js', 'server/services/previewTools.js']) {
    assert.equal(isSpecialFile(path), false, path)
  }
})

test('the tree groups folders first and keeps names sorted', () => {
  const files = [
    { path: 'server/b.js', additions: 1, deletions: 0 },
    { path: 'docs/a.md', additions: 2, deletions: 1 },
    { path: 'server/nested/c.js', additions: 0, deletions: 3 },
  ]
  const { nodes } = buildFileTree(files, { groupByFolder: true })
  assert.deepEqual(nodes.map((node) => `${node.type}:${node.name}`), ['dir:docs', 'dir:server'])
  const server = nodes[1]
  assert.deepEqual(server.children.map((node) => node.name), ['nested', 'b.js'])
  assert.deepEqual(server.children[0].children.map((node) => node.path), ['server/nested/c.js'])
  // Flat mode keeps full paths as names.
  const flat = buildFileTree(files, { groupByFolder: false })
  assert.deepEqual(flat.nodes.map((node) => node.name), ['a.md', 'b.js', 'c.js'])
})

test('special files can be pulled out of the main tree', () => {
  const files = [{ path: 'src/a.js' }, { path: 'tests/a.test.js' }]
  const { nodes, special } = buildFileTree(files, { groupByFolder: true, separateSpecial: true })
  assert.deepEqual(nodes.map((node) => node.name), ['src'])
  assert.deepEqual(special.map((file) => file.path), ['tests/a.test.js'])
})
