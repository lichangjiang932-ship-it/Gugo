import fs from 'node:fs'

import { MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION } from '../core/managedAttachmentGovernancePort.js'
import {
  captureAttachmentClearSnapshot,
  cleanupRecoveredAttachmentStage,
  rollbackRecoveredAttachmentStage,
  stageAttachmentDeletion,
} from '../services/userDataClearFilesystem.js'
import { clearOperationPaths } from '../services/userDataClearJournal.js'

export function createSqliteFileManagedAttachmentGovernanceAdapter({
  env = process.env,
  fileSystem = fs,
} = {}) {
  const paths = (input) => clearOperationPaths({
    userId: input.userId,
    operationId: input.operationId,
    env,
  })
  return Object.freeze({
    apiVersion: MANAGED_ATTACHMENT_GOVERNANCE_PORT_VERSION,
    id: 'builtin.sqlite-file-governance',
    captureUserClearSnapshot({ userId }) {
      return captureAttachmentClearSnapshot({ userId, env, fileSystem })
    },
    stageUserClear({ userId, operationId, expectedSnapshot = null }) {
      return stageAttachmentDeletion(userId, operationId, env, fileSystem, expectedSnapshot)
    },
    rollbackUserClear(input) {
      return rollbackRecoveredAttachmentStage(paths(input), fileSystem)
    },
    cleanupUserClear(input) {
      return cleanupRecoveredAttachmentStage(paths(input), fileSystem)
    },
  })
}
