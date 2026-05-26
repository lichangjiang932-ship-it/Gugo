import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMentions } from '../server/services/mentionsParser.js'

const agents = [
  { id: 'hanako', name: 'Hanako', handle: 'hana' },
  { id: 'ming', name: 'Ming' },
  { id: 'bob', name: 'Bob Ray' },
]

test('mentionsParser: @handle hits agent id', () => {
  const result = parseMentions('@hana please check', agents)
  assert.deepEqual(result.mentions, ['hanako'])
  assert.equal(result.cleanedText, 'please check')
})

test('mentionsParser: multiple mentions are resolved once', () => {
  const result = parseMentions('@hana ask @Ming and @hana again', agents)
  assert.deepEqual(result.mentions, ['hanako', 'ming'])
  assert.equal(result.cleanedText, 'ask and again')
})

test('mentionsParser: case insensitive name matching', () => {
  const result = parseMentions('ping @hAnAkO', agents)
  assert.deepEqual(result.mentions, ['hanako'])
})

test('mentionsParser: escaped @ is ignored and unescaped in cleaned text', () => {
  const result = parseMentions(String.raw`please keep \@hana literal`, agents)
  assert.deepEqual(result.mentions, [])
  assert.equal(result.cleanedText, 'please keep @hana literal')
})

test('mentionsParser: unknown mentions are ignored', () => {
  const result = parseMentions('@nobody and @Bob Ray', agents)
  assert.deepEqual(result.mentions, ['bob'])
  assert.equal(result.cleanedText, '@nobody and')
})
