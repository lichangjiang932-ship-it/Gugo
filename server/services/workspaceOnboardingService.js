import path from 'node:path'
import {
  getWorkspaceRuntimeConfiguration,
  updateWorkspaceRuntimeConfiguration,
} from '../utils/runtimeEnv.js'
import { PERMISSION_MODES } from '../utils/approvalPolicy.js'
import { getApprovalSettings, setApprovalMode } from './approvalSettingsStore.js'
import {
  getLocalFileAccessStatus,
  grantLocalPath,
  revokeLocalPath,
} from './localFileAccessService.js'
import {
  canonicalizeWorkspaceRoot,
  getWorkspaceTrustStatus,
  setWorkspaceTrust,
} from './workspaceTrustService.js'

const FEATURE_KEYS = Object.freeze({
  fileSystem: 'WORKSPACE_FS_ENABLED',
  shell: 'WORKSPACE_SHELL_ENABLED',
  git: 'WORKSPACE_GIT_ENABLED',
})

function serviceError(message, statusCode = 400, code = 'WORKSPACE_ONBOARDING_ERROR', extra = {}) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  Object.assign(error, extra)
  return error
}

function samePath(left, right) {
  const a = path.normalize(String(left || ''))
  const b = path.normalize(String(right || ''))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function normalizeFeatures(features) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    throw serviceError('features must be an object', 400, 'INVALID_WORKSPACE_FEATURES')
  }
  return Object.fromEntries(Object.entries(FEATURE_KEYS).map(([name, envKey]) => {
    if (typeof features[name] !== 'boolean') {
      throw serviceError(`${name} must be a boolean`, 400, 'INVALID_WORKSPACE_FEATURES')
    }
    return [envKey, features[name]]
  }))
}

export function getWorkspaceOnboardingStatus({ userId } = {}) {
  if (!userId) throw serviceError('userId is required', 400, 'USER_REQUIRED')
  const localFiles = getLocalFileAccessStatus({ userId })
  const runtime = getWorkspaceRuntimeConfiguration()
  const approval = getApprovalSettings({ userId })
  const writableDirectories = localFiles.grants.filter((grant) => (
    grant.resourceType === 'directory'
    && grant.accessMode === 'read_write'
    && grant.available !== false
  ))
  return {
    complete: Boolean(runtime.completedAt && writableDirectories.length > 0),
    completedAt: runtime.completedAt,
    approvalMode: approval.mode,
    modes: approval.modes,
    features: Object.fromEntries(Object.entries(FEATURE_KEYS).map(([name, envKey]) => (
      [name, runtime.features[envKey]]
    ))),
    writableDirectories: writableDirectories.map((grant) => ({ id: grant.id, path: grant.path })),
  }
}

export function configureWorkspaceOnboarding({
  userId,
  rootPath,
  features,
  approvalMode = 'normal',
  confirmation,
  bypassConfirmation,
} = {}) {
  if (!userId) throw serviceError('userId is required', 400, 'USER_REQUIRED')
  if (confirmation !== 'ENABLE_WORKSPACE_CAPABILITIES') {
    throw serviceError('explicit risk confirmation is required', 400, 'CONFIRMATION_REQUIRED')
  }
  if (!PERMISSION_MODES.includes(approvalMode)) {
    throw serviceError(`invalid approval mode: ${approvalMode}`, 400, 'INVALID_APPROVAL_MODE')
  }
  if (approvalMode === 'bypass' && bypassConfirmation !== 'BYPASS_ALL_APPROVALS') {
    throw serviceError('bypass mode requires separate confirmation', 400, 'BYPASS_CONFIRMATION_REQUIRED')
  }

  const envFeatures = normalizeFeatures(features)
  const runtimeBefore = getWorkspaceRuntimeConfiguration()
  const locks = Object.entries(envFeatures).flatMap(([envKey, enabled]) => {
    const state = runtimeBefore.features[envKey]
    return state.locked && state.enabled !== enabled
      ? [{ key: envKey, source: state.source, current: state.enabled }]
      : []
  })
  if (locks.length) {
    throw serviceError(
      `deployment policy locks: ${locks.map((item) => item.key).join(', ')}`,
      409,
      'RUNTIME_CONFIG_LOCKED',
      { locks },
    )
  }

  const canonicalRoot = canonicalizeWorkspaceRoot(rootPath)
  const before = getLocalFileAccessStatus({ userId })
  const previousGrant = before.grants.find((grant) => samePath(grant.path, canonicalRoot)) || null
  const previousTrust = getWorkspaceTrustStatus({ userId, rootPath: canonicalRoot }).trusted
  const previousMode = getApprovalSettings({ userId }).mode
  let grant = null

  try {
    grant = grantLocalPath({ userId, rootPath: canonicalRoot, accessMode: 'read_write' })
    setWorkspaceTrust({
      userId,
      rootPath: canonicalRoot,
      trusted: true,
      confirmation: 'TRUST_WORKSPACE_CONFIG',
    })
    setApprovalMode({ userId, mode: approvalMode })
    updateWorkspaceRuntimeConfiguration({ features: envFeatures })
  } catch (error) {
    try { setApprovalMode({ userId, mode: previousMode }) } catch { /* best effort */ }
    if (!previousTrust) {
      try { setWorkspaceTrust({ userId, rootPath: canonicalRoot, trusted: false }) } catch { /* best effort */ }
    }
    if (grant && !previousGrant) {
      try { revokeLocalPath({ userId, id: grant.id }) } catch { /* best effort */ }
    } else if (previousGrant && previousGrant.accessMode !== 'read_write') {
      try {
        grantLocalPath({ userId, rootPath: canonicalRoot, accessMode: previousGrant.accessMode })
      } catch { /* best effort */ }
    }
    throw error
  }

  return {
    ...getLocalFileAccessStatus({ userId }),
    onboarding: getWorkspaceOnboardingStatus({ userId }),
  }
}
