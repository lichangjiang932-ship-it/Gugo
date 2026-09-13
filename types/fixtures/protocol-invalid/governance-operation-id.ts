import { createManagedAttachmentGovernancePort } from '../../../server/core/managedAttachmentGovernancePort.js'
import type { ManagedAttachmentGovernanceAdapter } from '../../kernel-ports.js'

const adapter: ManagedAttachmentGovernanceAdapter = {
  apiVersion: 1,
  id: 'fixture.governance',
  captureUserClearSnapshot: () => ({}),
  stageUserClear: () => ({
    assertStable: () => true,
    cleanup: () => true,
    rollback: () => true,
  }),
  rollbackUserClear: () => true,
  cleanupUserClear: () => true,
}

const port = createManagedAttachmentGovernancePort(adapter)
port.stageUserClear({ userId: 'user-1', operationId: 42 })
