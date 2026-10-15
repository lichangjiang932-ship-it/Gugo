import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ActionButton from '../../src/components/ui/ActionButton.jsx'

test('shared actions retain native form behavior, busy semantics and a stable accessible label', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  for (const key of ['window', 'document', 'HTMLElement', 'SVGElement']) globalThis[key] = key === 'window' ? dom.window : dom.window[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  let clicked = 0, submitted = 0
  const render = (props) => act(async () => root.render(<form onSubmit={(event) => { event.preventDefault(); submitted += 1 }}>
    <ActionButton {...props} data-testid="action" onClick={() => { clicked += 1 }}>Delete fixture</ActionButton>
  </form>))
  try {
    await render({ busy: true, variant: 'danger' })
    let button = document.querySelector('button')
    assert.equal(button.type, 'button')
    assert.equal(button.getAttribute('aria-busy'), 'true')
    assert.equal(button.disabled, true)
    assert.equal(button.textContent, 'Delete fixture')
    await act(async () => button.click())
    assert.equal(clicked, 0)
    await render({ busy: false })
    button = document.querySelector('button')
    await act(async () => button.click())
    assert.equal(clicked, 1)
    assert.equal(submitted, 0)
    await render({ type: 'submit' })
    await act(async () => document.querySelector('button').click())
    assert.equal(submitted, 1)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})
