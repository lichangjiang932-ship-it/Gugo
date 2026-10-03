import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NO_APPROVAL_CHANNEL_DECIDED_BY,
  normalizeApprovalDecision,
  resolveHeadlessApprovalDecision,
} from '../server/services/headlessApprovalChannel.js'
import { assertSelectedFilesAreCommittable, isCommittableCredentialPath } from '../server/adapters/gitCommitPathGuard.js'

test('only a terminal answer attributes the approval to the user', async () => {
  const diagnostics = []
  const answered = await resolveHeadlessApprovalDecision({
    interactive: true,
    onApproval: async () => ({ decision: 'approve' }),
    onDiagnostic: (message) => diagnostics.push(message),
    event: { payload: { toolName: 'write_file' } },
    approvalId: 'a1',
    userId: 'user-1',
  })
  assert.deepEqual(answered, { decision: 'approve', decidedBy: 'user-1' })
  assert.deepEqual(diagnostics, [], 'an answered prompt needs no diagnostics')
})

test('a non-interactive deny is attributed to the runtime and explained', async () => {
  const diagnostics = []
  const result = await resolveHeadlessApprovalDecision({
    interactive: false,
    onApproval: async () => assert.fail('a non-interactive run must not prompt'),
    onDiagnostic: (message) => diagnostics.push(message),
    event: { payload: { toolName: 'bash_exec' } },
    approvalId: 'a2',
    userId: 'user-1',
  })
  assert.deepEqual(result, { decision: 'deny', decidedBy: NO_APPROVAL_CHANNEL_DECIDED_BY })
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /bash_exec/u)
  assert.match(diagnostics[0], /--mode acceptEdits/u)
})

test('a prompt that fails is denied without blaming the user', async () => {
  const diagnostics = []
  const result = await resolveHeadlessApprovalDecision({
    interactive: true,
    onApproval: async () => { throw new Error('stdin closed') },
    onDiagnostic: (message) => diagnostics.push(message),
    event: { payload: { toolName: 'write_file' } },
    approvalId: 'a3',
    userId: 'user-1',
  })
  // The prompt never produced an answer, so this is not a user refusal.
  assert.deepEqual(result, { decision: 'deny', decidedBy: NO_APPROVAL_CHANNEL_DECIDED_BY })
  assert.match(diagnostics[0], /approval prompt failed/u)
  assert.match(diagnostics[0], /stdin closed/u)
})

test('only approve and deny survive normalization; anything else denies', () => {
  for (const value of ['approve', 'deny', { decision: 'approve' }, { decision: 'deny' }]) {
    assert.match(normalizeApprovalDecision(value), /^(?:approve|deny)$/u)
  }
  for (const value of [null, undefined, '', 'yes', 'y', 'APPROVE', { decision: 'edit' }, 42]) {
    assert.equal(normalizeApprovalDecision(value), 'deny', JSON.stringify(value))
  }
})

test('the credential screen names the paths it refuses and allows the templates', () => {
  for (const file of ['.env', 'config/.env', '.env.local', '.netrc', 'id_rsa', 'deploy.pem', 'a/b/server.key', 'store.p12', 'x.jks']) {
    assert.equal(isCommittableCredentialPath(file), false, file)
  }
  for (const file of ['.env.example', 'config/.env.template', '.env.sample', 'deploy.pub', 'app.js', 'notes/keys.md', '']) {
    assert.equal(isCommittableCredentialPath(file), true, file)
  }

  const error = (() => {
    try {
      assertSelectedFilesAreCommittable(['app.js', '.env', 'id_rsa'])
    } catch (thrown) { return thrown }
    return null
  })()
  assert.equal(error?.code, 'GIT_COMMIT_SENSITIVE_FILES')
  // The whole batch is refused, and the message names only the offending paths.
  assert.deepEqual(error.files, ['.env', 'id_rsa'])
  assert.match(error.message, /\.env, id_rsa/u)
  assert.doesNotMatch(error.message, /app\.js/u)
  assert.equal(error.statusCode, 403)

  assert.doesNotThrow(() => assertSelectedFilesAreCommittable(['app.js', 'README.md']))
})
