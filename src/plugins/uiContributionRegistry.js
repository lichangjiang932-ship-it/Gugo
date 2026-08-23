import { Component as ReactComponent, Fragment, createElement, useSyncExternalStore } from 'react'
import {
  assertPluginCompatibility,
  PLUGIN_API_VERSION,
  PLUGIN_HOST_VERSION,
} from '../../shared/pluginCompatibility.js'
import { normalizePluginManifest } from '../../shared/pluginManifest.js'
import { notifyUiContributionListeners } from './uiContributionNotifications.js'

export const UI_CONTRIBUTION_SLOTS = Object.freeze([
  'route',
  'account-menu',
  'settings-section',
  'tool-view',
  'workbench-tab',
  'conversation-node',
])

const supportedSlots = new Set(UI_CONTRIBUTION_SLOTS)
const RESERVED_ROUTE_PATHS = new Set([
  '/', '/chat', '/skills', '/permissions', '/approvals', '/task', '/tasks', '/history',
  '/settings', '/memory', '/desk', '/agents', '/channels', '/access', '/login',
])
const RESERVED_SETTINGS_SECTIONS = new Set([
  'general', 'models', 'appearance', 'language', 'plugins', 'web-search', 'permissions',
  'agent-presets', 'integrations', 'data', 'about', 'features', 'files', 'pet', 'diagnostics',
])
const RESERVED_WORKBENCH_TABS = new Set(['files', 'chat', 'browser', 'terminal'])
const contributionsBySlot = new Map(UI_CONTRIBUTION_SLOTS.map((slot) => [slot, new Map()]))
const snapshots = new Map(UI_CONTRIBUTION_SLOTS.map((slot) => [slot, Object.freeze([])]))
const listeners = new Set()
const uiPlugins = new Map()

function boundedIdentifier(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(text)) throw new TypeError(`${label} is invalid`)
  return text
}

function uiDefinitionError(label) {
  const error = new TypeError(`${label} must use own data properties`)
  error.code = 'UI_CONTRIBUTION_DEFINITION_INVALID'
  error.retryable = false
  return error
}

function ownArrayValues(value, label, { min = 0, max, rangeMessage = null }) {
  if (!Array.isArray(value)) {
    if (rangeMessage) throw new TypeError(rangeMessage)
    throw uiDefinitionError(label)
  }
  let lengthDescriptor
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  } catch {
    throw uiDefinitionError(`${label}.length`)
  }
  const length = lengthDescriptor?.value
  if (!Number.isSafeInteger(length) || length < min || length > max) {
    if (rangeMessage) throw new TypeError(rangeMessage)
    throw uiDefinitionError(label)
  }
  const values = []
  for (let index = 0; index < length; index += 1) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    } catch {
      throw uiDefinitionError(`${label}[${index}]`)
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw uiDefinitionError(`${label}[${index}]`)
    }
    values.push(descriptor.value)
  }
  return values
}

function snapshotContributionDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw uiDefinitionError('UI contribution')
  }
  let keys
  try {
    keys = Reflect.ownKeys(input)
  } catch {
    throw uiDefinitionError('UI contribution')
  }
  if (keys.length > 64 || keys.some((key) => typeof key !== 'string')) {
    throw uiDefinitionError('UI contribution')
  }
  const snapshot = {}
  for (const key of keys) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key)
    } catch {
      throw uiDefinitionError(`UI contribution.${key}`)
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw uiDefinitionError(`UI contribution.${key}`)
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return Object.freeze(snapshot)
}

