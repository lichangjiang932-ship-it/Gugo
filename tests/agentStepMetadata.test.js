import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractFileOutcome,
  extractFileOutcomes,
  extractStepBadges,
  isFileWriteCall,
} from '../shared/agentStepMetadata.js'

test('a file write resolves its path and real metrics from the tool result first', () => {
  const call = {
    name: 'write_file',
    status: 'success',
    args: { path: 'probe-plan.md', content: 'hello' },
    result: { path: 'probe-plan.md', bytes: 5, changes: 1, sha256: 'a'.repeat(64) },
  }
  assert.equal(isFileWriteCall(call), true)
  assert.deepEqual(extractFileOutcome(call), {
    path: 'probe-plan.md',
    changed: 1,
    bytes: 5,
    additions: null,
    deletions: null,
    sha256: 'a'.repeat(64),
    status: 'success',
  })
})

test('narrative metrics fill gaps the structured result left empty', () => {
  const call = {
    name: 'write_file',
    status: 'success',
    args: { file_path: 'notes/todo.md' },
    // The model wrote the metrics as prose; they still become typed values.
    result: 'wrote notes/todo.md path=probe-plan.md bytes=5 changes=1',
  }
  const outcome = extractFileOutcome(call)
  assert.equal(outcome.path, 'notes/todo.md') // argument beats prose
  assert.equal(outcome.bytes, 5)
  assert.equal(outcome.changed, 1)
  // Nothing parseable simply stays absent — never guessed.
  assert.equal(extractFileOutcome({ name: 'run_command', status: 'success', args: {}, result: 'done' }), null)
  assert.equal(extractFileOutcome({ name: 'write_file', args: { path: 'a' }, result: 'x=1' }).changed, 1)
})

test('a multi-file patch lists every file it changed', () => {
  const call = {
    name: 'apply_patch',
    status: 'success',
    args: { patch: '@@ a\n+x' },
    result: {
      files: [
        { path: 'src/a.js', additions: 3, deletions: 1 },
        { path: 'src/b.js', additions: 2, deletions: 0 },
      ],
    },
  }
  const outcomes = extractFileOutcomes(call)
  assert.equal(outcomes.length, 2)
  assert.deepEqual(outcomes.map((item) => item.path), ['src/a.js', 'src/b.js'])
  assert.equal(outcomes[0].changed, 1)
  assert.equal(outcomes[1].additions, 2)
})

test('observation metrics become scannable badges in written order', () => {
  assert.deepEqual(extractStepBadges('verified path=probe-plan.md bytes=5 changes=1 sha256=abc123def456'),
    [
      { key: 'changes', value: '1' },
      { key: 'bytes', value: '5' },
      { key: 'sha256', value: 'abc123def456' },
    ])
  assert.deepEqual(extractStepBadges('no metrics here'), [])
})
