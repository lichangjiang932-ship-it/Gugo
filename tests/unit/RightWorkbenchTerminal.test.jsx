import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

const translations = {
  'workbench.terminal': 'Terminal',
  'workbench.terminalDesktop': 'Local shell',
  'workbench.terminalStartFailed': 'The terminal could not start. Try again.',
}

const t = (key) => translations[key] || key

// The panels other tabs need, so switching tabs in this test exercises the branch
// under test rather than the props of its neighbours.
const baseProps = {
  artifacts: [],
  attachments: [],
  command: '',
  contributedTabs: [],
  cwd: '',
  isGenerating: false,
  messages: [],
  runCommand: () => {},
  setCommand: () => {},
  setCwd: () => {},
  setTerminalTranscript: () => {},
  t,
  terminalBusy: false,
  terminalTranscript: { dropped: 0, entries: [] },
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
  delete globalThis.ResizeObserver
  return dom
}

/** A bridge that can be asked for a shell but never gives one. */
function refusingBridge() {
  return {
    start: () => Promise.reject(new Error('no shell in a test')),
    write: () => Promise.resolve({ ok: true }),
    resize: () => Promise.resolve({ ok: true }),
    kill: () => Promise.resolve({ ok: true }),
    onData: () => () => {},
    onExit: () => () => {},
  }
}

const mountedRoots = []

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(async () => { root.unmount() })
})

async function renderWorkbench({ activeTab, bridge }) {
  const { createRoot } = await import('react-dom/client')
  const RightWorkbenchContent = (await import('../../src/pages/ChatSplit/rightWorkbench/RightWorkbenchContent.jsx')).default
  if (bridge) globalThis.window.gugoDesktop = { terminal: bridge }
  else delete globalThis.window.gugoDesktop
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  const render = async (tab) => {
    await act(async () => {
      root.render(<RightWorkbenchContent activeTab={tab} {...baseProps} />)
    })
    await act(async () => {})
  }
  await render(activeTab)
  return { container, render }
}

test('the web build keeps the command console', async () => {
  setupDom()
  const { container } = await renderWorkbench({ activeTab: 'terminal' })
  assert.equal(container.querySelector('[data-testid="workbench-pty-panel"]'), null)
  assert.ok(container.querySelector('[data-testid="workbench-terminal-transcript"]'), 'the console is what a browser has')
})

test('the desktop build gets the shell panel instead', async () => {
  setupDom()
  const { container } = await renderWorkbench({ activeTab: 'terminal', bridge: refusingBridge() })
  const panel = container.querySelector('[data-testid="workbench-pty-panel"]')
  assert.ok(panel)
  assert.equal(container.querySelector('[data-testid="workbench-terminal-transcript"]'), null)
  // The stand-in bridge never hands out a shell, so the panel reports that rather
  // than pretending to be a terminal.
  assert.equal(panel.dataset.phase, 'failed')
})

test('the shell panel is mounted only while the workbench is open, and hidden on other tabs', async () => {
  setupDom()
  const { container, render } = await renderWorkbench({ activeTab: 'files', bridge: refusingBridge() })
  const panel = container.querySelector('[data-testid="workbench-pty-panel"]')
  assert.ok(panel, 'the panel exists so a running shell survives a tab switch')
  assert.equal(panel.className.includes('hidden'), true, 'but it is not shown on another tab')
  assert.equal(panel.dataset.phase, 'idle', 'and no shell was asked for')

  await render('terminal')
  assert.equal(container.querySelector('[data-testid="workbench-pty-panel"]').className.includes('hidden'), false)
})
