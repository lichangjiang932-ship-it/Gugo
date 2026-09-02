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
  fileSystem: ['WORKSPACE_FS_ENABLED'],
  shell: ['WORKSPACE_SHELL_ENABLED'],
  git: ['WORKSPACE_GIT_ENABLED', 'WORKSPACE_GIT_MUTATION_ENABLED'],
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

function isFilesystemRoot(rootPath) {
  const resolved = path.resolve(rootPath)
  return samePath(resolved, path.parse(resolved).root)
}

function selectDefaultWorkspacePath({ userId, onboarding, preferredRoot }) {
  const trustedDirectories = onboarding.writableDirectories.filter((entry) => (
    getWorkspaceTrustStatus({ userId, rootPath: entry.path }).trusted
  ))
  return trustedDirectories.find((entry) => samePath(entry.path, preferredRoot))?.path
    || trustedDirectories[0]?.path
    || ''
}

function normalizeFeatures(features) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    throw serviceError('features must be an object', 400, 'INVALID_WORKSPACE_FEATURES')
  }
  return Object.fromEntries(Object.entries(FEATURE_KEYS).flatMap(([name, envKeys]) => {
    if (typeof features[name] !== 'boolean') {
      throw serviceError(`${name} must be a boolean`, 400, 'INVALID_WORKSPACE_FEATURES')
    }
    return envKeys.map((envKey) => [envKey, features[name]])
  }))
}

function featureRuntimeState(runtime, envKeys) {
  const states = envKeys.map((envKey) => runtime.features[envKey]).filter(Boolean)
  const locked = states.some((state) => state.locked)
  const sources = [...new Set(states.filter((state) => state.locked).map((state) => state.source))]
  return {
    enabled: states.length === envKeys.length && states.every((state) => state.enabled),
    locked,
    source: locked ? sources.join('+') : (states[0]?.source || 'default'),
  }
}

export function getWorkspaceOnboardingStatus({
  userId,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (!userId) throw serviceError('userId is required', 400, 'USER_REQUIRED')
  const localFiles = getLocalFileAccessStatus({ userId })
  const runtime = getWorkspaceRuntimeConfiguration({ cwd, env })
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
    features: Object.fromEntries(Object.entries(FEATURE_KEYS).map(([name, envKeys]) => (
      [name, featureRuntimeState(runtime, envKeys)]
    ))),
    writableDirectories: writableDirectories.map((grant) => ({ id: grant.id, path: grant.path })),
  }
}

export function ensureDefaultLocalWorkspace({
  userId,
  cwd = process.cwd(),
  env = process.env,
  authorizeLocalOwner,
} = {}) {
  if (typeof authorizeLocalOwner !== 'function' || authorizeLocalOwner(userId, env) !== true) {
    throw serviceError(
      'default workspace setup is restricted to the local owner',
      403,
      'LOCAL_OWNER_ONLY',
    )
  }
  const rootPath = canonicalizeWorkspaceRoot(
    path.resolve(String(env.WORKSPACE_ROOT || '').trim() || cwd),
  )
  const onboarding = getWorkspaceOnboardingStatus({ userId, cwd, env })
  if (onboarding.completedAt) {
    return {
      ...getLocalFileAccessStatus({ userId }),
      onboarding,
      defaultWorkspacePath: selectDefaultWorkspacePath({
        userId,
        onboarding,
        preferredRoot: rootPath,
      }),
    }
  }
  if (isFilesystemRoot(rootPath)) {
    throw serviceError(
      'default workspace cannot be a filesystem root',
      403,
      'DEFAULT_WORKSPACE_ROOT_FORBIDDEN',
    )
  }

  const features = Object.fromEntries(Object.keys(onboarding.features).map((name) => [name, true]))
  const configured = configureWorkspaceOnboarding({
    userId,
    rootPath,
    features,
    approvalMode: onboarding.complete ? onboarding.approvalMode : 'normal',
    confirmation: 'ENABLE_WORKSPACE_CAPABILITIES',
    ...(onboarding.approvalMode === 'bypass'
      ? { bypassConfirmation: 'BYPASS_ALL_APPROVALS' }
      : {}),
    preserveDeploymentLocks: true,
    cwd,
    env,
  })
  return { ...configured, defaultWorkspacePath: rootPath }
}

export function configureWorkspaceOnboarding({
  userId,
  rootPath,
  features,
  approvalMode = 'normal',
  confirmation,
  bypassConfirmation,
  preserveDeploymentLocks = false,
  cwd = process.cwd(),
  env = process.env,
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

  const runtimeBefore = getWorkspaceRuntimeConfiguration({ cwd, env })
  const requestedFeatures = normalizeFeatures(features)
  const envFeatures = Object.fromEntries(Object.entries(requestedFeatures).map(([envKey, enabled]) => {
    const state = runtimeBefore.features[envKey]
    return [envKey, preserveDeploymentLocks && state.locked ? state.enabled : enabled]
  }))
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
    updateWorkspaceRuntimeConfiguration({ features: envFeatures, cwd, env })
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
    onboarding: getWorkspaceOnboardingStatus({ userId, cwd, env }),
  }
}
