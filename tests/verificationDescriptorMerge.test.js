import assert from 'node:assert/strict'
import test from 'node:test'
import { commandCheckDescriptors } from '../server/services/loop/taskVerificationCheckScope.js'
import { isLocalMutationCall, isVerificationCall } from '../server/services/loop/heuristics/mutationClassification.js'
import { clearVerifiedMutationTargets } from '../server/services/loop/heuristics/mutationVerification.js'
import { getBuiltinSpec, getToolMetadata } from '../server/utils/toolSchemaCatalog.js'
import { runToolLoop } from '../server/services/loop/index.js'

test('a trailing stderr-to-stdout merge preserves verification identity without granting read-only permission', () => {
  for (const command of ['npm test', 'npm run lint', 'python -m pytest -q', 'cd packages/api && npm test']) {
    const redirected = `${command} 2>&1`
    assert.deepEqual(commandCheckDescriptors(redirected), commandCheckDescriptors(command), redirected)
    const call = { name: 'bash_exec', args: { command: redirected, cwd: '.' } }
    assert.equal(isVerificationCall(call), true)
    assert.equal(isLocalMutationCall(call), false)
    assert.equal(getToolMetadata('bash_exec', { args: call.args }).isReadOnly, false, 'checks still require command approval')
  }
})

test('descriptor merging cannot conceal file writes, masked failures, compound commands, or quoted shell data', () => {
  for (const command of [
    'npm test > result.txt 2>&1', 'npm test 2> result.txt', 'npm test || echo passed 2>&1',
    'npm test | cat 2>&1', 'npm test & echo passed 2>&1', 'npm test && node mutate.js 2>&1',
    'npm test 2>&1 > result.txt', 'npm test 2>&1echo', 'npm test "2>&1"', 'npm test "literal 2>&1',
  ]) assert.deepEqual(commandCheckDescriptors(command), [], command)
})

test('a successful redirected check clears its workspace obligation, but failed or unrelated checks do not', () => {
  const call = { name: 'bash_exec', args: { command: 'npm test 2>&1', cwd: '.' } }
  const pending = new Set(['<workspace>'])
  assert.equal(clearVerifiedMutationTargets(pending, call, { ok: false, exitCode: 1, cwd: '' }), false)
  assert.equal(clearVerifiedMutationTargets(pending, call, { ok: true, exitCode: 0, cwd: '' }), true)
  assert.equal(pending.size, 0)
})

test('the real loop can finish after mutation and a successful check with diagnostic descriptor merging', async () => {
  let requests = 0
  const checkpoints = []
  const result = await runToolLoop({ job: { id: 'stderr-check-loop', userId: 'stderr-check-owner', origin: 'chat',
    prompt: 'Fix src/counter.js and run the project tests.' }, step: { id: 'stderr-check-step', kind: 'chat' },
  messages: [{ role: 'user', content: 'Fix src/counter.js and run the project tests.' }],
  toolSpecs: [getBuiltinSpec('edit_file'), getBuiltinSpec('bash_exec')], maxIters: 4, enableToolHooks: false,
  requestToolApproval: async ({ args }) => ({ proceed: true, args, approvalId: 'offline-check-approved' }),
  saveCheckpoint: async (value) => checkpoints.push(structuredClone(value?.state || value)),
  runModel: async () => {
    requests += 1
    const proposal = requests === 1 ? { name: 'edit_file', arguments: '{"path":"src/counter.js","old_string":"false","new_string":"true"}' }
      : requests === 2 ? { name: 'bash_exec', arguments: '{"command":"npm test 2>&1","cwd":"."}' } : null
    return proposal ? { content: '', toolCalls: [{ id: `stderr-call-${requests}`, type: 'function', function: proposal }] }
      : { content: 'The counter is fixed and the project tests passed.', toolCalls: [] }
  },
  executeTool: async ({ name }) => name === 'edit_file'
    ? { ok: true, path: 'src/counter.js', changes: [{ path: 'src/counter.js', additions: 1, deletions: 1 }] }
    : { ok: true, exitCode: 0, stdout: '> test\n> node test.mjs\n', stderr: '', cwd: '' },
  })
  assert.notEqual(result.incomplete, true)
  assert.ok(checkpoints.at(-1).completionGuards.pendingMutationTargets.length === 0)
  assert.ok(requests <= 4, 'verification must not reopen a new workspace mutation every round')
})
