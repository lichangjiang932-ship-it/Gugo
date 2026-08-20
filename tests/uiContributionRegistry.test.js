import assert from 'node:assert/strict'
import test from 'node:test'

import '../src/plugins/firstPartyUiContributions.js'
import { resolveSettingsSectionFromSearch, settingsPathForSection } from '../src/lib/settingsNavigation.js'
import { notifyUiContributionListeners } from '../src/plugins/uiContributionNotifications.js'
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

test('UI contribution notifications isolate observer failures and snapshot each batch', () => {
  const calls = []
  const listeners = new Set()
  const lateListener = () => calls.push('late')
  const removedListener = () => calls.push('removed')
  listeners.add(() => {
    calls.push('throwing')
    listeners.delete(removedListener)
    listeners.add(lateListener)
    throw new Error('observer failure must not escape')
  })
  listeners.add(removedListener)

  notifyUiContributionListeners(listeners)
  assert.deepEqual(calls, ['throwing', 'removed'])

  notifyUiContributionListeners(listeners)
  assert.deepEqual(calls, ['throwing', 'removed', 'throwing', 'late'])
})

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

test('UI registry queries reject object coercion and return frozen lists', () => {
  let coercionCalls = 0
  const coercive = {
    toString() {
      coercionCalls += 1
      return 'gugo-first-party'
    },
    [Symbol.toPrimitive]() {
      coercionCalls += 1
      return 'route'
    },
  }

  assert.equal(getUiPlugin(coercive), null)
  assert.deepEqual(listUiContributions(coercive), [])
  assert.throws(() => unregisterUiPlugin(coercive), /UI plugin id is invalid/)
  assert.equal(coercionCalls, 0)

  const plugins = listUiPlugins()
  assert.equal(Object.isFrozen(plugins), true)
  assert.ok(plugins.every((plugin) => Object.isFrozen(plugin)))
  assert.throws(() => plugins.push({ id: 'forged' }), TypeError)
  assert.equal(getUiPlugin(' gugo-first-party ')?.id, 'gugo-first-party')
  assert.equal(listUiContributions(' route '), listUiContributions('route'))
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

test('UI contribution definitions reject accessors without invoking them', () => {
  const cases = [
    ['slot', { id: 'accessor', component: EmptyContribution }],
    ['id', { slot: 'conversation-node', component: EmptyContribution }],
    ['component', { id: 'accessor', slot: 'conversation-node' }],
  ]
  for (const [field, values] of cases) {
    let getterCalls = 0
    const definition = { ...values }
    Object.defineProperty(definition, field, {
      enumerable: true,
      get() {
        getterCalls += 1
        return field === 'slot'
          ? 'conversation-node'
          : field === 'id'
            ? 'accessor'
            : EmptyContribution
      },
    })
    assert.throws(
      () => registerUiContributions(`test.ui-accessor-${field}`, [definition]),
      (error) => error?.code === 'UI_CONTRIBUTION_DEFINITION_INVALID'
        && error?.retryable === false
        && new RegExp(`contribution\\.${field}`).test(error?.message || ''),
    )
    assert.equal(getterCalls, 0)
  }

  let inputGetterCalls = 0
  const inputs = []
  Object.defineProperty(inputs, 0, {
    enumerable: true,
    get() {
      inputGetterCalls += 1
      return { id: 'forged', slot: 'conversation-node', component: EmptyContribution }
    },
  })
  assert.throws(
    () => registerUiContributions('test.ui-input-accessor', inputs),
    (error) => error?.code === 'UI_CONTRIBUTION_DEFINITION_INVALID'
      && /contributions\[0\]/.test(error?.message || ''),
  )
  assert.equal(inputGetterCalls, 0)
})

test('UI contributions reject inherited definitions and accessor tool names', () => {
  const inherited = Object.create({
    id: 'inherited',
    slot: 'conversation-node',
    component: EmptyContribution,
  })
  assert.throws(
    () => registerUiContributions('test.ui-inherited', [inherited]),
    /Unsupported UI contribution slot/,
  )

  let getterCalls = 0
  const toolNames = []
  Object.defineProperty(toolNames, 0, {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'forged-tool'
    },
  })
  assert.throws(
    () => registerUiContributions('test.ui-tool-name-accessor', [{
      id: 'tool-view',
      slot: 'tool-view',
      component: EmptyContribution,
      toolNames,
    }]),
    (error) => error?.code === 'UI_CONTRIBUTION_DEFINITION_INVALID'
      && /toolNames\[0\]/.test(error?.message || ''),
  )
  assert.equal(getterCalls, 0)
})

test('UI contribution and tool-name arrays reject sparse or inherited entries', () => {
  const definition = { id: 'array-entry', slot: 'conversation-node', component: EmptyContribution }
  const sparseInputs = new Array(1)
  const inheritedInputs = new Array(1)
  Object.setPrototypeOf(inheritedInputs, { 0: definition })

  for (const [pluginId, inputs] of [
    ['test.ui-sparse-inputs', sparseInputs],
    ['test.ui-inherited-inputs', inheritedInputs],
  ]) {
    assert.throws(
      () => registerUiContributions(pluginId, inputs),
      (error) => error?.code === 'UI_CONTRIBUTION_DEFINITION_INVALID'
        && /contributions\[0\]/.test(error?.message || ''),
    )
  }

  const sparseNames = new Array(1)
  const inheritedNames = new Array(1)
  Object.setPrototypeOf(inheritedNames, { 0: 'inherited-tool' })
  for (const [pluginId, toolNames] of [
    ['test.ui-sparse-tool-names', sparseNames],
    ['test.ui-inherited-tool-names', inheritedNames],
  ]) {
    assert.throws(
      () => registerUiContributions(pluginId, [{
        id: 'tool-view',
        slot: 'tool-view',
        component: EmptyContribution,
        toolNames,
      }]),
      (error) => error?.code === 'UI_CONTRIBUTION_DEFINITION_INVALID'
        && /toolNames\[0\]/.test(error?.message || ''),
    )
  }
})

test('trusted UI validation and installation reuse one contribution snapshot', () => {
  const OriginalComponent = () => null
  const MutatedComponent = () => null
  let definitionPropertyReads = 0
  let definitionDescriptorReads = 0
  let listPropertyReads = 0
  let listDescriptorReads = 0
  const target = {
    id: 'single-snapshot',
    slot: 'conversation-node',
    component: OriginalComponent,
  }
  const definition = new Proxy(target, {
    get(object, key, receiver) {
      definitionPropertyReads += 1
      return Reflect.get(object, key, receiver)
    },
    getOwnPropertyDescriptor(object, key) {
      definitionDescriptorReads += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
  })
  const inputs = new Proxy([definition], {
    get(object, key, receiver) {
      listPropertyReads += 1
      return Reflect.get(object, key, receiver)
    },
    getOwnPropertyDescriptor(object, key) {
      listDescriptorReads += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
  })

  const dispose = registerTrustedUiPlugin({
    id: 'test-ui-single-snapshot',
    name: 'Single snapshot',
    version: '1.0.0',
    contributes: ['ui:conversation-node:single-snapshot'],
  }, inputs)
  const readsAfterRegistration = {
    definitionDescriptorReads,
    listDescriptorReads,
  }
  target.component = MutatedComponent

  try {
    const installed = listUiContributions('conversation-node')
      .find((entry) => entry.pluginId === 'test-ui-single-snapshot')
    assert.equal(installed.component, OriginalComponent)
    assert.equal(definitionPropertyReads, 0)
    assert.equal(listPropertyReads, 0)
    assert.deepEqual({ definitionDescriptorReads, listDescriptorReads }, readsAfterRegistration)
  } finally {
    assert.equal(dispose(), true)
  }
})

test('UI contributions are registration-time descriptor snapshots', () => {
  const OriginalRoute = () => null
  const MutatedRoute = () => null
  const OriginalTool = () => null
  const MutatedTool = () => null
  let propertyReads = 0
  let descriptorReads = 0
  const routeTarget = {
    id: 'snapshot-route',
    slot: 'route',
    path: '/snapshot-original',
    component: OriginalRoute,
    order: 10,
  }
  const toolNames = ['snapshot-tool']
  const toolTarget = {
    id: 'snapshot-tool-view',
    slot: 'tool-view',
    component: OriginalTool,
    toolNames,
  }
  const proxy = (target) => new Proxy(target, {
    get(object, key, receiver) {
      propertyReads += 1
      return Reflect.get(object, key, receiver)
    },
    getOwnPropertyDescriptor(object, key) {
      descriptorReads += 1
      return Reflect.getOwnPropertyDescriptor(object, key)
    },
  })

  const dispose = registerUiContributions('test.ui-definition-snapshot', [
    proxy(routeTarget),
    proxy(toolTarget),
  ])
  const registrationDescriptorReads = descriptorReads
  routeTarget.path = '/snapshot-mutated'
  routeTarget.component = MutatedRoute
  routeTarget.order = -100
  toolTarget.component = MutatedTool
  toolNames[0] = 'mutated-tool'

  try {
    const route = listUiContributions('route')
      .find((entry) => entry.pluginId === 'test.ui-definition-snapshot')
    const tool = listUiContributions('tool-view')
      .find((entry) => entry.pluginId === 'test.ui-definition-snapshot')
    assert.equal(route.path, '/snapshot-original')
    assert.equal(route.component, OriginalRoute)
    assert.equal(route.order, 10)
    assert.equal(tool.component, OriginalTool)
    assert.deepEqual(tool.toolNames, ['snapshot-tool'])
    assert.equal(Object.isFrozen(tool.toolNames), true)
    assert.equal(propertyReads, 0)
    assert.equal(descriptorReads, registrationDescriptorReads)
  } finally {
    assert.equal(dispose(), true)
  }
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
