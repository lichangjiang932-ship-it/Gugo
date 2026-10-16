import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import DiffReviewPanel from '../../src/pages/ChatSplit/rightWorkbench/diffReview/DiffReviewPanel.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.CustomEvent = dom.window.CustomEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const t = (key, vars = {}) => key.replace(/\{(\w+)\}/gu, (_, name) => String(vars[name] ?? ''))

test('the panel mounts and switching every comparison target keeps rendering', async (t2) => {
  const dom = setupDom()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ files: [{ path: 'src/a.js', status: 'M', additions: 1, deletions: 0 }] }) })
  const root = createRoot(dom.window.document.getElementById('root'))
  t2.after(async () => {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  })

  await act(async () => {
    root.render(<DiffReviewPanel onClose={() => {}} panelExpanded t={t} workspacePath="/w" />)
  })
  const panel = dom.window.document.querySelector('[data-testid="diff-review-panel"]')
  assert.ok(panel, 'the panel renders')
  assert.equal(panel.getAttribute('data-target-mode'), 'uncommitted')

  // A dependency array is evaluated while rendering, so this is the exact path
  // that used to throw before the panel could mount: switch to every target.
  await act(async () => { dom.window.document.querySelector('[data-testid="diff-more"]').click() })
  for (const mode of ['all', 'branch', 'uncommitted', 'session']) {
    const select = dom.window.document.querySelector('[data-testid="diff-target-select"]')
    const option = select.querySelector(`[data-testid="diff-target-${mode}"]`)
    assert.ok(option && !option.disabled, `${mode} is offered`)
    await act(async () => { select.value = mode; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    assert.equal(
      dom.window.document.querySelector('[data-testid="diff-review-panel"]').getAttribute('data-target-mode'),
      mode,
    )
  }
  // Session mode reads the conversation feed, which starts empty: the honest
  // empty state, not a crash. It used to live in the file column; with that
  // column gone it is the viewer's own, which is where a reader with nothing
  // selected is looking anyway.
  assert.ok(dom.window.document.querySelector('[data-testid="diff-empty"]'), 'session mode shows its empty state')
})
