import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

// The loop steers the model by injecting bracketed markers like
// `[EXECUTION EVIDENCE REQUIRED]` into system messages and, for some of them,
// matching the model's reply back with a regex. Two markers that share a value
// would misfire that matching, so this test pins three invariants: every marker
// is a named `*_MARKER` constant, every marker value is unique, and every value
// keeps the `[UPPERCASE PHRASE]` shape the runtime relies on.

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.js$/.test(entry.name) ? [full] : []
  })
}

function stripComments(source) {
  let output = ''
  let state = 'code'
  let quote = ''
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'line') {
      if (char === '\n') { state = 'code'; output += '\n' }
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; index += 1 }
      continue
    }
    if (state === 'string') {
      output += char
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === quote) { state = 'code'; quote = '' }
      continue
    }
    if (char === '/' && next === '/') { state = 'line'; index += 1; continue }
    if (char === '/' && next === '*') { state = 'block'; index += 1; continue }
    if (char === "'" || char === '"' || char === '`') { state = 'string'; quote = char }
    output += char
  }
  return output
}

// `const NAME_MARKER = '[UPPERCASE PHRASE]'` (optionally exported).
const MARKER_DEF_RE = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_MARKER)\s*=\s*'(\[[A-Z][A-Z0-9 /_-]+\])'/g
// Any bracketed marker-shaped string literal, wherever it appears.
const MARKER_LITERAL_RE = /'(\[[A-Z][A-Z0-9 /_-]{2,}\])'/g

function collectMarkers() {
  const definitions = new Map()
  const literals = new Map()
  for (const file of walk('server/services/loop')) {
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const match of source.matchAll(MARKER_DEF_RE)) {
      const [, name, value] = match
      assert.ok(!definitions.has(value), `marker value ${value} is defined twice (last: ${name}, prior: ${definitions.get(value)})`)
      definitions.set(value, name)
    }
    for (const match of source.matchAll(MARKER_LITERAL_RE)) {
      const value = match[1]
      literals.set(value, (literals.get(value) || 0) + 1)
    }
  }
  return { definitions, literals }
}

test('loop markers are unique, well-formed named constants', () => {
  const { definitions, literals } = collectMarkers()

  assert.ok(definitions.size >= 20, `expected a substantial marker registry, found ${definitions.size}`)

  for (const value of definitions.keys()) {
    assert.match(value, /^\[[A-Z][A-Z0-9 /_-]{2,}\]$/, `malformed marker value ${value}`)
    // Every bracketed marker literal must come from exactly its named constant
    // definition — a second occurrence is either a magic-string usage or a
    // collision, and both break the regex-based control flow.
    assert.equal(literals.get(value), 1, `marker ${value} must appear exactly once (in its *_MARKER definition)`)
  }

  // No orphaned bracketed literals that bypass a named constant.
  for (const [value, count] of literals) {
    assert.ok(definitions.has(value), `bracketed marker literal ${value} has no *_MARKER constant`)
    assert.equal(count, 1, `marker ${value} is repeated ${count} times`)
  }
})
