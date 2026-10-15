import assert from 'node:assert/strict'
import test from 'node:test'
import { commandCheckDescriptors, taskVerificationScopes, taskVerificationKinds } from '../server/services/loop/taskVerificationCheckScope.js'
import { verificationScopeCovers } from '../server/services/loop/taskVerificationRepairState.js'
test('explicit package check namespaces are recognized without merging unrelated scripts', () => {
  const all = commandCheckDescriptors('npm run check:all')
  assert.equal(all.length, 1)
  assert.equal(all[0].kind, 'check')
  assert.deepEqual(taskVerificationKinds({ name: 'run_project_check', args: { check: 'check:all' } }), ['check'])
  const a = taskVerificationScopes({ name: 'run_project_check', args: { check: 'test:all', cwd: '/w' } }, { check: 'test:all', cwd: '/w' })[0]
  const b = taskVerificationScopes({ name: 'run_project_check', args: { check: 'test:smoke', cwd: '/w' } }, { check: 'test:smoke', cwd: '/w' })[0]
  assert.ok(a && b)
  assert.equal(verificationScopeCovers(a, b), false)
})
test('custom entry does not make ambiguous shell chains or no-test options evidence', () => {
  for (const command of ['npm run check:all && echo ok', 'npm run check:all -- --passWithNoTests', 'npm run check:all; rm file', 'npm run check:all > out']) assert.deepEqual(commandCheckDescriptors(command), [])
  assert.ok(taskVerificationScopes({ name: 'run_test', args: { command: './scripts/verify.sh', cwd: '/w' } }, { cwd: '/w' }).length === 1)
})
