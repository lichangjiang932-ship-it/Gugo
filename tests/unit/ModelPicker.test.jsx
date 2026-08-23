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
        { name: 'alpha', provider: 'primary', providerLabel: 'Primary Cloud', contextWindow: 1_000_000 },
        { name: 'beta', provider: 'local-lab', providerLabel: 'Local Lab', contextWindow: 200_000, contextWindowEstimated: true },
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
  const groups = [...rootElement.querySelectorAll('[data-testid="model-picker-group"]')]
  assert.ok(panel)
  assert.ok(listbox)
  assert.equal(options.length, 2)
  assert.equal(groups.length, 2)
  assert.match(groups[0].textContent, /Primary Cloud/)
  assert.match(groups[1].textContent, /Local Lab/)
  assert.deepEqual(options.map((option) => option.textContent.includes('alpha') ? 'alpha' : 'beta'), ['alpha', 'beta'])
  assert.match(options[0].textContent, /1M/)
  assert.match(options[1].textContent, /~200K/)

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

test('model picker exposes an actionable unconfigured state without inventing a backend default', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  let managed = 0

  function Harness() {
    const [open, setOpen] = useState(false)
    return React.createElement(ModelPicker, {
      open,
      modelOptions: [],
      modelReadiness: { kind: 'unconfigured', canSend: false },
      selectedModel: '',
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onManage: () => { managed += 1 },
    })
  }

  try {
    await act(async () => root.render(React.createElement(Harness)))
    const trigger = rootElement.querySelector('[data-testid="model-picker-trigger"]')
    assert.doesNotMatch(trigger.textContent, /backend default/i)
    await act(async () => trigger.click())
    assert.ok(rootElement.querySelector('[data-testid="model-picker-state-unconfigured"]'))
    const manage = rootElement.querySelector('[data-testid="model-picker-manage"]')
    assert.ok(manage)
    await act(async () => manage.click())
    assert.equal(managed, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('model picker keeps the full catalog selectable when the current Provider is unverified or unavailable', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const selectedValues = []
  const renderPicker = (kind) => React.createElement(ModelPicker, {
    open: true,
    modelOptions: [
      { name: 'offline-model', provider: 'offline-provider', providerLabel: 'Offline Provider' },
      { name: 'healthy-model', provider: 'healthy-provider', providerLabel: 'Healthy Provider' },
    ],
    modelReadiness: { kind, canSend: false },
    selectedModel: 'offline-model',
    selectedModelProviderId: 'offline-provider',
    onClose: () => {},
    onSelect: (name, provider) => selectedValues.push([name, provider]),
    onManage: () => {},
  })

  try {
    for (const kind of ['provider-unverified', 'provider-unavailable']) {
      await act(async () => root.render(renderPicker(kind)))
      assert.equal(rootElement.querySelector(`[data-testid="model-picker-state-${kind}"]`), null)
      const visibleOptions = [...rootElement.querySelectorAll('[data-testid="model-picker-option"]')]
      assert.equal(visibleOptions.length, 2)
      assert.match(visibleOptions[0].textContent, /offline-model/)
      assert.match(visibleOptions[1].textContent, /healthy-model/)
    }

    const options = [...rootElement.querySelectorAll('[data-testid="model-picker-option"]')]
    await act(async () => options[1].click())
    assert.deepEqual(selectedValues, [['healthy-model', 'healthy-provider']])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('model picker shows per-model readiness and disables only a verified unavailable model', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const selectedValues = []
  let managed = 0
  const provider = {
    provider: 'provider-id',
    providerKey: 'provider-key',
    providerLabel: 'Local Provider',
    configRevision: 12,
  }
  const receipt = (readiness) => ({ configRevision: 12, ...readiness })

  try {
    await act(async () => root.render(React.createElement(ModelPicker, {
      open: true,
      selectedModel: 'agent-model',
      selectedModelProviderId: 'provider-id',
      modelReadiness: { kind: 'ready', canSend: true },
      modelOptions: [
        { ...provider, name: 'agent-model', readiness: receipt({ mode: 'agent', chat: true, tools: true, agent: true }) },
        { ...provider, name: 'chat-model', readiness: receipt({ mode: 'chat_only', chat: true, tools: false, agent: false }) },
        { ...provider, name: 'untested-model', readiness: null },
        {
          ...provider,
          name: 'offline-model',
          readiness: receipt({
            mode: 'unavailable', chat: false, tools: false, agent: false,
            error: 'internal upstream error: sk-secret-must-not-render',
          }),
        },
      ],
      onClose: () => {},
      onSelect: (name, providerId) => selectedValues.push([name, providerId]),
      onManage: () => { managed += 1 },
    })))

    const options = [...rootElement.querySelectorAll('[data-testid="model-picker-option"]')]
    assert.deepEqual(options.map((option) => option.dataset.readinessKind), [
      'agent-ready', 'chat-only', 'untested', 'unavailable',
    ])
    assert.equal(rootElement.querySelectorAll('[data-testid="model-picker-readiness"]').length, 4)
    assert.equal(options[0].disabled, false)
    assert.equal(options[1].disabled, false)
    assert.equal(options[2].disabled, false)
    assert.equal(options[3].disabled, true)
    assert.doesNotMatch(rootElement.textContent, /sk-secret|internal upstream error/i)

    await act(async () => options[3].click())
    assert.deepEqual(selectedValues, [])
    await act(async () => options[1].click())
    assert.deepEqual(selectedValues, [['chat-model', 'provider-id']])

    await act(async () => rootElement.querySelector('[data-testid="model-picker-manage"]').click())
    assert.equal(managed, 1)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
