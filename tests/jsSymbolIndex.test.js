import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractDeclarations,
  isJavaScriptPath,
  parseScriptAst,
  refineSymbolMatches,
} from '../server/utils/jsSymbolIndex.js'

function lines(source, name, kind = 'all') {
  return (extractDeclarations(source, { name, kind }) || []).map((entry) => [entry.kind, entry.line])
}

test('declarations are found with their kind and starting line', () => {
  const source = [
    'export function handler(input) {', // 1
    '  return input', // 2
    '}', // 3
    'const helper = (value) => value + 1', // 4
    'const named = function inner() {}', // 5
    'class Store extends Base {', // 6
    '  load() {', // 7
    '    return 1', // 8
    '  }', // 9
    '}',
    'const store = new Store()', // 11
    'const api = {', // 12
    '  fetch() { return 1 },', // 13
    '  send: async () => 2,', // 14
    '}', // 15
  ].join('\n')

  assert.deepEqual(lines(source, 'handler'), [['function', 1]])
  assert.deepEqual(lines(source, 'helper'), [['function', 4]])
  assert.deepEqual(lines(source, 'named'), [['function', 5]])
  assert.deepEqual(lines(source, 'inner'), [['function', 5]])
  assert.deepEqual(lines(source, 'Store'), [['class', 6]])
  // A method and a property of an object literal are both callable symbols.
  assert.deepEqual(lines(source, 'load'), [['function', 7]])
  assert.deepEqual(lines(source, 'fetch'), [['function', 13]])
  assert.deepEqual(lines(source, 'send'), [['function', 14]])
  // A plain value binding is a `const`-shaped declaration, not a function.
  assert.deepEqual(lines(source, 'store'), [['const', 11]])
})

test('a multiline signature reports the line the declaration starts on', () => {
  const source = ['const compute = (', '  a,', '  b,', ') => a + b'].join('\n')
  assert.deepEqual(lines(source, 'compute'), [['function', 1]])
})

test('text that only looks like a declaration is not one', () => {
  const source = [
    '// function ghost() {} — a comment, not a declaration', // 1
    'const text = "function quoted() {}"', // 2
    `const template = \`export class Fake {}\` + \`function alsoFake() {}\``, // 3
    'function real() {}', // 4
  ].join('\n')

  // This is the whole point of the parse: the pattern pass reports all four
  // spellings, and only the last one binds a name.
  for (const name of ['ghost', 'quoted', 'Fake', 'alsoFake']) {
    assert.deepEqual(lines(source, name), [], name)
  }
  assert.deepEqual(lines(source, 'real'), [['function', 4]])
})

test('the kind filter narrows the results the same way the tool documents it', () => {
  const source = ['function byFunction() {}', 'class ByClass {}', 'const byValue = 1'].join('\n')
  assert.deepEqual(lines(source, 'byValue', 'const'), [['const', 3]])
  assert.deepEqual(lines(source, 'byValue', 'function'), [])
  assert.deepEqual(lines(source, 'ByClass', 'class'), [['class', 2]])
  assert.deepEqual(lines(source, 'ByClass', 'const'), [])
  assert.deepEqual(lines(source, 'byFunction', 'all'), [['function', 1]])
})

test('source that cannot be parsed yields null so the caller keeps the pattern result', () => {
  assert.equal(parseScriptAst('const value: number = 1'), null)
  assert.equal(extractDeclarations('const value: number = 1', { name: 'value' }), null)
  // A hashbang and top-level return are ordinary script forms, not failures.
  assert.ok(parseScriptAst('#!/usr/bin/env node\nfunction main() {}'))
  assert.ok(parseScriptAst('return 1'))
})

test('only javascript-family paths are confirmed by a parse', () => {
  for (const file of ['src/app.js', 'tools/run.mjs', 'legacy/index.cjs', 'src/app.JS']) {
    assert.equal(isJavaScriptPath(file), true, file)
  }
  for (const file of ['src/app.ts', 'src/app.jsx', 'main.py', 'app.go', 'Makefile', 'no-extension']) {
    assert.equal(isJavaScriptPath(file), false, file)
  }
})

test('ripgrep candidates are confirmed per file and other languages are untouched', () => {
  const jsSource = [
    'const label = "function ghost() {}"', // 1
    'class Store {', // 2
    '  ghost() { return 1 }', // 3
    '}', // 4
  ].join('\n')
  const files = new Map([
    ['src/store.js', jsSource],
    ['app.py', 'def ghost():\n    pass\n'],
    ['src/broken.js', null],
  ])
  const matches = [
    { file: 'src/store.js', line: 1, text: 'const label = "function ghost() {}"', context_before: [] },
    { file: 'src/store.js', line: 3, text: '  ghost() { return 1 },', context_before: [] },
    { file: 'app.py', line: 1, text: 'def ghost():', context_before: [] },
    { file: 'src/broken.js', line: 9, text: 'const x = 1', context_before: [] },
  ]
  const refined = refineSymbolMatches(matches, {
    name: 'ghost',
    kind: 'all',
    readFile: (file) => {
      if (!files.has(file)) throw new Error(`missing ${file}`)
      const value = files.get(file)
      if (value == null) throw new Error('unreadable')
      return value
    },
  })

  // The string match is gone; the real method is reported at its own line with
  // the source line as its definition.
  assert.deepEqual(refined.map((entry) => [entry.file, entry.line]), [
    ['app.py', 1],
    ['src/broken.js', 9],
    ['src/store.js', 3],
  ])
  assert.equal(refined.find((entry) => entry.file === 'src/store.js').definition, 'ghost() { return 1 }')
  assert.deepEqual(refined.find((entry) => entry.file === 'src/store.js').context_before, [
    { line: 2, text: 'class Store {' },
  ])
  // An unreadable file keeps its pattern result — the ripgrep `text` field, which
  // is what the tool maps into `definition` — instead of losing the finding.
  const passthrough = refined.find((entry) => entry.file === 'src/broken.js')
  assert.equal(passthrough.text, 'const x = 1')
  // A parse-confirmed entry carries the source line under both names so either
  // consumer shape reads the same text.
  const confirmed = refined.find((entry) => entry.file === 'src/store.js')
  assert.equal(confirmed.text, confirmed.definition)
})
