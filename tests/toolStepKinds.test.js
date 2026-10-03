import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STEP_FAMILY,
  STEP_KIND,
  groupKindCounts,
  groupToolCalls,
  stepFamilyForKind,
  stepKindForTool,
  stepUsesVerbLabel,
} from '../src/lib/toolStepKinds.js'

test('a tool name decides the step kind, and only the tool name', () => {
  // Reads and listings are 读取; searches are 搜索 — even though a shell command
  // could contain a grep, the tool that ran is what the timeline reports.
  assert.equal(stepKindForTool('read_file'), STEP_KIND.CONSULT)
  assert.equal(stepKindForTool('list_directory'), STEP_KIND.CONSULT)
  assert.equal(stepKindForTool('git_diff'), STEP_KIND.CONSULT)
  assert.equal(stepKindForTool('grep_code'), STEP_KIND.SEARCH)
  assert.equal(stepKindForTool('web_search'), STEP_KIND.SEARCH)
  assert.equal(stepKindForTool('bash_exec'), STEP_KIND.COMMAND)
  assert.equal(stepKindForTool('run_command'), STEP_KIND.COMMAND)
  assert.equal(stepKindForTool('edit_file'), STEP_KIND.EDIT)
  assert.equal(stepKindForTool('multi_edit'), STEP_KIND.EDIT)
  assert.equal(stepKindForTool('write_file'), STEP_KIND.WRITE)
  assert.equal(stepKindForTool('Agent'), STEP_KIND.DELEGATE)
  assert.equal(stepKindForTool('manage_todos'), STEP_KIND.OTHER)
  // New artifact formats share one verb rather than needing a new row label.
  assert.equal(stepKindForTool('create_pptx'), STEP_KIND.CREATE)
  assert.equal(stepKindForTool('create_something_new'), STEP_KIND.CREATE)
  // An unknown or missing tool still gets a row instead of vanishing.
  assert.equal(stepKindForTool('who_knows'), STEP_KIND.OTHER)
  assert.equal(stepKindForTool(''), STEP_KIND.OTHER)
  assert.equal(stepKindForTool(undefined), STEP_KIND.OTHER)
})

test('kinds roll up into the families that label a group row', () => {
  assert.equal(stepFamilyForKind(STEP_KIND.CONSULT), STEP_FAMILY.RETRIEVAL)
  assert.equal(stepFamilyForKind(STEP_KIND.SEARCH), STEP_FAMILY.RETRIEVAL)
  assert.equal(stepFamilyForKind(STEP_KIND.COMMAND), STEP_FAMILY.COMMAND)
  assert.equal(stepFamilyForKind(STEP_KIND.EDIT), STEP_FAMILY.MUTATION)
  assert.equal(stepFamilyForKind(STEP_KIND.WRITE), STEP_FAMILY.MUTATION)
  assert.equal(stepFamilyForKind(STEP_KIND.CREATE), STEP_FAMILY.CREATE)
  assert.equal(stepFamilyForKind(STEP_KIND.DELEGATE), STEP_FAMILY.DELEGATE)
  assert.equal(stepFamilyForKind('nonsense'), STEP_FAMILY.OTHER)
})

test('consecutive same-family calls group, and returning to a family starts a new group', () => {
  const calls = [
    { name: 'read_file' },
    { name: 'grep_code' },
    { name: 'run_command' },
    { name: 'read_file' },
  ]
  const groups = groupToolCalls(calls)
  assert.deepEqual(groups.map((group) => group.family), [
    STEP_FAMILY.RETRIEVAL,
    STEP_FAMILY.COMMAND,
    STEP_FAMILY.RETRIEVAL,
  ])
  // Indices are preserved so a row keeps its identity across re-renders.
  assert.deepEqual(groups[0].calls.map((entry) => entry.index), [0, 1])
  assert.deepEqual(groups[0].calls.map((entry) => entry.kind), [STEP_KIND.CONSULT, STEP_KIND.SEARCH])
  assert.deepEqual(groups[1].calls.map((entry) => entry.index), [2])
  assert.deepEqual(groups[2].calls.map((entry) => entry.index), [3])
})

test('a lone call is still a group of one', () => {
  const groups = groupToolCalls([{ name: 'bash_exec' }])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].calls.length, 1)
  assert.deepEqual(groupToolCalls([]), [])
  assert.deepEqual(groupToolCalls(null), [])
})

test('only everyday tools read as a bare verb; richer names are kept', () => {
  // The row label is the verb for the tools the timeline shows all day…
  for (const name of ['read_file', 'list_directory', 'grep_code', 'bash_exec', 'edit_file', 'write_file']) {
    assert.equal(stepUsesVerbLabel(name), true, name)
  }
  // …and the tool's own name where that name says more than the verb would.
  for (const name of ['read_artifact_source', 'find_symbol', 'git_diff', 'create_pdf', 'request_directory']) {
    assert.equal(stepUsesVerbLabel(name), false, name)
  }
  // Either way the tool still classifies and groups the same way.
  assert.equal(stepKindForTool('read_artifact_source'), STEP_KIND.CONSULT)
  assert.equal(stepKindForTool('create_pdf'), STEP_KIND.CREATE)
})

test('a group reports its kinds in first-appearance order with counts', () => {
  const groups = groupToolCalls([
    { name: 'grep_code' },
    { name: 'read_file' },
    { name: 'read_file' },
    { name: 'grep_code' },
  ])
  assert.deepEqual(groupKindCounts(groups[0]), [
    { kind: STEP_KIND.SEARCH, count: 2 },
    { kind: STEP_KIND.CONSULT, count: 2 },
  ])
  assert.deepEqual(groupKindCounts({ calls: [] }), [])
})
