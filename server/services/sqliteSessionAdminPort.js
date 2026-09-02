import {
  archiveSession,
  deleteSession,
  forkSession,
  getSession,
  getSessionBranches,
  getSessionSnapshot,
  listSessions,
  pinSession,
  replaceSessionMessages,
  setSessionWorkspace as persistSessionWorkspace,
  unarchiveSession,
  unpinSession,
} from './sessionStore.js'
import { resolveTurnProjectDirectory } from './localFileAccessService.js'
import { searchMessages } from './sessionSearchService.js'
import { importLegacySessions } from './legacySessionImportService.js'
import {
  prepareSessionAdminPort,
  SESSION_ADMIN_PORT_CONTRACT_VERSION,
  SQLITE_SESSION_CATALOG_FINGERPRINT_STRATEGY,
} from '../core/sessionAdminPort.js'

function setSessionWorkspace({ userId, sessionId, workspacePath }) {
  if (!getSession({ userId, sessionId })) return null
  let canonicalWorkspacePath = null
  if (workspacePath !== null) {
    const resolved = resolveTurnProjectDirectory({ userId, workspacePath })
    canonicalWorkspacePath = String(resolved?.workspacePath || '').trim()
    if (!canonicalWorkspacePath) {
      throw Object.assign(new Error('workspace path could not be resolved'), {
        code: 'INVALID_SESSION_MUTATION',
        statusCode: 400,
        retryable: false,
      })
    }
  }
  return persistSessionWorkspace({
    userId,
    sessionId,
    workspacePath: canonicalWorkspacePath,
  })
}

export const SQLITE_SESSION_ADMIN_PORT = prepareSessionAdminPort({
  contractVersion: SESSION_ADMIN_PORT_CONTRACT_VERSION,
  catalogSource: {
    backendType: 'sqlite',
    fingerprintStrategy: SQLITE_SESSION_CATALOG_FINGERPRINT_STRATEGY,
  },
  searchMessages,
  listSessions,
  getSessionSnapshot,
  getSessionBranches,
  forkSession,
  replaceSessionMessages,
  deleteSession,
  archiveSession,
  unarchiveSession,
  pinSession,
  unpinSession,
  importLegacySessions,
  setSessionWorkspace,
})
