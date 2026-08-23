import {
  archiveSession,
  deleteSession,
  forkSession,
  getSessionBranches,
  getSessionSnapshot,
  listSessions,
  pinSession,
  replaceSessionMessages,
  unarchiveSession,
  unpinSession,
} from './sessionStore.js'
import { searchMessages } from './sessionSearchService.js'
import {
  prepareSessionAdminPort,
  SESSION_ADMIN_PORT_CONTRACT_VERSION,
} from '../core/sessionAdminPort.js'

export const SQLITE_SESSION_ADMIN_PORT = prepareSessionAdminPort({
  contractVersion: SESSION_ADMIN_PORT_CONTRACT_VERSION,
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
})
