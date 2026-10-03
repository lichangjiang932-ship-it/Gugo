import assert from 'node:assert/strict'
import test from 'node:test'

import { listRegisteredBrowserToolSpecs, registerBrowserTools } from '../server/services/browserTools.js'
import { listAllSpecs, unregisterByOrigin } from '../server/services/toolRegistry.js'
import { resolveTurnToolSpecs } from '../server/services/turnToolSpecs.js'
import { _browserInternals } from '../server/adapters/browserAutomation.js'
import { buildServerToolCatalogFallback, selectEnabledServerToolSpecs } from '../src/lib/serverToolCatalog.js'

test.afterEach(() => unregisterByOrigin('browser'))

test('browser dynamic tool catalog exposes state and console inspection', () => {
  registerBrowserTools()
  const names = new Set(
    listAllSpecs()
      .filter((entry) => entry.origin === 'browser')
      .map((entry) => entry.name),
  )

  assert.ok(names.has('browser_state'))
  assert.ok(names.has('browser_tabs'))
  assert.ok(names.has('browser_switch_tab'))
  assert.ok(names.has('browser_frames'))
  assert.ok(names.has('browser_switch_frame'))
  assert.ok(names.has('browser_console'))
  assert.equal(names.has('browser_close'), false)
})

test('registered native browser tools can be injected into autonomous jobs', () => {
  registerBrowserTools()
  const names = listRegisteredBrowserToolSpecs().map((spec) => spec.function.name)
  for (const name of [
    'browser_open_url',
    'browser_navigate',
    'browser_tabs',
    'browser_switch_tab',
    'browser_frames',
    'browser_switch_frame',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_upload_file',
    'browser_download',
    'browser_select',
    'browser_press',
    'browser_wait',
  ]) {
    assert.ok(names.includes(name), `${name} missing from the browser tool catalog`)
  }
})

test('browser interaction tools reach the model-facing turn catalog', async () => {
  registerBrowserTools()
  const specs = await resolveTurnToolSpecs({
    userId: null,
    baseSpecs: [],
    toolsConfig: {},
    webSearchReady: true,
    enabledConnectorTools: [],
  })
  const names = new Set(specs.map((spec) => spec.function.name))
  for (const name of ['browser_navigate', 'browser_tabs', 'browser_switch_tab', 'browser_frames', 'browser_switch_frame', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_upload_file', 'browser_download', 'browser_select', 'browser_press']) {
    assert.ok(names.has(name), `${name} missing from the turn catalog`)
  }
})

test('frontend fallback catalog keeps browser interaction tools available', () => {
  const expected = ['browser_navigate', 'browser_tabs', 'browser_switch_tab', 'browser_frames', 'browser_switch_frame', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_upload_file', 'browser_download', 'browser_select', 'browser_press']
  registerBrowserTools()
  const liveSpecs = listRegisteredBrowserToolSpecs()
  const fallback = buildServerToolCatalogFallback([], expected)
  const fallbackNames = new Set(fallback.map((spec) => spec.function.name))
  const liveNames = new Set(selectEnabledServerToolSpecs(liveSpecs, {}).map((spec) => spec.function.name))
  assert.ok(expected.every((name) => fallbackNames.has(name)), 'fallback catalog dropped browser tools')
  assert.ok(expected.every((name) => liveNames.has(name)), 'live catalog dropped browser tools')
  assert.ok(fallback.every((spec) => !Object.hasOwn(spec.function, 'parameters')))
})

test('browser tab switching enables the new target before retiring the previous client', async () => {
  let previousClosed = false
  let nextClosed = false
  const methods = []
  const session = {
    client: { close: () => { previousClosed = true } },
    sessionId: null,
    targetId: 'main-target',
  }
  const nextClient = {
    connect: async () => { methods.push('connect') },
    request: async (method) => {
      methods.push(method)
      if (method === 'Runtime.evaluate') return { result: { value: 'complete' } }
      return {}
    },
    close: () => { nextClosed = true },
  }
  await _browserInternals.switchPageTarget(session, {
    id: 'popup-target',
    webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/popup-target',
  }, { createClient: () => nextClient })

  assert.equal(session.client, nextClient)
  assert.equal(session.targetId, 'popup-target')
  assert.equal(previousClosed, true)
  assert.equal(nextClosed, false)
  assert.deepEqual(methods, [
    'connect', 'Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'Runtime.evaluate',
  ])
})

test('browser tab switching rolls back when the new target cannot be initialized', async () => {
  const previousClient = { close: () => assert.fail('the previous target must remain open') }
  let nextClosed = false
  const session = { client: previousClient, sessionId: 'old-session', targetId: 'main-target' }
  const nextClient = {
    connect: async () => {},
    request: async (method) => {
      if (method === 'Runtime.enable') throw new Error('target initialization failed')
      return {}
    },
    close: () => { nextClosed = true },
  }
  await assert.rejects(
    _browserInternals.switchPageTarget(session, {
      id: 'broken-target',
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/broken-target',
    }, { createClient: () => nextClient }),
    /target initialization failed/,
  )
  assert.equal(session.client, previousClient)
  assert.equal(session.sessionId, 'old-session')
  assert.equal(session.targetId, 'main-target')
  assert.equal(nextClosed, true)
})

test('browser key parser supports named keys and modifier chords', () => {
  assert.deepEqual(_browserInternals.keyEventParams('Enter'), {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: 0,
    text: '\r',
    unmodifiedText: '\r',
  })
  assert.deepEqual(_browserInternals.keyEventParams('Control+A'), {
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2,
  })
  assert.throws(() => _browserInternals.keyEventParams('Hyper+Enter'), /组合键修饰符/)
})
