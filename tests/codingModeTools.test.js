import test from 'node:test'
import assert from 'node:assert/strict'

import { buildToolSpecs, listToolNames, resolveToolsForMode } from '../src/lib/tools/index.js'

test('chat tools expose git status/diff/check but never expose commit/push to the model', () => {
  const names = listToolNames()
  assert.ok(names.includes('git_status'))
  assert.ok(names.includes('git_diff'))
  assert.ok(names.includes('run_project_check'))
  assert.ok(!names.includes('git_commit'))
  assert.ok(!names.includes('git_push'))
})

test('shell and git tool schemas accept authorized directory cwd values', () => {
  const specs = buildToolSpecs(['bash_exec', 'git_status', 'git_diff', 'run_project_check'])
  for (const spec of specs) {
    assert.ok(spec.function.parameters.properties.cwd, `${spec.function.name} should expose cwd`)
  }
})

test('plan mode keeps enabled tools visible while the server gate owns execution policy', () => {
  const enabled = resolveToolsForMode({
    web_search: true,
    read_file: true,
    write_file: true,
    edit_file: true,
    bash_exec: true,
    git_status: true,
    git_diff: true,
    run_project_check: true,
  }, 'plan')
  assert.deepEqual(enabled.sort(), [
    'web_search',
    'read_file',
    'write_file',
    'edit_file',
    'bash_exec',
    'git_status',
    'git_diff',
    'run_project_check',
  ].sort())
})

test('code mode enables Claude/Codex workspace loop tools', () => {
  const enabled = resolveToolsForMode({}, 'code')
  for (const name of ['read_file', 'write_file', 'edit_file', 'bash_exec', 'git_status', 'git_diff', 'run_project_check']) {
    assert.ok(enabled.includes(name), `${name} should be available in code mode`)
  }
})
