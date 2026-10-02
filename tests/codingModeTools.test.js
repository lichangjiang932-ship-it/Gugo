import test from 'node:test'
import assert from 'node:assert/strict'

import { getBuiltinSpec, listBuiltinNames, resolveSpecsForMode } from '../server/services/toolRegistry.js'

test('canonical server catalog exposes the git capability tools', () => {
  const names = listBuiltinNames()
  assert.ok(names.includes('git_status'))
  assert.ok(names.includes('git_diff'))
  assert.ok(names.includes('run_project_check'))
  assert.ok(names.includes('git_commit'))
  assert.ok(names.includes('git_push'))
})

test('shell and git tool schemas accept authorized directory cwd values', () => {
  for (const name of ['bash_exec', 'git_status', 'git_diff', 'run_project_check']) {
    const spec = getBuiltinSpec(name)
    assert.ok(spec, `${name} should be in the server catalog`)
    assert.ok(spec.function.parameters.properties.cwd, `${name} should expose cwd`)
  }
})

test('plan mode intersects enabled tools with the canonical server policy catalog', () => {
  const planNames = new Set(resolveSpecsForMode('plan').map((entry) => entry.name))
  const enabled = [
    'web_search',
    'read_file',
    'write_file',
    'edit_file',
    'bash_exec',
    'git_status',
    'git_diff',
    'run_project_check',
  ].filter((name) => planNames.has(name))
  // Plan mode researches like Claude Code's: web search joins the local reads;
  // writes, commands and project checks stay out.
  assert.deepEqual(enabled.sort(), [
    'web_search',
    'read_file',
    'git_status',
    'git_diff',
  ].sort())
})

test('code mode enables Claude/Codex workspace loop tools', () => {
  const serverCodeNames = new Set(resolveSpecsForMode('code').map((entry) => entry.name))
  for (const name of ['run_code', 'read_file', 'write_file', 'edit_file', 'bash_exec', 'git_status', 'git_diff', 'run_project_check']) {
    assert.ok(serverCodeNames.has(name), `${name} should be available in code mode`)
  }
})
