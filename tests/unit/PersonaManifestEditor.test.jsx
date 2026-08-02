import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import PersonaManifestEditor from '../../src/components/PersonaManifestEditor.jsx'
import { splitPersonaManifestIds } from '../../src/lib/personaManifest.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Event = dom.window.Event
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

const t = (key) => key

async function change(dom, element, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
    setter.call(element, value)
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

test('PersonaManifestEditor edits IDs and emits permission recommendations only', async () => {
  const dom = setupDom()
  const updates = []
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(
        <PersonaManifestEditor
          value={{
            version: 1,
            capabilityIds: ['research'],
            recommendedConnectorIds: ['github'],
            defaultPermissionMode: 'normal',
          }}
          onChange={(value) => updates.push(value)}
          t={t}
        />,
      )
    })

    const textareas = rootElement.querySelectorAll('textarea')
    const select = rootElement.querySelector('select')
    assert.equal(textareas[0].value, 'research')
    assert.equal(textareas[1].value, 'github')
    assert.equal(select.value, 'normal')
    assert.match(rootElement.textContent, /agents.permissionModeHint/)

    assert.deepEqual(splitPersonaManifestIds('research\ndocuments, research'), ['research', 'documents'])
    await change(dom, select, 'plan')
    assert.equal(updates.at(-1).defaultPermissionMode, 'plan')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
