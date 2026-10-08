import test from 'node:test'
import assert from 'node:assert/strict'

import { taskVerificationScopes } from '../server/services/loop/taskVerificationCheckScope.js'
import { verificationScopeCovers } from '../server/services/loop/taskVerificationRepairState.js'
import { recordMutationVerificationRecoveryOutcome, restoreMutationVerificationRecovery } from '../server/services/loop/mutationVerificationRecovery.js'
import { normalizeMutationTarget, targetsMatch } from '../server/services/loop/heuristics/mutationClassification.js'

const bash = (command) => ({ name: 'bash_exec', args: { command, cwd: '.' } })
const scopeOf = (command) => taskVerificationScopes(bash(command), { ok: true, exitCode: 0 })[0]

test('a passing check under one package manager does not cover a failure under another', () => {
  const npm = scopeOf('npm test')
  const pnpm = scopeOf('pnpm test')
  assert.ok(npm && pnpm)
  assert.equal(verificationScopeCovers(pnpm, npm), false, 'pnpm test passing says nothing about npm test')
  assert.equal(verificationScopeCovers(scopeOf('npm run test'), npm), true, 'the same manager still covers itself')
  // run_project_check runs `npm run <check>`, so it covers an npm failure.
  const projectCheck = taskVerificationScopes({ name: 'run_project_check', args: { check: 'test' } }, { ok: true, check: 'test' })[0]
  assert.equal(verificationScopeCovers(projectCheck, npm), true)
})

test("the host's own scope fence does not disable automatic verification of the file", () => {
  const s = {
    pendingMutationTargets: new Set(['src/app.js']),
    mutationVerificationRecovery: restoreMutationVerificationRecovery(undefined),
    d: { normalizeMutationTarget, targetsMatch },
    job: { id: 'fence-turn', userId: 'fence-user' },
  }
  const call = { name: 'read_file', args: { path: 'src/app.js' } }
  recordMutationVerificationRecoveryOutcome(s, call, {
    ok: false, denied: true, policyDenied: true, code: 'automatic_verification_scope_changed',
  })
  assert.deepEqual(s.mutationVerificationRecovery.blockedFingerprints, [])
  // A real refusal of the read still blocks the unchanged retry.
  recordMutationVerificationRecoveryOutcome(s, call, { ok: false, denied: true, code: 'approval_denied' })
  assert.equal(s.mutationVerificationRecovery.blockedFingerprints.length, 1)
})
