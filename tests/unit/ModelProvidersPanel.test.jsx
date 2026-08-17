import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ModelProvidersPanel from '../../src/components/ModelProvidersPanel.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings?tab=models',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Event = dom.window.Event
  globalThis.MouseEvent = dom.window.MouseEvent
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function buttonByText(text, { exact = false } = {}) {
  return [...document.querySelectorAll('button')].find((button) => (
    exact ? button.textContent.trim() === text : button.textContent.includes(text)
  ))
}

async function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    input.focus()
    setter.call(input, value)
    input.dispatchEvent(new window.InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: 'insertText',
    }))
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

test('selecting an already configured preset updates it instead of submitting a duplicate provider key', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const existing = {
    id: 'provider-openai',
    key: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5.6-sol'],
    defaultModel: 'gpt-5.6-sol',
    enabled: true,
    isDefault: true,
    hasApiKey: true,
    headers: {},
    kind: 'openai-compatible',
    contextWindow: null,
    modelProfiles: {},
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsPdf: false,
    firstTokenTimeoutMs: null,
    idleTimeoutMs: null,
    failoverEnabled: null,
    keepAlive: null,
  }
  let submitted = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (url !== '/api/model/providers') throw new Error(`Unexpected request: ${url}`)
    if (init.method === 'POST') {
      submitted = JSON.parse(init.body)
      if (!submitted.id) {
        return new Response(JSON.stringify({
          error: { message: 'Provider ID openai already exists' },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, provider: { ...existing, ...submitted } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true, providers: [existing] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await act(async () => {
      root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>)
    })
    await act(async () => { await Promise.resolve() })

    await act(async () => buttonByText('新增', { exact: true }).click())
    await act(async () => buttonByText('OpenAI').click())
    const apiKeyInput = document.querySelector('input[type="password"]')
    assert.ok(apiKeyInput)
    await setInputValue(apiKeyInput, 'sk-replacement')

    const save = buttonByText('保存', { exact: true })
    assert.ok(save)
    assert.equal(save.disabled, false)
    await act(async () => save.click())

    assert.equal(submitted?.id, existing.id)
    assert.equal(submitted?.apiKey, 'sk-replacement')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})
