import { createSqliteFileManagedAttachmentGovernanceAdapter } from '../adapters/sqliteFileManagedAttachmentGovernanceAdapter.js'
import { createManagedAttachmentGovernancePort } from '../core/managedAttachmentGovernancePort.js'
import {
  buildAuthoritativeUserDataSnapshot,
  createAuthoritativeUserDataArchive,
} from './userDataExportRuntime.js'
import {
  previewAuthoritativeUserDataClear as previewUserDataClear,
} from './userDataClearPreview.js'
import {
  USER_DATA_CLEAR_CONFIRMATION,
  clearAuthoritativeUserData as clearUserData,
} from './userDataClearExecution.js'

function attachmentGovernancePort(options, dependencies) {
  if (dependencies?.attachmentGovernancePort) return dependencies.attachmentGovernancePort
  return createManagedAttachmentGovernancePort(
    createSqliteFileManagedAttachmentGovernanceAdapter({
      env: options?.env || process.env,
      fileSystem: options?.fileSystem,
    }),
  )
}

export { buildAuthoritativeUserDataSnapshot, createAuthoritativeUserDataArchive }
export { USER_DATA_CLEAR_CONFIRMATION }

export function previewAuthoritativeUserDataClear(options = {}, dependencies = {}) {
  return previewUserDataClear(options, {
    ...dependencies,
    attachmentGovernancePort: attachmentGovernancePort(options, dependencies),
  })
}

export function clearAuthoritativeUserData(options = {}, dependencies = {}) {
  return clearUserData(options, {
    ...dependencies,
    attachmentGovernancePort: attachmentGovernancePort(options, dependencies),
  })
}