function normalizeContribution(pluginId, input) {
  const definition = snapshotContributionDefinition(input)
  const slot = typeof definition.slot === 'string' ? definition.slot.trim() : ''
  if (!supportedSlots.has(slot)) throw new TypeError(`Unsupported UI contribution slot: ${slot || '(empty)'}`)
  const id = boundedIdentifier(definition.id, 'UI contribution id')
  const key = `${pluginId}:${id}`
  const order = Number.isFinite(definition.order) ? definition.order : 0
  const normalized = { ...definition, pluginId, id, key, slot, order }

  if (slot === 'route') {
    const path = typeof definition.path === 'string' ? definition.path.trim() : ''
    if (!/^\/[a-z0-9/_-]*$/i.test(path) || path.includes('//')) throw new TypeError('Route contribution path is invalid')
    if (RESERVED_ROUTE_PATHS.has(path)) throw new TypeError(`Route contribution cannot replace host route: ${path}`)
    if (!definition.component) throw new TypeError('Route contribution requires a component')
    normalized.path = path
    normalized.requiresAuth = definition.requiresAuth !== false
  } else if (slot === 'account-menu') {
    const path = typeof definition.path === 'string' ? definition.path : ''
    if (!definition.component && !path.startsWith('/')) throw new TypeError('Account menu contribution requires a component or absolute app path')
    if (!definition.component && !definition.labelKey && !definition.label) throw new TypeError('Account menu contribution requires a label')
    normalized.path = path
    normalized.requiresLogin = definition.requiresLogin !== false
  } else if (slot === 'settings-section') {
    normalized.sectionId = boundedIdentifier(definition.sectionId || definition.id, 'Settings section id')
    if (RESERVED_SETTINGS_SECTIONS.has(normalized.sectionId)) throw new TypeError(`Settings contribution cannot replace host section: ${normalized.sectionId}`)
    if (!definition.component || (!definition.labelKey && !definition.label)) throw new TypeError('Settings section contribution requires a component and label')
  } else if (slot === 'tool-view') {
    if (!definition.component) throw new TypeError('Tool view contribution requires a component')
    const toolNames = ownArrayValues(definition.toolNames, 'UI contribution.toolNames', {
      min: 1,
      max: 64,
      rangeMessage: 'Tool view contribution requires between 1 and 64 tool names',
    })
    normalized.toolNames = Object.freeze(toolNames.map((name) => boundedIdentifier(name, 'Tool name')))
  } else if (slot === 'workbench-tab') {
    normalized.tabId = boundedIdentifier(definition.tabId || definition.id, 'Workbench tab id')
    if (RESERVED_WORKBENCH_TABS.has(normalized.tabId)) throw new TypeError(`Workbench contribution cannot replace host tab: ${normalized.tabId}`)
    if (!definition.component || (!definition.labelKey && !definition.label)) throw new TypeError('Workbench tab contribution requires a component and label')
  } else if (!definition.component) {
    throw new TypeError(`${slot} contribution requires a component`)
  }
  return Object.freeze(normalized)
}

function normalizeContributionInputs(pluginId, inputs) {
  return ownArrayValues(inputs, 'UI contributions', {
    min: 1,
    max: 100,
    rangeMessage: 'UI contributions must contain between 1 and 100 entries',
  })
    .map((input) => normalizeContribution(pluginId, input))
}

function contributionIdentity(contribution) {
  if (contribution.slot === 'route') return contribution.path
  if (contribution.slot === 'settings-section') return contribution.sectionId
  if (contribution.slot === 'workbench-tab') return contribution.tabId
  return null
}

function refreshSnapshots(changedSlots) {
  for (const slot of changedSlots) {
    const values = [...contributionsBySlot.get(slot).values()]
      .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    snapshots.set(slot, Object.freeze(values))
  }
  notifyUiContributionListeners(listeners)
}

function installUiContributions(normalized) {
  const pendingKeys = new Set()
  const pendingIdentities = new Set()
  for (const contribution of normalized) {
    const alreadyRegistered = [...contributionsBySlot.values()].some((entries) => entries.has(contribution.key))
    if (pendingKeys.has(contribution.key) || alreadyRegistered) {
      throw new Error(`Duplicate UI contribution: ${contribution.key}`)
    }
    const identity = contributionIdentity(contribution)
    const identityKey = identity ? `${contribution.slot}:${identity}` : null
    const identityTaken = identity && [...contributionsBySlot.get(contribution.slot).values()]
      .some((entry) => contributionIdentity(entry) === identity)
    if (identityKey && (pendingIdentities.has(identityKey) || identityTaken)) {
      throw new Error(`UI contribution target is already registered: ${identityKey}`)
    }
    pendingKeys.add(contribution.key)
    if (identityKey) pendingIdentities.add(identityKey)
  }

  for (const contribution of normalized) contributionsBySlot.get(contribution.slot).set(contribution.key, contribution)
  refreshSnapshots(new Set(normalized.map((contribution) => contribution.slot)))
  let disposed = false
  return () => {
    if (disposed) return false
    disposed = true
    const changedSlots = new Set()
    for (const contribution of normalized) {
      if (contributionsBySlot.get(contribution.slot).delete(contribution.key)) changedSlots.add(contribution.slot)
    }
    if (changedSlots.size) refreshSnapshots(changedSlots)
    return changedSlots.size > 0
  }
}

export function registerUiContributions(pluginIdValue, inputs) {
  const pluginId = boundedIdentifier(pluginIdValue, 'UI plugin id')
  if (uiPlugins.has(pluginId)) {
    throw new Error(`UI plugin contributions are lifecycle-managed: ${pluginId}`)
  }
  return installUiContributions(normalizeContributionInputs(pluginId, inputs))
}

