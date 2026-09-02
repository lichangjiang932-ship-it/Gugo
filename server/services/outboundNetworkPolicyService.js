import {
  getOutboundNetworkPolicyConfiguration,
  updateOutboundNetworkPolicyConfiguration,
} from '../utils/runtimeEnv.js'

export const PURE_LOCAL_BLOCKED_ERROR_CODE = 'OUTBOUND_PURE_LOCAL_DENIED'

function policyError(message, code = 'OUTBOUND_NETWORK_POLICY_ERROR', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, retryable: false })
}

function requireUser(userId) {
  if (!String(userId || '').trim()) {
    throw policyError('userId is required', 'USER_REQUIRED')
  }
}

function publicPolicy(configuration) {
  const pureLocal = configuration.pureLocal
  return Object.freeze({
    mode: pureLocal.enabled ? 'pure-local' : 'standard',
    pureLocal: pureLocal.enabled,
    locked: pureLocal.locked,
    source: pureLocal.source,
    blockedErrorCode: PURE_LOCAL_BLOCKED_ERROR_CODE,
  })
}

export function getOutboundNetworkPolicy({
  userId,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  requireUser(userId)
  return publicPolicy(getOutboundNetworkPolicyConfiguration({ cwd, env }))
}

export function updateOutboundNetworkPolicy({
  userId,
  pureLocal,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  requireUser(userId)
  return publicPolicy(updateOutboundNetworkPolicyConfiguration({
    pureLocal,
    cwd,
    env,
  }))
}
