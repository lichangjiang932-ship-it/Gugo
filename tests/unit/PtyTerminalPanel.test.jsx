import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

const translations = {
  'workbench.terminal': 'Terminal',
  'workbench.terminalDesktop': 'Local shell',
  'workbench.terminalExited': 'The shell exited (code {code}).',
  'workbench.terminalRestart': 'Restart terminal',
  'workbench.terminalStartFailed': 'The terminal could not start. Try again.',
}

const t = (key, vars) => {
  const raw = translations[key] || key
  if (!vars) return raw
  return Object.entries(vars).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), raw)
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  delete globalThis.ResizeObserver
  // Each test starts with no terminals, so counting them means something.
  FakeTerminal.instances = []
  return dom
}

/** xterm needs a canvas and a real layout; the panel only needs its lifecycle. */
class FakeTerminal {
  constructor(options) {
    this.options = options
    this.disposed = 0
    this.writes = []
    this.cols = 0
    this.rows = 0
    this.dataHandlers = []
    FakeTerminal.instances.push(this)
  }

  loadAddon(addon) { this.addon = addon }

  open(element) {
    this.element = element
    this.cols = 90
    this.rows = 30
  }

  write(chunk) { this.writes.push(chunk) }

  onData(handler) { this.dataHandlers.push(handler) }

  dispose() { this.disposed += 1 }

  type(data) { for (const handler of this.dataHandlers) handler(data) }
}
FakeTerminal.instances = []

class FakeFitAddon {}

/** One stable identity and no reset: a new loader each render would re-run the
 * panel's effect, and clearing the instances here would hide the terminal from the
 * assertions that follow a restart. */
function fakeRuntime() {
  return { Terminal: FakeTerminal, FitAddon: FakeFitAddon }
}

/**
 * Stands in for the desktop host: it refuses work for a session it does not have,
 * the way the real one answers `{ ok: false, reason: 'session' }`.
 */
function createBridge({ deferred = false, id = 'terminal-1' } = {}) {
  const state = { starts: [], written: [], resized: [], killed: [], data: [], exit: [] }
  let settle = null
  const live = new Set()
  const bridge = {
    start: (options) => {
      state.starts.push(options)
      live.add(id)
      const result = { ok: true, id, cols: 90, rows: 30, shell: 'C:\\Windows\\cmd.exe' }
      if (!deferred) return Promise.resolve(result)
      return new Promise((resolve) => { settle = () => resolve(result) })
    },
    write: (sessionId, data) => {
      if (!live.has(sessionId)) return Promise.resolve({ ok: false, reason: 'session' })
      state.written.push([sessionId, data])
      return Promise.resolve({ ok: true })
    },
    resize: (sessionId, cols, rows) => {
      if (!live.has(sessionId)) return Promise.resolve({ ok: false, reason: 'session' })
      state.resized.push([sessionId, cols, rows])
      return Promise.resolve({ ok: true, cols, rows })
    },
    kill: (sessionId) => {
      state.killed.push(sessionId)
      const known = live.delete(sessionId)
      return Promise.resolve({ ok: known })
    },
    onData: (handler) => {
      state.data.push(handler)
      return () => { state.data = state.data.filter((entry) => entry !== handler) }
    },
    onExit: (handler) => {
      state.exit.push(handler)
      return () => { state.exit = state.exit.filter((entry) => entry !== handler) }
    },
  }
  return {
    bridge,
    state,
    emit: (kind, payload) => {
      if (kind === 'exit') live.delete(payload.id)
      for (const handler of [...state[kind]]) handler(payload)
    },
    resolveStart: () => settle?.(),
  }
}

// Every panel is unmounted after its test: a root left mounted keeps its session
// (and its subscription) alive into the next test's assertions.
const mountedRoots = []

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(async () => { root.unmount() })
})

async function mountPanel({ bridge, initial = { active: true } }) {
  const { createRoot } = await import('react-dom/client')
  const PtyTerminalPanel = (await import('../../src/pages/ChatSplit/rightWorkbench/PtyTerminalPanel.jsx')).default
  globalThis.window.gugoDesktop = { terminal: bridge }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  const render = async (props) => {
    await act(async () => { root.render(<PtyTerminalPanel t={t} loadRuntime={fakeRuntime} {...props} />) })
    // One more flush so the async boot (start host + import xterm) settles.
    await act(async () => {})
  }
  await render(initial)
  const panel = () => container.querySelector('[data-testid="workbench-pty-panel"]')
  const clickRestart = async () => {
    const button = [...container.querySelectorAll('button')]
      .find((entry) => entry.getAttribute('aria-label') === 'Restart terminal')
    await act(async () => { button.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })) })
    await act(async () => {})
  }
  return { clickRestart, container, panel, render, root }
}

test('the shell starts only once the tab is opened', async () => {
  setupDom()
  const { bridge, state } = createBridge()
  const { render } = await mountPanel({ bridge, initial: { active: false } })
  assert.deepEqual(state.starts, [], 'a tab that was never opened must not spawn a shell')
  assert.deepEqual(state.data, [], 'and must not subscribe to anything')

  await render({ active: true })
  assert.equal(state.starts.length, 1)
  assert.deepEqual(state.starts[0], {}, 'the host decides the size until xterm has measured')
  assert.equal(FakeTerminal.instances.length, 1)

  // Deactivating is about visibility: the running session survives it.
  await render({ active: false })
  assert.equal(state.starts.length, 1)
  assert.deepEqual(state.killed, [])
  assert.deepEqual(state.data.length, 1, 'the session stays subscribed while hidden')
})

