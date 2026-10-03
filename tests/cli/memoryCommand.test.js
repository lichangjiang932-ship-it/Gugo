import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMemoryArgs } from '../../bin/cli/memoryCommand.js'
import { CliUsageError } from '../../bin/cli/errors.js'

test('memory command parses bounded explicit scope before any runtime initialization', () => {
  assert.deepEqual(parseMemoryArgs(['reindex']), { subcommand: 'reindex', options: { batch: 8, limit: 200 } })
  assert.deepEqual(parseMemoryArgs(['reindex', '--limit', '2000', '--batch=32', '--agent', 'agent-one']).options,
    { limit: 2000, batch: 32, agent: 'agent-one' })
  assert.equal(parseMemoryArgs(['reindex', '--all-agents']).options.allAgents, true)
  assert.equal(parseMemoryArgs([], { help: true }).subcommand, null)
  for (const argv of [
    [], ['unknown'], ['reindex', 'extra'], ['reindex', '--batch', '0'], ['reindex', '--batch', '33'],
    ['reindex', '--limit', 'Infinity'], ['reindex', '--limit', '2001'], ['reindex', '--limit', '9007199254740992'],
    ['reindex', '--agent', 'a', '--all-agents'], ['reindex', '--agent', '__all__'],
    ['reindex', '--limit', '1', '--limit', '2'], ['reindex', '--all-agents', '--all-agents'],
    ['reindex', '--agent', '--limit', '3'], ['reindex', '--all-agents=true'],
  ]) assert.throws(() => parseMemoryArgs(argv), CliUsageError, JSON.stringify(argv))
})

test('memory help only skips the absent subcommand, never explicit invalid flags', () => {
  for (const argv of [['reindex', '--bogus'], ['reindex', '--batch', '0'], ['reindex', '--agent', 'a', '--all-agents']]) {
    assert.throws(() => parseMemoryArgs(argv, { help: true }), CliUsageError)
  }
})
