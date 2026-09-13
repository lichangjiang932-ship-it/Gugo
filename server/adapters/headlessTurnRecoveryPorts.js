import fs from 'node:fs'
import path from 'node:path'
import { grantLocalPath } from '../services/localFileAccessService.js'
import { getPersistentGrantRows } from '../services/localFileAccessGrantStore.js'
import { getUnknownSideEffectForTurn } from '../services/sideEffectRecoveryService.js'
import { resolveSideEffectTurnInteraction } from '../services/sideEffectTurnRecoveryService.js'
import { runWithTurnInteractionBoundary } from '../services/turnInteractionBoundary.js'

function canonicalDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw Object.assign(new Error('Directory authorization requires an absolute directory.'), { code: 'CLI_DIRECTORY_PATH_INVALID' })
  }
  const canonical = fs.realpathSync(directory)
  if (!fs.statSync(canonical).isDirectory()) {
    throw Object.assign(new Error('Directory authorization requires an existing directory.'), { code: 'CLI_DIRECTORY_PATH_INVALID' })
  }
  return canonical
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
}

export const HEADLESS_TURN_RECOVERY_PORTS = Object.freeze({
  canonicalizeDirectory: ({ path: directory }) => canonicalDirectory(directory),
  grantDirectory({ userId, sessionId, turnId, boundary, path: directory, accessMode }) {
    return runWithTurnInteractionBoundary({ userId, sessionId, turnId, boundary }, ({ payload }) => {
      const requestedMode = payload.clarification.access_mode || payload.clarification.accessMode || 'read_only'
      const canonical = canonicalDirectory(directory)
      if (accessMode !== requestedMode || !samePath(canonical, directory)) {
        throw Object.assign(new Error('Confirm the exact canonical path and pending access mode before granting it.'), {
          code: 'CLI_DIRECTORY_CONFIRMATION_MISMATCH',
        })
      }
      const prior = getPersistentGrantRows(userId).find((row) => (
        row.resource_type === 'directory' && samePath(row.root_path, canonical)
      ))
      const grant = grantLocalPath({ userId, rootPath: canonical, accessMode, scope: 'session' })
      const preexistingPermission = grant.scope === 'persistent' && prior?.id === grant.id
        ? Object.freeze({ id: prior.id, path: prior.root_path, scope: 'persistent', accessMode: prior.access_mode })
        : null
      return { ...grant, ...(preexistingPermission ? { preexistingPermission } : {}) }
    })
  },
  readUnknownSideEffect: (scope) => getUnknownSideEffectForTurn(scope),
  resolveUnknownSideEffect: (input) => resolveSideEffectTurnInteraction(input),
})
