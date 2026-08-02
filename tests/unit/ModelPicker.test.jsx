import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'

import ModelPicker from '../../src/pages/ChatSplit/ModelPicker.jsx'

test('model picker opens above the composer and switches from a vertical model list', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const selectedValues = []
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)

  function Harness() {
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState('alpha')
    return React.createElement(ModelPicker, {
      open,
      selectedModel: selected,
      modelOptions: [
        { name: 'alpha', contextWindow: 1_000_000, multiplier: 1 },
        { name: 'beta', contextWindow: 200_000, multiplier: 2 },
      ],
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: (name) => {
        selectedValues.push(name)
        setSelected(name)
      },
      onManage: () => {},
    })
  }

  await act(async () => root.render(React.createElement(Harness)))
  const trigger = rootElement.querySelector('[data-testid="model-picker-trigger"]')
  assert.equal(trigger.textContent.trim(), 'alpha')

  await act(async () => trigger.click())
  const panel = rootElement.querySelector('[data-testid="model-picker-panel"]')
  const listbox = rootElement.querySelector('[role="listbox"]')
  const options = [...rootElement.querySelectorAll('[data-testid="model-picker-option"]')]
  assert.ok(panel)
  assert.ok(listbox)
  assert.equal(options.length, 2)
  assert.deepEqual(options.map((option) => option.textContent.includes('alpha') ? 'alpha' : 'beta'), ['alpha', 'beta'])

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.equal(dom.window.document.activeElement, options[0])

  await act(async () => {
    listbox.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  assert.equal(dom.window.document.activeElement, options[1])

  await act(async () => {
    listbox.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  })
  assert.equal(dom.window.document.activeElement, options[0])

  await act(async () => {
    listbox.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  })
  assert.equal(dom.window.document.activeElement, options[1])

  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.equal(rootElement.querySelector('[data-testid="model-picker-panel"]'), null)
  assert.equal(dom.window.document.activeElement, trigger)

  await act(async () => {
    trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assert.ok(rootElement.querySelector('[data-testid="model-picker-panel"]'))

  const reopenedOptions = [...rootElement.querySelectorAll('[data-testid="model-picker-option"]')]
  await act(async () => reopenedOptions[1].click())
  assert.deepEqual(selectedValues, ['beta'])
  assert.equal(rootElement.querySelector('[data-testid="model-picker-panel"]'), null)
  assert.equal(rootElement.querySelector('[data-testid="model-picker-trigger"]').textContent.trim(), 'beta')

  await act(async () => root.unmount())
  dom.window.close()
})
