import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'

import ModelPicker from '../../src/pages/ChatSplit/ModelPicker.jsx'

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function verifiedModel(name, provider, providerLabel = '', mode = 'agent') {
  return {
    name,
    provider,
    providerKey: provider,
    providerLabel,
    configRevision: 1,
    readiness: {
      configRevision: 1,
      mode,
      chat: mode !== 'unavailable',
      tools: mode === 'agent',
      agent: mode === 'agent',
    },
  }
}

async function flushFocus() {
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)))
}

test('model picker opens a current-model row before the complete provider catalog', async () => {
  const dom = installDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const selectedValues = []
  const modelOptions = [
    verifiedModel('alpha', 'deepseek', 'DeepSeek'),
    { name: 'preview', provider: 'deepseek', providerLabel: 'DeepSeek' },
    verifiedModel('beta', 'local-lab', 'Local Lab', 'chat_only'),
  ]

  function Harness() {
    const [open, setOpen] = useState(false)
    const [selection, setSelection] = useState({ name: 'alpha', provider: 'deepseek' })
    return React.createElement(ModelPicker, {
      open,
      modelOptions,
      selectedModel: selection.name,
      selectedModelProviderId: selection.provider,
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: (name, provider) => {
        selectedValues.push([name, provider])
        setSelection({ name, provider })
      },
      onManage: () => {},
    })
  }

  try {
    await act(async () => root.render(React.createElement(Harness)))
    const trigger = rootElement.querySelector('[data-testid="model-picker-trigger"]')
    assert.equal(trigger.textContent.trim(), 'DeepSeek/alpha')

    await act(async () => trigger.click())
    await flushFocus()
    const panel = rootElement.querySelector('[data-testid="model-picker-panel"]')
    const modelRow = rootElement.querySelector('[data-testid="model-picker-model-row"]')
    assert.equal(panel.dataset.modelPickerView, 'settings')
    assert.match(modelRow.textContent, /模型/)
    assert.match(modelRow.textContent, /DeepSeek\/alpha/)
    assert.equal(document.activeElement, modelRow)
    assert.equal(rootElement.querySelector('[role="listbox"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="model-picker-option"]'), null)

    await act(async () => modelRow.click())
    await flushFocus()
    const listbox = rootElement.querySelector('[role="listbox"]')
    const groups = [...rootElement.querySelectorAll('[data-testid="model-picker-group"]')]
    const options = [...rootElement.querySelectorAll('[data-testid="model-picker-option"]')]
    assert.equal(panel.dataset.modelPickerView, 'catalog')
    assert.deepEqual(groups.map((group) => group.firstElementChild.textContent.trim()), ['DeepSeek', 'Local Lab'])
    assert.deepEqual(options.map((option) => option.textContent.trim()), ['alpha', 'preview', 'beta'])
    assert.equal(document.activeElement, options[0])
    assert.equal(options[0].getAttribute('aria-selected'), 'true')
    assert.ok(options[0].classList.contains('bg-ink/[0.06]'))

    for (const testId of ['model-picker-search', 'model-picker-agent-only', 'model-picker-more', 'model-picker-manage', 'model-picker-readiness']) {
      assert.equal(rootElement.querySelector(`[data-testid="${testId}"]`), null)
    }
    assert.doesNotMatch(listbox.textContent, /1M|Agent 可用|未测试|更多模型/)

    await act(async () => {
      listbox.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    assert.equal(document.activeElement, options[1])
    await act(async () => options[2].click())
    assert.deepEqual(selectedValues, [['beta', 'local-lab']])
    assert.equal(rootElement.querySelector('[data-testid="model-picker-panel"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="model-picker-trigger"]').textContent.trim(), 'Local Lab/beta')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('model picker preserves provider order and shows every model without legacy disclosures', async () => {
  const dom = installDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const modelOptions = [
    verifiedModel('first', 'provider-a', 'Provider A'),
    { name: 'untested', provider: 'provider-a', providerLabel: 'Provider A' },
    verifiedModel('selected', 'provider-b', 'Provider B'),
    verifiedModel('offline', 'provider-b', 'Provider B', 'unavailable'),
  ]

  try {
    await act(async () => root.render(React.createElement(ModelPicker, {
      open: true,
      modelOptions,
      selectedModel: 'selected',
      selectedModelProviderId: 'provider-b',
      onClose: () => {},
      onSelect: () => {},
      onManage: () => {},
    })))
    await act(async () => rootElement.querySelector('[data-testid="model-picker-model-row"]').click())
    const groups = [...rootElement.querySelectorAll('[data-testid="model-picker-group"]')]
    const options = [...rootElement.querySelectorAll('[data-testid="model-picker-option"]')]
    assert.deepEqual(groups.map((group) => group.firstElementChild.textContent.trim()), ['Provider A', 'Provider B'])
    assert.deepEqual(options.map((option) => option.dataset.modelName), ['first', 'untested', 'selected', 'offline'])
    assert.equal(options[1].disabled, false)
    assert.equal(options[3].disabled, true)
    assert.equal(rootElement.querySelector('[data-testid="model-picker-group-toggle"]'), null)
    assert.equal(rootElement.querySelector('[data-testid="model-picker-more"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('model picker keeps unavailable catalog states compact and actionable', async () => {
  const dom = installDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  let managed = 0
  let retried = 0

  function Harness({ kind }) {
    const [open, setOpen] = useState(true)
    return React.createElement(ModelPicker, {
      open,
      modelOptions: [],
      modelReadiness: { kind, canSend: false },
      selectedModel: '',
      onClose: () => setOpen(false),
      onManage: () => { managed += 1 },
      onRetry: () => { retried += 1 },
    })
  }

  try {
    await act(async () => root.render(React.createElement(Harness, { kind: 'error' })))
    const state = rootElement.querySelector('[data-testid="model-picker-state-error"]')
    assert.ok(state)
    assert.equal(state.querySelector('p'), null)
    assert.equal(rootElement.querySelector('[data-testid="model-picker-model-row"]'), null)
    const retry = state.querySelector('[aria-label="重新读取"]')
    await act(async () => retry.click())
    assert.equal(retried, 1)
    await act(async () => rootElement.querySelector('[data-testid="model-picker-manage"]').click())
    assert.equal(managed, 1)
    assert.equal(rootElement.querySelector('[data-testid="model-picker-panel"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('Escape and outside pointer close the picker and restore trigger focus', async () => {
  const dom = installDom()
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)

  function Harness() {
    const [open, setOpen] = useState(false)
    return React.createElement(ModelPicker, {
      open,
      modelOptions: [verifiedModel('alpha', 'primary', 'Primary')],
      selectedModel: 'alpha',
      selectedModelProviderId: 'primary',
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: () => {},
      onManage: () => {},
    })
  }

  try {
    await act(async () => root.render(React.createElement(Harness)))
    const trigger = rootElement.querySelector('[data-testid="model-picker-trigger"]')
    await act(async () => trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    await flushFocus()
    assert.ok(rootElement.querySelector('[data-testid="model-picker-model-row"]'))
    await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await flushFocus()
    assert.equal(rootElement.querySelector('[data-testid="model-picker-panel"]'), null)
    assert.equal(document.activeElement, trigger)

    await act(async () => trigger.click())
    await act(async () => document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })))
    assert.equal(rootElement.querySelector('[data-testid="model-picker-panel"]'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
