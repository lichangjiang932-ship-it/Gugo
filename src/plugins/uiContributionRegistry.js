import { Component as ReactComponent, Fragment, createElement, useSyncExternalStore } from 'react'

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

function boundedIdentifier(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(text)) throw new TypeError(`${label} is invalid`)
  return text
}

function normalizeContribution(pluginId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('UI contribution must be an object')
  const slot = String(input.slot || '').trim()
  if (!supportedSlots.has(slot)) throw new TypeError(`Unsupported UI contribution slot: ${slot || '(empty)'}`)
  const id = boundedIdentifier(input.id, 'UI contribution id')
  const key = `${pluginId}:${id}`
  const order = Number.isFinite(Number(input.order)) ? Number(input.order) : 0
  const normalized = { ...input, pluginId, id, key, slot, order }

  if (slot === 'route') {
    const path = String(input.path || '').trim()
    if (!/^\/[a-z0-9/_-]*$/i.test(path) || path.includes('//')) throw new TypeError('Route contribution path is invalid')
    if (RESERVED_ROUTE_PATHS.has(path)) throw new TypeError(`Route contribution cannot replace host route: ${path}`)
    if (!input.component) throw new TypeError('Route contribution requires a component')
    normalized.path = path
    normalized.requiresAuth = input.requiresAuth !== false
  } else if (slot === 'account-menu') {
    if (!input.component && !String(input.path || '').startsWith('/')) throw new TypeError('Account menu contribution requires a component or absolute app path')
    if (!input.component && !input.labelKey && !input.label) throw new TypeError('Account menu contribution requires a label')
    normalized.requiresLogin = input.requiresLogin !== false
  } else if (slot === 'settings-section') {
    normalized.sectionId = boundedIdentifier(input.sectionId || input.id, 'Settings section id')
    if (RESERVED_SETTINGS_SECTIONS.has(normalized.sectionId)) throw new TypeError(`Settings contribution cannot replace host section: ${normalized.sectionId}`)
    if (!input.component || (!input.labelKey && !input.label)) throw new TypeError('Settings section contribution requires a component and label')
  } else if (slot === 'tool-view') {
    if (!input.component) throw new TypeError('Tool view contribution requires a component')
    if (!Array.isArray(input.toolNames) || input.toolNames.length === 0 || input.toolNames.length > 64) {
      throw new TypeError('Tool view contribution requires between 1 and 64 tool names')
    }
    normalized.toolNames = Object.freeze(input.toolNames.map((name) => boundedIdentifier(name, 'Tool name')))
  } else if (slot === 'workbench-tab') {
    normalized.tabId = boundedIdentifier(input.tabId || input.id, 'Workbench tab id')
    if (RESERVED_WORKBENCH_TABS.has(normalized.tabId)) throw new TypeError(`Workbench contribution cannot replace host tab: ${normalized.tabId}`)
    if (!input.component || (!input.labelKey && !input.label)) throw new TypeError('Workbench tab contribution requires a component and label')
  } else if (!input.component) {
    throw new TypeError(`${slot} contribution requires a component`)
  }
  return Object.freeze(normalized)
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
  for (const listener of listeners) listener()
}

export function registerUiContributions(pluginIdValue, inputs) {
  const pluginId = boundedIdentifier(pluginIdValue, 'UI plugin id')
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 100) {
    throw new TypeError('UI contributions must contain between 1 and 100 entries')
  }
  const normalized = inputs.map((input) => normalizeContribution(pluginId, input))
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

export function unregisterUiPlugin(pluginIdValue) {
  const pluginId = boundedIdentifier(pluginIdValue, 'UI plugin id')
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
  const slot = String(slotValue || '').trim()
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
