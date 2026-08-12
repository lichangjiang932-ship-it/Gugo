import assert from 'node:assert/strict'
import test from 'node:test'

import { listRegisteredBrowserToolSpecs, registerBrowserTools } from '../server/services/browserTools.js'
import { listAllSpecs, unregisterByOrigin } from '../server/services/toolRegistry.js'
import { resolveTurnToolSpecs } from '../server/services/turnToolSpecs.js'
import { _browserInternals } from '../server/adapters/browserAutomation.js'
import { buildToolSpecs as buildFallbackToolSpecs } from '../src/lib/tools/toolSpecs.js'
import { executeToolCall } from '../src/lib/tools/index.js'
import { TOKEN_KEY } from '../src/lib/accountClient.js'
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
  assert.ok(names.has('browser_console'))
  assert.equal(names.has('browser_close'), false)
})

test('registered native browser tools can be injected into autonomous jobs', () => {
  registerBrowserTools()
  const names = listRegisteredBrowserToolSpecs().map((spec) => spec.function.name)
  for (const name of [
    'browser_open_url',
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
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
  for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_select', 'browser_press']) {
    assert.ok(names.has(name), `${name} missing from the turn catalog`)
  }
})

test('frontend fallback catalog keeps browser interaction tools available', () => {
  const expected = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_select', 'browser_press']
  const localSpecs = buildFallbackToolSpecs(expected)
  const fallbackNames = new Set(buildServerToolCatalogFallback([], localSpecs).map((spec) => spec.function.name))
  const liveNames = new Set(selectEnabledServerToolSpecs(localSpecs, {}).map((spec) => spec.function.name))
  assert.ok(expected.every((name) => fallbackNames.has(name)), 'fallback catalog dropped browser tools')
  assert.deepEqual([...liveNames].sort(), [...expected].sort())
})

test('standalone compatibility client routes standard browser actions to their HTTP endpoints', async () => {
  const oldWindow = globalThis.window
  const oldFetch = globalThis.fetch
  globalThis.window = {
    localStorage: {
      getItem: (key) => key === TOKEN_KEY ? 'token-browser' : null,
      setItem: () => {},
      removeItem: () => {},
    },
  }
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true, result: { connected: true } }), { status: 200 })
  }
  try {
    for (const [name, args] of [
      ['browser_navigate', { url: 'https://example.com' }],
      ['browser_select', { target: 'e2', value: 'Two' }],
      ['browser_press', { target: 'e1', key: 'Enter' }],
    ]) {
      const result = await executeToolCall({ name, arguments: JSON.stringify(args) })
      assert.equal(result.ok, true, name)
    }
    assert.deepEqual(calls.map((call) => call.url), [
      '/api/browser/navigate',
      '/api/browser/select',
      '/api/browser/press',
    ])
    assert.ok(calls.every((call) => call.init.headers.Authorization === 'Bearer token-browser'))
  } finally {
    globalThis.fetch = oldFetch
    globalThis.window = oldWindow
  }
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
