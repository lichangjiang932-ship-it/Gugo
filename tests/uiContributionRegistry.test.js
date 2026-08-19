import assert from 'node:assert/strict'
import test from 'node:test'

import '../src/plugins/firstPartyUiContributions.js'
import { resolveSettingsSectionFromSearch, settingsPathForSection } from '../src/lib/settingsNavigation.js'
import {
  UI_CONTRIBUTION_SLOTS,
  getUiPlugin,
  listUiContributions,
  listUiPlugins,
  registerTrustedUiPlugin,
  registerUiContributions,
  unregisterUiPlugin,
} from '../src/plugins/uiContributionRegistry.js'

const EmptyContribution = () => null

test('first-party pages use the shared UI route contribution seam', () => {
  const routes = listUiContributions('route').filter((entry) => entry.pluginId === 'gugo-first-party')
  assert.deepEqual(routes.map((entry) => entry.path), ['/mcp', '/reasonix'])
  assert.ok(routes.every((entry) => entry.requiresAuth === true))

  const menu = listUiContributions('account-menu').find((entry) => entry.id === 'mcp-account-menu')
  assert.equal(menu.path, '/mcp')
  assert.equal(menu.labelKey, 'nav.mcp')

  const plugin = getUiPlugin('gugo-first-party')
  assert.equal(plugin.state, 'active')
  assert.deepEqual(plugin.contributes, [
    'ui:route:mcp-route',
    'ui:route:reasonix-route',
    'ui:account-menu:mcp-account-menu',
  ])
  assert.equal(listUiPlugins().some((entry) => entry.id === 'gugo-first-party'), true)
})

test('trusted UI plugins bind shared manifests, dependencies, and disposal', () => {
  const disposeBase = registerTrustedUiPlugin({
    id: 'test-ui-base',
    name: 'Test UI base',
    version: '1.0.0',
    contributes: ['ui:conversation-node:base-node'],
  }, [
    { id: 'base-node', slot: 'conversation-node', component: EmptyContribution },
  ])
  const disposeDependent = registerTrustedUiPlugin({
    id: 'test-ui-dependent',
    name: 'Test UI dependent',
    version: '1.0.0',
    requires: ['test-ui-base'],
    contributes: ['ui:conversation-node:dependent-node'],
  }, [
    { id: 'dependent-node', slot: 'conversation-node', component: EmptyContribution },
  ])

  try {
    const snapshot = getUiPlugin('test-ui-dependent')
    assert.equal(snapshot.state, 'active')
    assert.deepEqual(snapshot.requires, ['test-ui-base'])
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.requires), true)
    assert.throws(() => disposeBase(), /required by active plugins: test-ui-dependent/)
  } finally {
    assert.equal(disposeDependent(), true)
    assert.equal(disposeDependent(), false)
    assert.equal(disposeBase(), true)
  }
  assert.equal(getUiPlugin('test-ui-base'), null)
  assert.equal(getUiPlugin('test-ui-dependent'), null)
})

test('trusted UI plugin registration fails atomically on missing dependencies or manifest drift', () => {
  const countBefore = listUiContributions('conversation-node').length
  assert.throws(
    () => registerTrustedUiPlugin({
      id: 'test-ui-missing-dependency',
      name: 'Missing dependency',
      version: '1.0.0',
      requires: ['not-installed'],
      contributes: ['ui:conversation-node:node'],
    }, [
      { id: 'node', slot: 'conversation-node', component: EmptyContribution },
    ]),
    /dependencies are not active: not-installed/,
  )
  assert.throws(
    () => registerTrustedUiPlugin({
      id: 'test-ui-manifest-drift',
      name: 'Manifest drift',
      version: '1.0.0',
      contributes: ['ui:conversation-node:different-node'],
    }, [
      { id: 'node', slot: 'conversation-node', component: EmptyContribution },
    ]),
    /must exactly match/,
  )
  assert.equal(listUiContributions('conversation-node').length, countBefore)
  assert.equal(getUiPlugin('test-ui-missing-dependency'), null)
  assert.equal(getUiPlugin('test-ui-manifest-drift'), null)
})