function uiPluginSnapshot(record) {
  if (!record) return null
  return Object.freeze({
    ...record.manifest,
    requires: Object.freeze([...record.manifest.requires]),
    contributes: Object.freeze([...record.manifest.contributes]),
    state: record.state,
    installedAt: record.installedAt,
  })
}

export function registerTrustedUiPlugin(manifest, inputs) {
  const normalizedManifest = normalizePluginManifest(manifest)
  if (uiPlugins.has(normalizedManifest.id)) {
    throw new Error(`UI plugin already registered: ${normalizedManifest.id}`)
  }
  assertPluginCompatibility(normalizedManifest, {
    hostVersion: PLUGIN_HOST_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    resolveDependencyVersion: (id) => {
      const dependency = uiPlugins.get(id)
      return dependency?.state === 'active' ? dependency.manifest.version : null
    },
  })
  const normalizedContributions = normalizeContributionInputs(normalizedManifest.id, inputs)
  const actualDeclarations = normalizedContributions.map((contribution) => (
    `ui:${contribution.slot}:${contribution.id}`
  ))
  const declared = new Set(normalizedManifest.contributes)
  const declaredUi = normalizedManifest.contributes.filter((entry) => entry.startsWith('ui:'))
  if (declaredUi.length !== actualDeclarations.length
    || actualDeclarations.some((entry) => !declared.has(entry))) {
    throw new TypeError('UI plugin manifest contributions must exactly match registered UI contributions')
  }

  const disposeContributions = installUiContributions(normalizedContributions)
  const record = {
    manifest: normalizedManifest,
    state: 'active',
    installedAt: new Date().toISOString(),
    disposeContributions,
  }
  uiPlugins.set(normalizedManifest.id, record)
  let disposed = false
  return () => {
    if (disposed) return false
    const removed = unregisterUiPlugin(normalizedManifest.id)
    if (removed) disposed = true
    return removed
  }
}

export function listUiPlugins() {
  return Object.freeze([...uiPlugins.values()]
    .map(uiPluginSnapshot)
    .sort((left, right) => left.id.localeCompare(right.id)))
}

export function getUiPlugin(pluginIdValue) {
  const pluginId = typeof pluginIdValue === 'string' ? pluginIdValue.trim() : ''
  return uiPluginSnapshot(uiPlugins.get(pluginId))
}

export function unregisterUiPlugin(pluginIdValue) {
  const pluginId = boundedIdentifier(pluginIdValue, 'UI plugin id')
  const record = uiPlugins.get(pluginId)
  if (record) {
    const dependents = [...uiPlugins.values()]
      .filter((candidate) => candidate !== record && candidate.manifest.requires.includes(pluginId))
      .map((candidate) => candidate.manifest.id)
    if (dependents.length > 0) {
      throw new Error(`UI plugin is required by active plugins: ${dependents.join(', ')}`)
    }
    uiPlugins.delete(pluginId)
    return record.disposeContributions()
  }

  const changedSlots = new Set()
  for (const [slot, entries] of contributionsBySlot) {
    for (const [key, contribution] of entries) {
      if (contribution.pluginId === pluginId) {
        entries.delete(key)
        changedSlots.add(slot)
      }
    }
  }
  if (changedSlots.size) refreshSnapshots(changedSlots)
  return changedSlots.size > 0
}

export function listUiContributions(slotValue) {
  const slot = typeof slotValue === 'string' ? slotValue.trim() : ''
  if (!supportedSlots.has(slot)) return Object.freeze([])
  return snapshots.get(slot)
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUiContributions(slot) {
  return useSyncExternalStore(subscribe, () => listUiContributions(slot), () => listUiContributions(slot))
}

class UiContributionErrorBoundary extends ReactComponent {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    try {
      this.props.onError?.({ contribution: this.props.contribution, error })
    } catch {
      // A diagnostics callback must not take down the contribution host.
    }
  }

  componentDidUpdate(previousProps) {
    if (this.state.failed && previousProps.contribution !== this.props.contribution) {
      this.setState({ failed: false })
    }
  }

  render() {
    if (this.state.failed) return this.props.fallback || null
    return this.props.children
  }
}

export function UiContributionRenderer({ contribution, context = {}, fallback = null, onError }) {
  if (!contribution?.component) return fallback
  return createElement(
    UiContributionErrorBoundary,
    { contribution, fallback, onError },
    createElement(contribution.component, { ...context, contribution }),
  )
}

export function UiContributionSlot({ slot, context = {}, fallback = null, onError }) {
  const contributions = useUiContributions(slot)
  return createElement(Fragment, null, ...contributions.map((contribution) => createElement(
    UiContributionRenderer,
    { contribution, context, fallback, key: contribution.key, onError },
  )))
}
