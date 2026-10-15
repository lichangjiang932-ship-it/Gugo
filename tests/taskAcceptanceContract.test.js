import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeStepAcceptance, verifyStepEvidence } from '../server/services/goalPlanEvidence.js'
const contract = checks => [{ kind: 'contract', version: 1, checks }]
const command = './scripts/verify.sh'
function evidence({ cmd = command, cwd = '/project', digest = 'a'.repeat(64), mutateAfter = false } = {}) {
  const events = [
    { type: 'tool.started', turnId: 't', sessionId: 's', sequence: 1, payload: { toolCallId: 'v', name: 'run_test', args: { command: cmd, cwd } } },
    { type: 'tool.completed', turnId: 't', sessionId: 's', sequence: 2, payload: { toolCallId: 'v', name: 'run_test', args: { command: cmd, cwd }, result: { ok: true, exitCode: 0, executionCwd: cwd } } },
    { type: 'tool.completed', turnId: 't', sessionId: 's', sequence: 3, payload: { toolCallId: 'w', name: 'write_file', result: { ok: true, path: '/project/report.md', sha256: digest } } },
    { type: 'turn.completed', turnId: 't', sessionId: 's', sequence: 4, payload: { text: 'done', taskVerification: { ok: true, checks: [{ kind: 'test', cwd: '/project', status: 'passed' }] } } },
  ]
  if (mutateAfter) events.splice(3, 0, { type: 'tool.completed', turnId: 't', sessionId: 's', sequence: 3, payload: { name: 'write_file', toolCallId: 'later', result: { ok: true, path: '/project/report.md', sha256: 'b'.repeat(64) } } })
  return { events, evidence: { turnId: 't' }, sessionId: 's' }
}
test('a versioned contract requires all declared outcomes, not just any successful command', () => {
  const acceptance = contract([{ kind: 'command', command, cwd: '/project' }, { kind: 'file', path: '/project/report.md', sha256: 'a'.repeat(64) }])
  assert.equal(verifyStepEvidence({ ...evidence(), acceptance }).verified, true)
  assert.equal(verifyStepEvidence({ ...evidence({ cmd: 'npm test' }), acceptance }).verified, false)
  assert.equal(verifyStepEvidence({ ...evidence({ cwd: '/other' }), acceptance }).verified, false)
  assert.equal(verifyStepEvidence({ ...evidence({ digest: 'b'.repeat(64) }), acceptance }).verified, false)
})
test('empty, future and ambiguous contracts cannot weaken into a successful-tool fallback', () => {
  for (const value of [[{ kind: 'contract', version: 2, checks: [{ kind: 'tool' }] }], contract([]), contract(['looks good']), contract([{ kind: 'tool' }])]) assert.throws(() => normalizeStepAcceptance(value))
})
test('a later write to the same target invalidates an older digest receipt', () => {
  const acceptance = contract([{ kind: 'file', path: '/project/report.md', sha256: 'a'.repeat(64) }])
  assert.equal(verifyStepEvidence({ ...evidence({ mutateAfter: true }), acceptance }).verified, false)
})