test('UI contributions register atomically, sort deterministically, and dispose cleanly', () => {
  const firstDispose = registerUiContributions('test.ui-one', [
    { id: 'late', slot: 'conversation-node', component: EmptyContribution, order: 20 },
    { id: 'settings', slot: 'settings-section', sectionId: 'test-settings', label: 'Test', component: EmptyContribution },
  ])
  const secondDispose = registerUiContributions('test.ui-two', [
    { id: 'early', slot: 'conversation-node', component: EmptyContribution, order: 10 },
  ])

  try {
    const nodes = listUiContributions('conversation-node').filter((entry) => entry.pluginId.startsWith('test.ui-'))
    assert.deepEqual(nodes.map((entry) => entry.id), ['early', 'late'])
    assert.ok(Object.isFrozen(nodes[0]))
    assert.equal(listUiContributions('settings-section').some((entry) => entry.sectionId === 'test-settings'), true)

    const countBefore = listUiContributions('conversation-node').length
    assert.throws(
      () => registerUiContributions('test.ui-one', [
        { id: 'late', slot: 'conversation-node', component: EmptyContribution },
        { id: 'new-entry', slot: 'conversation-node', component: EmptyContribution },
      ]),
      /Duplicate UI contribution/,
    )
    assert.equal(listUiContributions('conversation-node').length, countBefore)
  } finally {
    assert.equal(firstDispose(), true)
    assert.equal(firstDispose(), false)
    assert.equal(secondDispose(), true)
  }
  assert.equal(listUiContributions('conversation-node').some((entry) => entry.pluginId.startsWith('test.ui-')), false)
})

test('UI plugin unregistration removes every slot owned by that plugin', () => {
  registerUiContributions('test.ui-remove', [
    { id: 'node', slot: 'conversation-node', component: EmptyContribution },
    { id: 'tab', slot: 'workbench-tab', tabId: 'test-tab', label: 'Test tab', component: EmptyContribution },
  ])
  assert.equal(unregisterUiPlugin('test.ui-remove'), true)
  for (const slot of UI_CONTRIBUTION_SLOTS) {
    assert.equal(listUiContributions(slot).some((entry) => entry.pluginId === 'test.ui-remove'), false)
  }
  assert.equal(unregisterUiPlugin('test.ui-remove'), false)
})

test('contributed settings sections retain canonical deep links without weakening unknown-tab fallback', () => {
  assert.equal(resolveSettingsSectionFromSearch('?tab=reviewer', ['reviewer']), 'reviewer')
  assert.equal(settingsPathForSection('reviewer', ['reviewer']), '/settings?tab=reviewer')
  assert.equal(resolveSettingsSectionFromSearch('?tab=unknown', ['reviewer']), 'general')
})

test('UI contribution validation fails closed for unsafe routes and incomplete slots', () => {
  assert.throws(
    () => registerUiContributions('test.invalid-route', [
      { id: 'route', slot: 'route', path: 'https://example.com', component: EmptyContribution },
    ]),
    /path is invalid/,
  )
  assert.throws(
    () => registerUiContributions('test.host-route', [
      { id: 'route', slot: 'route', path: '/chat', component: EmptyContribution },
    ]),
    /cannot replace host route/,
  )
  assert.throws(
    () => registerUiContributions('test.invalid-tab', [
      { id: 'tab', slot: 'workbench-tab', label: 'Missing component' },
    ]),
    /requires a component/,
  )
  assert.throws(
    () => registerUiContributions('test.invalid-tool-view', [
      { id: 'tool', slot: 'tool-view', component: EmptyContribution, toolNames: [] },
    ]),
    /requires between 1 and 64 tool names/,
  )
  assert.deepEqual(listUiContributions('not-a-slot'), [])
})

test('UI contribution targets cannot shadow another plugin target', () => {
  const dispose = registerUiContributions('test.target-owner', [
    { id: 'settings', slot: 'settings-section', sectionId: 'owned-settings', label: 'Owner', component: EmptyContribution },
  ])
  try {
    assert.throws(
      () => registerUiContributions('test.target-shadow', [
        { id: 'other-id', slot: 'settings-section', sectionId: 'owned-settings', label: 'Shadow', component: EmptyContribution },
      ]),
      /target is already registered/,
    )
    assert.throws(
      () => registerUiContributions('test.host-tab', [
        { id: 'files-tab', slot: 'workbench-tab', tabId: 'files', label: 'Files', component: EmptyContribution },
      ]),
      /cannot replace host tab/,
    )
  } finally {
    dispose()
  }
})
