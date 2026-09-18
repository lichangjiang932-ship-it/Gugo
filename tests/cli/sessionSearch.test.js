import assert from 'node:assert/strict'
import test from 'node:test'

import {
  excerptAround,
  extractTurnRecords,
  formatSearchMatches,
  matchTurnRecords,
  parseSearchArgs,
  SEARCH_DEFAULT_LIMIT,
} from '../../bin/cli/sessionSearch.js'
import { createStyler } from '../../bin/cli/terminalTheme.js'

const ESC = String.fromCharCode(27)

test('turn events fold into one record per turn, concatenating assistant deltas', () => {
  const records = extractTurnRecords([
    { turnId: 't1', sequence: 0, type: 'turn.started', payload: { content: 'what is 2+2' } },
    { turnId: 't1', sequence: 1, type: 'assistant.delta', payload: { text: 'It is ' } },
    { turnId: 't1', sequence: 2, type: 'assistant.delta', payload: { text: 'four.' } },
    { turnId: 't2', sequence: 3, type: 'turn.started', payload: { content: 'and 3+3' } },
    { turnId: 't2', sequence: 4, type: 'assistant.delta', payload: { text: 'six' } },
  ])
  assert.deepEqual(records, [
    { turnId: 't1', user: 'what is 2+2', assistant: 'It is four.' },
    { turnId: 't2', user: 'and 3+3', assistant: 'six' },
  ])
})

test('folding tolerates missing fields, stray types and out-of-order events', () => {
  assert.deepEqual(extractTurnRecords([]), [])
  assert.deepEqual(extractTurnRecords(null), [])
  assert.deepEqual(
    extractTurnRecords([
      { sequence: 1, type: 'turn.started', payload: { content: 'second' }, turnId: 'b' },
      { type: 'turn.started', payload: { content: 'first' }, turnId: 'a' },
      { type: 'turn.started', payload: {} },
      { type: 'model.phase', payload: { phase: 'completed' }, turnId: 'a' },
      { turnId: 'a', type: 'turn.started', payload: { content: 'ignored? no: overwrites' } },
    ]),
    [
      { turnId: 'a', user: 'ignored? no: overwrites', assistant: '' },
      { turnId: 'b', user: 'second', assistant: '' },
    ],
    'events without a turnId are dropped; sequence orders the rest',
  )
})

test('excerpts keep the match visible and only ellipsize what was actually cut', () => {
  const text = `${'a'.repeat(100)}NEEDLE${'b'.repeat(100)}`
  const excerpt = excerptAround(text, 100, 6, 10)
  assert.ok(excerpt.includes('NEEDLE'))
  assert.ok(excerpt.startsWith('…') && excerpt.endsWith('…'))

  assert.equal(excerptAround('NEEDLE here', 0, 6, 10), 'NEEDLE here', 'no ellipsis when nothing was cut')
  assert.equal(excerptAround('a\n\nb NEEDLE', 6, 6, 10).includes('\n'), false, 'whitespace is collapsed')
  assert.equal(excerptAround('', 0, 1), '')
})

test('matching is case-insensitive, Unicode-normalised, and user text comes first', () => {
  const records = [
    { turnId: 't1', user: 'Deploy the SERVICE', assistant: 'deployed service ok' },
    { turnId: 't2', user: 'nothing', assistant: 'service again' },
  ]
  const matches = matchTurnRecords(records, 'service')
  assert.equal(matches.length, 3)
  assert.deepEqual(matches.map((m) => [m.turnId, m.role]), [['t1', 'user'], ['t1', 'assistant'], ['t2', 'assistant']])

  assert.equal(matchTurnRecords(records, 'SERVICE').length, 3, 'case does not matter')
  assert.equal(matchTurnRecords(records, '  ').length, 0, 'a blank query matches nothing')
  assert.equal(matchTurnRecords(records, 'absent').length, 0)
  assert.equal(matchTurnRecords(records, 'service', { limit: 2 }).length, 2)
  assert.equal(matchTurnRecords(null, 'x').length, 0)
})

test('rendering reports the count and points at the offending turn', () => {
  const plain = formatSearchMatches([], { query: 'nope' })
  assert.match(plain, /No match for "nope"/)
  assert.ok(!plain.includes(ESC))

  const matches = [{ turnId: 'abcdef1234567890', role: 'user', index: 0, excerpt: 'the excerpt' }]
  const styled = formatSearchMatches(matches, { query: 'q', styler: createStyler(true) })
  assert.ok(styled.includes(ESC), 'an enabled styler paints the output')
  assert.ok(styled.includes('abcdef12'), 'the turn id is shortened for display')
  assert.match(styled, /1 match for "q":/)

  const two = formatSearchMatches([...matches, { ...matches[0], role: 'assistant' }], { query: 'q' })
  assert.match(two, /2 matches for "q":/)
})

test('search arguments accept a query and an optional bounded limit', () => {
  assert.deepEqual(parseSearchArgs('deploy service'), { query: 'deploy service', limit: SEARCH_DEFAULT_LIMIT })
  assert.deepEqual(parseSearchArgs('deploy --limit 5'), { query: 'deploy', limit: 5 })
  assert.deepEqual(parseSearchArgs(''), { query: '', limit: SEARCH_DEFAULT_LIMIT })
  assert.deepEqual(parseSearchArgs(null), { query: '', limit: SEARCH_DEFAULT_LIMIT })
  assert.deepEqual(parseSearchArgs('q --limit 0').limit, SEARCH_DEFAULT_LIMIT, 'zero is not a usable limit')
  assert.deepEqual(parseSearchArgs('q --limit 9999').limit, 200, 'the limit is capped')
  assert.deepEqual(parseSearchArgs('--limit 5').query, '', 'a bare limit leaves no query')
})
