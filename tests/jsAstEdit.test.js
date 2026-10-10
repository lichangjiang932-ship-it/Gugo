import assert from 'node:assert/strict'
import test from 'node:test'
import { codeMatchOffset } from '../server/utils/jsAstEdit.js'

test('prefers the occurrence in code over one in a comment', () => {
  const source = '// set target first\nconst value = target\n'
  const codeIndex = source.lastIndexOf('target')
  assert.equal(codeMatchOffset('a.js', source, 'target'), codeIndex)
})

test('prefers the occurrence in code over one inside a string literal', () => {
  const source = 'const label = "target value"\nrun(target)\n'
  const codeIndex = source.lastIndexOf('target')
  assert.equal(codeMatchOffset('a.js', source, 'target'), codeIndex)
})

test('prefers the occurrence in code over one inside a template literal', () => {
  const source = 'const msg = `hit target now`\nrun(target)\n'
  const codeIndex = source.lastIndexOf('target')
  assert.equal(codeMatchOffset('a.js', source, 'target'), codeIndex)
})

test('rejects an ambiguous edit when two code occurrences match', () => {
  const source = 'run(target)\nalso(target)\n'
  assert.equal(codeMatchOffset('a.js', source, 'target'), null)
})

test('rejects when the only occurrences are in comments/strings', () => {
  const commentOnly = '// target\n/* target */\n'
  assert.equal(codeMatchOffset('a.js', commentOnly, 'target'), null)
  const stringOnly = 'const a = "target"\nconst b = `target`\n'
  assert.equal(codeMatchOffset('a.js', stringOnly, 'target'), null)
})

test('falls back (null) for non-JavaScript files and unparseable sources', () => {
  const source = 'target\ntarget\n'
  assert.equal(codeMatchOffset('notes.txt', source, 'target'), null, 'non-JS is left to exact match')
  assert.equal(codeMatchOffset('a.ts', source, 'target'), null, 'TypeScript needs a TS parser, not acorn')
  // A .js file acorn cannot parse keeps the caller's exact-match behaviour.
  assert.equal(codeMatchOffset('a.js', 'const x = {', 'target'), null)
})

test('a single occurrence is returned regardless of context', () => {
  assert.equal(codeMatchOffset('a.js', 'const only = 1\n', 'only'), 'const only = 1\n'.indexOf('only'))
  assert.equal(codeMatchOffset('a.js', '// just a comment\n', 'just'), null, 'comment-only single hit is not code')
})
