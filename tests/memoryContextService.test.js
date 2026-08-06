import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareMemoryInjectionContext } from '../server/services/memoryContextService.js'

const filesystemConstraint = {
  id: 'memory-filesystem-constraint',
  type: 'project',
  title: 'Filesystem_Constraint',
  body: 'Access via list_directory and read_file is unavailable because WORKSPACE_FS_ENABLED is not enabled.',
  updatedAt: Date.now(),
}

const userPreference = {
  id: 'memory-user-preference',
  type: 'preference',
  title: 'Answer style',
  body: 'Keep answers concise.',
  updatedAt: Date.now(),
}

function prepare(query) {
  return prepareMemoryInjectionContext({
    userId: 'user-1',
    query,
    linkDepth: 0,
    touch: false,
  }, {
    selectActiveMemoriesForInjection: () => ({
      memories: [filesystemConstraint, userPreference],
      totalChars: 200,
    }),
    buildMemorySystemBlock: (memories) => memories.map((memory) => memory.body).join('\n'),
  })
}

test('verified filesystem success suppresses only contradictory capability memory', () => {
  const result = prepare([
    '[VERIFIED LOCAL FILESYSTEM ACCESS]',
    'Path: D:\\destok\\money',
    'Tool: list_directory',
    'Succeeded: yes',
  ].join('\n'))

  assert.deepEqual(result.memoryIds, ['memory-user-preference'])
  assert.deepEqual(result.diagnostics.suppressedMemoryIds, ['memory-filesystem-constraint'])
  assert.doesNotMatch(result.text, /WORKSPACE_FS_ENABLED/)
  assert.match(result.text, /Keep answers concise/)
})

test('unverified requests retain filesystem memories', () => {
  const result = prepare('Please inspect D:\\destok\\money')

  assert.deepEqual(result.memoryIds, ['memory-filesystem-constraint', 'memory-user-preference'])
  assert.deepEqual(result.diagnostics.suppressedMemoryIds, [])
})
