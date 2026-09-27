import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_ROUND_KIND, buildAgentRounds, toAgentRoundList } from '../src/lib/agentRounds.js'

const trajectory = [
  { kind: 'thought', text: '先看仓库状态。' },
  { kind: 'action', text: '读取 package.json' },
  { kind: 'observation', text: '读到 36 个脚本。' },
  { kind: 'thought', text: '再搜一个文件。' },
  { kind: 'action', text: '搜索 sourceOrderAssertion' },
  { kind: 'observation', text: '只有一个文件命中。' },
]

test('the k-th action is paired with the k-th recorded call, in order', () => {
  const first = { id: 'read-1', name: 'read_file' }
  const second = { id: 'grep-1', name: 'grep_code' }
  const { steps, leftoverCalls } = buildAgentRounds({ trajectory, toolCalls: [first, second] })

  assert.deepEqual(steps.map((step) => step.kind), [
    'thought', 'action', 'tool', 'observation', 'thought', 'action', 'tool', 'observation',
  ])
  assert.equal(steps[2].call, first)
  assert.equal(steps[2].index, 0)
  assert.equal(steps[6].call, second)
  assert.equal(steps[6].index, 1)
  assert.deepEqual(leftoverCalls, [])
})

test('calls the narrative never mentioned come back as leftovers instead of vanishing', () => {
  // A framework call (setting deliverables) is often not narrated as an action.
  // It must still appear — dropping a call the runtime really made would hide it.
  const read = { id: 'read-1', name: 'read_file' }
  const grep = { id: 'grep-1', name: 'grep_code' }
  const deliverables = { id: 'deliver-1', name: 'set_deliverables' }
  const { steps, leftoverCalls } = buildAgentRounds({
    trajectory: trajectory.slice(0, 3),
    toolCalls: [read, grep, deliverables],
  })

  assert.deepEqual(steps.map((step) => step.kind), ['thought', 'action', 'tool', 'observation'])
  assert.deepEqual(leftoverCalls.map((entry) => entry.call.id), ['grep-1', 'deliver-1'])
  assert.deepEqual(leftoverCalls.map((entry) => entry.index), [1, 2])
})

test('a narrative without actions still renders as steps, and no narrative means no loop', () => {
  // Thought-only narration is still narration: every step becomes a one-line row
  // that opens onto its body.
  const thoughtsOnly = buildAgentRounds({ trajectory: [{ kind: 'thought', text: 'x' }], toolCalls: [] })
  assert.deepEqual(thoughtsOnly.steps, [{ kind: 'thought', text: 'x' }])
  assert.deepEqual(thoughtsOnly.leftoverCalls, [])

  // A turn that only ran tools has no round to describe, so the caller keeps the
  // grouped tool timeline rather than a loop with nothing but calls in it.
  assert.equal(buildAgentRounds({ trajectory: [], toolCalls: [{ id: 'a', name: 'read_file' }] }), null)
  assert.equal(buildAgentRounds({}), null)
  assert.equal(buildAgentRounds(), null)
  assert.equal(buildAgentRounds({ trajectory: [{ kind: 'thought', text: '   ' }], toolCalls: [] }), null)
})

test('more actions than calls still pairs what it can and never invents a call', () => {
  const { steps, leftoverCalls } = buildAgentRounds({
    trajectory: [
      { kind: 'action', text: '运行 npm test' },
      { kind: 'observation', text: '全绿。' },
      { kind: 'action', text: '再跑一次' },
    ],
    toolCalls: [{ id: 'run-1', name: 'run_command' }],
  })

  assert.deepEqual(steps.map((step) => step.kind), ['action', 'tool', 'observation', 'action'])
  assert.equal(steps[1].call.id, 'run-1')
  assert.deepEqual(leftoverCalls, [])
})

test('the tool row is attached to the action above it', () => {
  const list = toAgentRoundList(...Object.values(buildAgentRounds({
    trajectory,
    toolCalls: [{ id: 'read-1', name: 'read_file' }, { id: 'grep-1', name: 'grep_code' }],
  })).slice(0, 2))

  assert.deepEqual(list.map((entry) => entry.kind), [
    'thought', 'action', 'observation', 'thought', 'action', 'observation',
  ])
  assert.equal(list[1].tool.call.id, 'read-1')
  assert.equal(list[4].tool.call.id, 'grep-1')
  assert.equal(list[0].tool, undefined)
  assert.equal(list[2].tool, undefined)
})

test('leftovers are appended after the rounds and marked as such', () => {
  const { steps, leftoverCalls } = buildAgentRounds({
    trajectory: trajectory.slice(0, 3),
    toolCalls: [{ id: 'read-1', name: 'read_file' }, { id: 'deliver-1', name: 'set_deliverables' }],
  })
  const list = toAgentRoundList(steps, leftoverCalls)

  assert.deepEqual(list.map((entry) => entry.kind), ['thought', 'action', 'observation', 'tool'])
  assert.equal(list[1].tool.call.id, 'read-1')
  assert.equal(list[3].tool.call.id, 'deliver-1')
  assert.equal(list[3].leftover, true)
})

test('empty text entries are skipped rather than rendered as blank steps', () => {
  const { steps } = buildAgentRounds({
    trajectory: [
      { kind: 'thought', text: '   ' },
      { kind: 'action', text: '运行 npm test' },
      { kind: 'observation', text: '全绿。' },
    ],
    toolCalls: [{ id: 'run-1', name: 'run_command' }],
  })
  const list = toAgentRoundList(steps)
  assert.deepEqual(list.map((entry) => entry.kind), ['action', 'observation'])
  assert.equal(list[0].tool.call.id, 'run-1')
})

test('the round kinds are the parser\'s own, so the two cannot drift apart', () => {
  assert.equal(AGENT_ROUND_KIND.THOUGHT, 'thought')
  assert.equal(AGENT_ROUND_KIND.ACTION, 'action')
  assert.equal(AGENT_ROUND_KIND.OBSERVATION, 'observation')
})