test('the shell is asked to open in the workbench project', async () => {
  setupDom()
  const { bridge, state } = createBridge()
  await mountPanel({ bridge, initial: { active: true, cwd: 'C:/projects/gugo' } })
  assert.deepEqual(state.starts, [{ cwd: 'C:/projects/gugo' }])

  // Without a project the host decides, and is asked with nothing at all.
  const bare = createBridge()
  await mountPanel({ bridge: bare.bridge, initial: { active: true } })
  assert.deepEqual(bare.state.starts, [{}])
})

test('without a desktop bridge nothing is spawned', async () => {
  setupDom()
  const { createRoot } = await import('react-dom/client')
  const PtyTerminalPanel = (await import('../../src/pages/ChatSplit/rightWorkbench/PtyTerminalPanel.jsx')).default
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<PtyTerminalPanel t={t} loadRuntime={fakeRuntime} />) })
  await act(async () => {})
  assert.equal(FakeTerminal.instances.length, 0)
  await act(async () => { root.unmount() })
})

test('output the shell prints before xterm exists is replayed, in order', async () => {
  setupDom()
  const { bridge, emit, resolveStart, state } = createBridge({ deferred: true })
  await mountPanel({ bridge })

  // The host has a shell before the panel has a terminal; the banner arrives first.
  emit('data', { id: 'terminal-1', chunk: 'banner\r\n' })
  emit('data', { id: 'terminal-9', chunk: 'another session\r\n' })
  await act(async () => { resolveStart() })
  await act(async () => {})

  const terminal = FakeTerminal.instances[0]
  assert.deepEqual(terminal.writes, ['banner\r\n'], 'this session only, in arrival order')
  assert.deepEqual(state.resized.at(-1), ['terminal-1', 90, 30], 'the host is told the fitted size')

  emit('data', { id: 'terminal-1', chunk: 'prompt> ' })
  assert.deepEqual(terminal.writes, ['banner\r\n', 'prompt> '])
})

test('keystrokes and panel resizes reach the host', async () => {
  setupDom()
  const { bridge, state } = createBridge()
  const { panel } = await mountPanel({ bridge })
  assert.deepEqual(state.resized, [['terminal-1', 90, 30]])
  assert.equal(FakeTerminal.instances[0].element, panel().querySelector('[data-testid="workbench-pty-surface"]'))

  FakeTerminal.instances[0].type('dir\r')
  assert.deepEqual(state.written, [['terminal-1', 'dir\r']])
})

test('a resize observer re-fits the terminal and tells the host', async () => {
  setupDom()
  let trigger = null
  globalThis.ResizeObserver = class {
    constructor(callback) { trigger = callback }
    observe() {}
    disconnect() { this.disconnected = true }
  }
  const { bridge, state } = createBridge()
  await mountPanel({ bridge })
  assert.equal(state.resized.length, 1)

  FakeTerminal.instances[0].cols = 120
  FakeTerminal.instances[0].rows = 40
  await act(async () => { trigger() })
  assert.deepEqual(state.resized.at(-1), ['terminal-1', 120, 40])
})

test('an exit is reported once and the shell stops taking input', async () => {
  setupDom()
  const { bridge, emit, state } = createBridge()
  const { panel } = await mountPanel({ bridge })
  const terminal = FakeTerminal.instances[0]

  await act(async () => {
    emit('exit', { id: 'terminal-1', exitCode: 3 })
    emit('exit', { id: 'terminal-1', exitCode: 3 })
  })
  assert.equal(panel().querySelector('[data-testid="workbench-pty-notice"]').textContent, 'The shell exited (code 3).')
  assert.equal(panel().dataset.phase, 'exited')

  terminal.type('still there?')
  assert.deepEqual(state.written, [], 'a dead session must not be typed into')
})

test('a shell that exits while its output is still being replayed is not called running', async () => {
  setupDom()
  const { bridge, emit, resolveStart } = createBridge({ deferred: true })
  const { panel } = await mountPanel({ bridge })

  await act(async () => { emit('exit', { id: 'terminal-1', exitCode: 1 }) })
  await act(async () => { resolveStart() })
  await act(async () => {})

  assert.equal(panel().dataset.phase, 'exited')
  assert.equal(panel().querySelector('[data-testid="workbench-pty-notice"]').textContent, 'The shell exited (code 1).')
})

test('restarting releases the old shell, and unmounting releases the new one', async () => {
  setupDom()
  const { bridge, state } = createBridge()
  const { clickRestart, root } = await mountPanel({ bridge })
  assert.deepEqual(state.killed, [])

  await clickRestart()
  assert.deepEqual(state.killed, ['terminal-1'])
  assert.equal(state.starts.length, 2, 'the restart asks for a new shell')
  assert.equal(FakeTerminal.instances[0].disposed, 1)
  assert.equal(state.data.length, 1, 'the old subscription was dropped, not accumulated')

  await act(async () => { root.unmount() })
  assert.deepEqual(state.killed, ['terminal-1', 'terminal-1'])
  assert.equal(FakeTerminal.instances[1].disposed, 1)
  assert.deepEqual(state.data, [], 'no listener is left subscribed')
  assert.deepEqual(state.exit, [])
})

test('a shell that cannot start says so instead of showing a blank panel', async () => {
  setupDom()
  const { bridge, state } = createBridge()
  bridge.start = () => { state.starts.push({}); return Promise.reject(new Error('spawn failed')) }
  const { panel } = await mountPanel({ bridge })
  assert.equal(panel().dataset.phase, 'failed')
  assert.equal(
    panel().querySelector('[data-testid="workbench-pty-notice"]').textContent,
    'The terminal could not start. Try again.',
  )
  assert.equal(FakeTerminal.instances.length, 0)
})
