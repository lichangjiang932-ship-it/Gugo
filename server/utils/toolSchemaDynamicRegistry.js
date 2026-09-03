import { randomUUID } from 'node:crypto'

import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from '../plugins/runtimePluginContributionLifecycle.js'
import { normalizeToolRiskMetadata } from './toolRiskMetadata.js'

// 动态注册的工具表：name → { origin, source, spec, exec? }
// origin: 'mcp' | 'skill' | 'subagent'
const globalDynamicTools = new Map()
const userDynamicTools = new Map()
const DYNAMIC_REGISTRATION_STATE = Symbol('gugo.dynamicToolRegistrationState')
const dynamicToolSpecRegistrationIds = new WeakMap()

function newDynamicRegistrationId() {
  return `dynamic-tool:${randomUUID()}`
}

function bindToolSpecRegistration(spec, registrationId) {
  if (spec && typeof spec === 'object' && registrationId) {
    dynamicToolSpecRegistrationIds.set(spec, registrationId)
  }
  return spec
}

/** Preserve host-only registration identity when a schema is cloned. */
export function inheritDynamicToolSpecRegistration(target, source) {
  return bindToolSpecRegistration(target, dynamicToolSpecRegistrationIds.get(source) || null)
}

export function getDynamicToolSpecRegistrationId(spec) {
  return spec && typeof spec === 'object'
    ? dynamicToolSpecRegistrationIds.get(spec) || null
    : null
}

export function snapshotDynamicToolSpecRegistrations(specs = []) {
  const snapshot = Object.create(null)
  for (const spec of Array.isArray(specs) ? specs : []) {
    const name = String(spec?.function?.name || '').trim()
    const registrationId = getDynamicToolSpecRegistrationId(spec)
    if (name && registrationId) snapshot[name] = registrationId
  }
  return snapshot
}

/** Remove dynamic schemas revoked or replaced after an active loop started. */
export function filterCurrentDynamicToolSpecs(specs = [], { userId = null } = {}) {
  return (Array.isArray(specs) ? specs : []).filter((spec) => {
    const registrationId = getDynamicToolSpecRegistrationId(spec)
    if (!registrationId) return true
    const name = String(spec?.function?.name || '').trim()
    return Boolean(name) && matchesDynamicToolRegistration(name, registrationId, { userId })
  })
}

function registrationState(registration) {
  return registration?.[DYNAMIC_REGISTRATION_STATE] || null
}

function nearestActiveRegistration(registration) {
  let current = registration
  while (current) {
    const state = registrationState(current)
    if (!state || state.active) return current
    current = state.previous
  }
  return null
}

function deactivateRegistration(registration) {
  const state = registrationState(registration)
  if (state) state.active = false
}

function normalizeUserScope(userId) {
  const normalized = String(userId || '').trim()
  return normalized || null
}

function getDynamicToolMap(userId, { create = false } = {}) {
  const scope = normalizeUserScope(userId)
  if (!scope) return globalDynamicTools
  let scoped = userDynamicTools.get(scope)
  if (!scoped && create) {
    scoped = new Map()
    userDynamicTools.set(scope, scoped)
  }
  return scoped || null
}

export function registerDynamicTool({
  name,
  origin,
  source = null,
  spec,
  exec = null,
  metadata = null,
  userId = null,
}) {
  if (!name || !spec) throw new Error('registerDynamicTool 缺少 name/spec')
  const map = getDynamicToolMap(userId, { create: true })
  const previous = map.get(name)
  const registrationId = newDynamicRegistrationId()
  // Every registration receives its own outer identity. This lets unloading a
  // shadow registration restore the exact previous registration.
  const registeredSpec = bindToolSpecRegistration({
    ...spec,
    ...(spec?.function && typeof spec.function === 'object'
      ? { function: { ...spec.function } }
      : {}),
  }, registrationId)
  const registration = {
    registrationId,
    origin,
    source,
    spec: registeredSpec,
    exec,
    metadata: normalizeToolRiskMetadata(metadata, { origin }),
  }
  Object.defineProperty(registration, DYNAMIC_REGISTRATION_STATE, {
    value: { active: true, previous },
  })
  map.set(name, registration)

  let disposed = false
  const dispose = () => {
    if (disposed) return false
    disposed = true
    deactivateRegistration(registration)
    if (map.get(name) !== registration) return false
    const restore = nearestActiveRegistration(previous)
    if (restore) map.set(name, restore)
    else map.delete(name)
    const scope = normalizeUserScope(userId)
    if (scope && map.size === 0) userDynamicTools.delete(scope)
    return true
  }
  return attachRuntimePluginBeginRevoke(dispose, () => {
    dispose()
    return createRuntimePluginRevokeReceipt('revoked')
  })
}

export function unregisterDynamicTool(name, { userId = null } = {}) {
  const map = getDynamicToolMap(userId)
  if (!map) return false
  deactivateRegistration(map.get(name))
  const removed = map.delete(name)
  const scope = normalizeUserScope(userId)
  if (scope && map.size === 0) userDynamicTools.delete(scope)
  return removed
}

export function unregisterByOrigin(origin, sourceMatch = null, { userId = null } = {}) {
  const map = getDynamicToolMap(userId)
  if (!map) return 0
  const toRemove = []
  for (const [name, info] of map) {
    if (info.origin !== origin) continue
    if (sourceMatch && info.source !== sourceMatch) continue
    toRemove.push(name)
  }
  toRemove.forEach((name) => {
    deactivateRegistration(map.get(name))
    map.delete(name)
  })
  const scope = normalizeUserScope(userId)
  if (scope && map.size === 0) userDynamicTools.delete(scope)
  return toRemove.length
}

export function unregisterUserDynamicTools(userId) {
  const scope = normalizeUserScope(userId)
  if (!scope) return 0
  const map = userDynamicTools.get(scope)
  if (!map) return 0
  const removed = map.size
  userDynamicTools.delete(scope)
  return removed
}

export function getDynamicTool(name, { userId = null } = {}) {
  const scoped = getDynamicToolMap(userId)
  return scoped?.get(name) || globalDynamicTools.get(name) || null
}

export function getDynamicToolRegistrationId(name, { userId = null } = {}) {
  return getDynamicTool(name, { userId })?.registrationId || null
}

export function matchesDynamicToolRegistration(name, expectedRegistrationId, { userId = null } = {}) {
  const expected = String(expectedRegistrationId || '').trim()
  if (!expected) return false
  return getDynamicToolRegistrationId(name, { userId }) === expected
}

/** Merge global tools with user-scoped shadows without exposing mutable maps. */
export function listVisibleDynamicTools({ userId = null } = {}) {
  const visible = new Map(globalDynamicTools)
  const scoped = getDynamicToolMap(userId)
  if (scoped && scoped !== globalDynamicTools) {
    for (const [name, info] of scoped) visible.set(name, info)
  }
  return visible
}
