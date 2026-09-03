import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION,
  createManagedAttachmentGovernancePort,
} from '../server/core/managedAttachmentGovernancePort.js'

function adapter(overrides = {}) {
  return {
    apiVersion: MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION,
    id: 'fixture.attachment-governance',
    captureUserClearSnapshot: ({ userId }) => ({ namespace: 'attachments', userId }),
    stageUserClear: () => ({
      assertStable: () => true,
      cleanup: () => true,
      rollback: () => true,
    }),
    rollbackUserClear: () => true,
    cleanupUserClear: () => true,
    ...overrides,
  }
}

function source(file) {
  return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
}

test('managed attachment governance port validates owner scope and stage capabilities', () => {
  const calls = []
  const port = createManagedAttachmentGovernancePort(adapter({
    cleanupUserClear: (input) => { calls.push(input); return true },
  }))
  assert.equal(port.apiVersion, 1)
  assert.deepEqual(port.captureUserClearSnapshot({ userId: ' user-a ' }), {
    namespace: 'attachments',
    userId: 'user-a',
  })
  const stage = port.stageUserClear({ userId: 'user-a', operationId: 'clear-a' })
  assert.equal(stage.assertStable(), true)
  assert.equal(stage.rollback(), true)
  assert.equal(stage.cleanup(), true)
  assert.equal(port.cleanupUserClear({ userId: 'user-a', operationId: 'clear-a' }), true)
  assert.deepEqual(calls, [{ userId: 'user-a', operationId: 'clear-a' }])
  assert.throws(
    () => port.rollbackUserClear({ userId: '', operationId: 'clear-a' }),
    (error) => error?.code === 'MANAGED_ATTACHMENT_GOVERNANCE_PORT_INVALID',
  )
  assert.throws(
    () => createManagedAttachmentGovernancePort(adapter({ stageUserClear: null })),
    (error) => error?.code === 'MANAGED_ATTACHMENT_GOVERNANCE_PORT_INVALID',
  )
})

test('user-data clear reaches attachment files only through the governance port', () => {
  const core = source('server/core/managedAttachmentGovernancePort.js')
  const facade = source('server/services/userDataGovernanceService.js')
  const preview = source('server/services/userDataClearPreview.js')
  const execution = source('server/services/userDataClearExecution.js')
  const recovery = source('server/services/userDataClearRecovery.js')
  const adapterSource = source('server/adapters/sqliteFileManagedAttachmentGovernanceAdapter.js')

  assert.doesNotMatch(core, /from ['"].*(?:adapters|services)\//u)
  assert.doesNotMatch(core, /from ['"]node:(?:fs|path)/u)
  assert.match(facade, /createSqliteFileManagedAttachmentGovernanceAdapter/u)
  assert.match(facade, /createManagedAttachmentGovernancePort/u)
  assert.match(adapterSource, /stageAttachmentDeletion/u)
  assert.doesNotMatch(preview, /attachmentBucket|stageAttachmentDeletion/u)
  assert.doesNotMatch(execution, /stageAttachmentDeletion|rollbackRecoveredAttachmentStage/u)
  assert.doesNotMatch(recovery, /rollbackRecoveredAttachmentStage/u)
  assert.match(preview, /attachmentGovernancePort\.captureUserClearSnapshot/u)
  assert.match(execution, /attachmentGovernancePort\.stageUserClear/u)
  assert.match(recovery, /attachmentGovernancePort\.rollbackUserClear/u)
})
