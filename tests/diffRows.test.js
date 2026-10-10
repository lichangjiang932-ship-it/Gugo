import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFileDiff, countDiffRows, highlightChangedWords, parseHunks, splitDiffFiles, toSideBySide } from '../src/lib/diffRows.js'

const DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,4 +1,5 @@',
  ' const one = 1',
  '-const two = 2',
  '-const three = 3',
  '+const two = 22',
  '+const three = 3',
  '+const four = 4',
  ' export { one }',
  'diff --git a/docs/b.md b/docs/b.md',
  '--- a/docs/b.md',
  '+++ b/docs/b.md',
  '@@ -1 +1,2 @@',
  '-old line',
  '+new line',
  '+extra line',
].join('\n')

test('a diff blob splits into one entry per file, skipping preamble noise', () => {
  const files = splitDiffFiles(DIFF)
  assert.deepEqual(files.map((file) => file.path), ['src/a.js', 'docs/b.md'])
  assert.deepEqual(files[0].header, ['diff --git a/src/a.js b/src/a.js', 'index 111..222 100644', '--- a/src/a.js', '+++ b/src/a.js'])
  assert.equal(files[0].body[0], '@@ -1,4 +1,5 @@')
  // A file with no hunk (binary/rejected) is not a reviewable file.
  assert.deepEqual(splitDiffFiles('diff --git a/x.bin b/x.bin\nBinary files differ'), [])
})

test('hunks carry their own counters, and a newline marker is not a line', () => {
  const hunks = parseHunks(['@@ -10,2 +10,3 @@', ' keep', '-gone', '+added', '\\ No newline at end of file'])
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0].oldStart, 10)
  assert.equal(hunks[0].newStart, 10)
  assert.deepEqual(hunks[0].lines, [' keep', '-gone', '+added'])
})

test('side-by-side rows pair changes, keep both numbers and pad the short side', () => {
  const rows = toSideBySide(parseHunks(splitDiffFiles(DIFF)[0].body))
  const changed = rows.filter((row) => row.kind === 'changed')
  assert.equal(changed.length, 2, 'two removals paired with two of the three additions')
  assert.deepEqual([changed[0].oldNumber, changed[0].newNumber], [2, 2])
  // The third addition has nothing to pair with: the old side is a filler slot.
  const added = rows.find((row) => row.kind === 'added')
  assert.deepEqual([added.oldNumber, added.oldText], [null, ''])
  assert.equal(added.newText, 'const four = 4')
  // Context keeps the same text on both sides with its own numbering.
  const context = rows.find((row) => row.kind === 'context')
  assert.deepEqual([context.oldText, context.newText], [' const one = 1', ' const one = 1'].map((line) => line.slice(1)))
  assert.deepEqual([context.oldNumber, context.newNumber], [1, 1])
  assert.equal(rows[rows.length - 1].kind, 'filler', 'each hunk ends with a separator slot')
})

test('counts separate additions from deletions', () => {
  const { additions, deletions, hunks } = buildFileDiff(DIFF)
  assert.equal(hunks, 2)
  // Two paired changes plus one unpaired addition; deletions come from the pairs.
  assert.equal(additions, 5)
  assert.equal(deletions, 3)
  assert.deepEqual(countDiffRows([]), { additions: 0, deletions: 0 })
})

test('word marks point at what actually changed inside a line', () => {
  const { oldParts, newParts } = highlightChangedWords('const two = 2', 'const two = 22')
  assert.equal(oldParts.map((part) => part.text).join(''), 'const two = 2')
  assert.equal(newParts.map((part) => part.text).join(''), 'const two = 22')
  assert.deepEqual(oldParts.filter((part) => part.changed).map((part) => part.text), ['2'])
  assert.deepEqual(newParts.filter((part) => part.changed).map((part) => part.text), ['22'])
  // Identical lines have nothing marked.
  const same = highlightChangedWords('same line', 'same line')
  assert.equal(same.oldParts.every((part) => part.changed === false), true)
  // A minified monster is not compared token by token.
  const long = 'a'.repeat(5)
  const huge = Array.from({ length: 400 }, () => long).join(' ')
  const capped = highlightChangedWords(huge, `${huge} x`)
  assert.equal(capped.oldParts.length, 1)
  assert.equal(capped.oldParts[0].changed, true)
})
