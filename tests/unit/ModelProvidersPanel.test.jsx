import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ModelProvidersPanel from '../../src/components/ModelProvidersPanel.jsx'
import {
  numberOrNull, providerBaseUrlError, providerHasCredentials, providerHeadersError, providerKeyError, providerLabelError,
  providerModelsError, providerNumericFieldError,
} from '../../src/components/modelProviders/providerConfig.js'
import { formatProviderError } from '../../src/components/modelProviders/providerError.js'
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
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
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

test('empty model settings state makes the local BYOK and no-platform-billing boundary explicit', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, providers: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })

    const notice = document.querySelector('[data-testid="model-provider-byok-notice"]')
    assert.ok(notice)
    assert.match(notice.textContent, /Gugo 不提供付费模型或平台计费/)
    assert.match(document.body.textContent, /请添加你自己的本地或云端模型/)
    assert.doesNotMatch(document.body.textContent, /\.env/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

for (const scenario of [
  {
    name: 'cloud',
    preset: 'OpenAI',
    baseUrl: 'https://cloud-edit.example.test/v1',
    apiKey: 'sk-cloud-edit',
    models: 'cloud-model-a\ncloud-model-b',
    headers: '{"X-Cloud-Tenant":"tenant-a"}',
    expectedHeaders: { 'X-Cloud-Tenant': 'tenant-a' },
  },
  {
    name: 'local',
    preset: 'Ollama',
    baseUrl: 'http://127.0.0.1:22434/v1',
    apiKey: 'local-optional-key',
    models: 'local-model-a\nlocal-model-b',
    headers: '{"X-Local-Profile":"desktop"}',
    expectedHeaders: { 'X-Local-Profile': 'desktop' },
  },
]) {
  test(`${scenario.name} preset keeps URL, API key, models, and Headers visible and saves edits`, async () => {
    const dom = setupDom()
    const root = createRoot(document.getElementById('root'))
    const originalFetch = globalThis.fetch
    let submitted = null
    globalThis.fetch = async (url, init = {}) => {
      if (url !== '/api/model/providers') throw new Error(`Unexpected request: ${url}`)
      if (init.method === 'POST') {
        submitted = JSON.parse(init.body)
        return new Response(JSON.stringify({ ok: true, provider: { id: `${scenario.name}-provider`, ...submitted } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true, providers: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    try {
      await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
      await act(async () => { await Promise.resolve() })
      await act(async () => buttonByText('新增', { exact: true }).click())
      await act(async () => buttonByText(scenario.preset).click())

      const baseUrlInput = document.querySelector('input[placeholder="https://api.example.com/v1"]')
      const apiKeyInput = document.querySelector('input[type="password"]')
      const modelsInput = [...document.querySelectorAll('textarea')]
        .find((input) => input.placeholder.includes('model-a'))
      const headersInput = [...document.querySelectorAll('textarea')]
        .find((input) => input.placeholder.includes('X-Custom-Header'))
      assert.ok(baseUrlInput && apiKeyInput && modelsInput && headersInput)
      assert.equal(document.querySelector('input[placeholder="my-provider"]'), null)

      await setInputValue(baseUrlInput, scenario.baseUrl)
      await setInputValue(apiKeyInput, scenario.apiKey)
      await setInputValue(modelsInput, scenario.models)
      await setInputValue(headersInput, scenario.headers)

      const save = buttonByText('保存', { exact: true })
      assert.equal(save.disabled, false)
      await act(async () => save.click())

      assert.equal(submitted.baseUrl, scenario.baseUrl)
      assert.equal(submitted.apiKey, scenario.apiKey)
      assert.deepEqual(submitted.models, scenario.models.split('\n'))
      assert.equal(submitted.defaultModel, `${scenario.name}-model-a`)
      assert.deepEqual(submitted.headers, scenario.expectedHeaders)
    } finally {
      globalThis.fetch = originalFetch
      await act(async () => root.unmount())
      dom.window.close()
    }
  })
}

test('clicking the selected custom provider again preserves every editable field', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, providers: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())
    await act(async () => buttonByText('自定义接口', { exact: true }).click())

    const keyInput = document.querySelector('input[placeholder="my-provider"]')
    const labelInput = document.querySelector('input[placeholder="My Provider"]')
    const baseUrlInput = document.querySelector('input[placeholder="https://api.example.com/v1"]')
    const apiKeyInput = document.querySelector('input[type="password"]')
    const modelsInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('model-a'))
    assert.ok(keyInput && labelInput && baseUrlInput && apiKeyInput && modelsInput)

    await setInputValue(keyInput, 'custom-local')
    await setInputValue(labelInput, 'Custom Local')
    await setInputValue(baseUrlInput, 'http://127.0.0.1:1234/v1')
    await setInputValue(apiKeyInput, 'optional-local-key')
    await setInputValue(modelsInput, 'local-vision\nlocal-chat')

    await act(async () => buttonByText('自定义接口', { exact: true }).click())

    assert.equal(keyInput.value, 'custom-local')
    assert.equal(labelInput.value, 'Custom Local')
    assert.equal(baseUrlInput.value, 'http://127.0.0.1:1234/v1')
    assert.equal(apiKeyInput.value, 'optional-local-key')
    assert.equal(modelsInput.value, 'local-vision\nlocal-chat')
    assert.equal(buttonByText('保存', { exact: true }).disabled, false)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('clicking custom while editing a saved custom provider preserves its identity and saved key', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  const existing = {
    id: 'provider-custom-existing',
    key: 'custom-existing',
    label: 'Existing Custom',
    baseUrl: 'https://custom.example.test/v1',
    models: ['custom-model'],
    defaultModel: 'custom-model',
    enabled: true,
    isDefault: true,
    hasApiKey: true,
    headers: {},
    kind: 'openai-compatible',
    modelProfiles: {},
  }
  let submitted = null
  globalThis.fetch = async (url, init = {}) => {
    if (url !== '/api/model/providers') throw new Error(`Unexpected request: ${url}`)
    if (init.method === 'POST') {
      submitted = JSON.parse(init.body)
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
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => document.querySelector('button[aria-label="编辑 Provider"]').click())

    await act(async () => buttonByText('自定义接口', { exact: true }).click())

    assert.equal(document.querySelector('input[placeholder="my-provider"]').value, 'custom-existing')
    assert.equal(document.querySelector('input[placeholder="my-provider"]').disabled, true)
    assert.equal(document.querySelector('input[placeholder="https://api.example.com/v1"]').value, existing.baseUrl)
    assert.equal(document.querySelector('input[type="password"]').placeholder, '••••••••')
    assert.equal(buttonByText('保存', { exact: true }).disabled, false)

    await act(async () => buttonByText('保存', { exact: true }).click())
    assert.equal(submitted.id, existing.id)
    assert.equal(submitted.key, existing.key)
    assert.equal(submitted.apiKey, '')
    assert.equal(submitted.clearApiKey, false)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a cloud preset accepts custom Headers as its only credential', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  let submitted = null
  globalThis.fetch = async (url, init = {}) => {
    if (url !== '/api/model/providers') throw new Error(`Unexpected request: ${url}`)
    if (init.method === 'POST') {
      submitted = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, provider: { id: 'header-only', ...submitted } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true, providers: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())
    await act(async () => buttonByText('OpenAI').click())

    const headersInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('X-Custom-Header'))
    const save = buttonByText('保存', { exact: true })
    const discover = buttonByText('检测模型', { exact: true })
    assert.equal(save.disabled, true)
    assert.equal(discover.disabled, true)

    await setInputValue(headersInput, '{"Authorization":"Bearer header-only-secret"}')
    assert.equal(save.disabled, false)
    assert.equal(discover.disabled, false)
    await act(async () => save.click())

    assert.equal(submitted.apiKey, '')
    assert.deepEqual(submitted.headers, { Authorization: 'Bearer header-only-secret' })
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('discovery sends explicit credential clearing intent for an edited custom provider', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  const existing = {
    id: 'provider-clear-discovery',
    key: 'clear-discovery',
    label: 'Clear Discovery',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    defaultModel: 'local-model',
    enabled: true,
    isDefault: true,
    hasApiKey: true,
    headers: { 'X-Saved-Auth': '••••••' },
    kind: 'openai-compatible',
    modelProfiles: {},
  }
  let discoveryBody = null
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/model/providers/discover') {
      discoveryBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, models: ['local-model'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === '/api/model/providers') {
      return new Response(JSON.stringify({ ok: true, providers: [existing] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  try {
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => document.querySelector('button[aria-label="编辑 Provider"]').click())
    await act(async () => document.querySelector('input[type="checkbox"] + span')?.closest('label')?.querySelector('input')?.click())
    await act(async () => document.querySelector('input[aria-label="删除全部已保存的 Headers"]').click())

    const discover = buttonByText('检测模型', { exact: true })
    assert.equal(discover.disabled, false)
    await act(async () => {
      discover.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(discoveryBody.id, existing.id)
    assert.equal(discoveryBody.apiKey, '')
    assert.deepEqual(discoveryBody.headers, {})
    assert.equal(discoveryBody.clearApiKey, true)
    assert.equal(discoveryBody.clearHeaders, true)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('provider discovery errors remain visible inside the open editor', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/model/providers/discover' && init.method === 'POST') {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'MODEL_PROVIDER_UNAVAILABLE', message: 'endpoint offline' },
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === '/api/model/providers') {
      return new Response(JSON.stringify({ ok: true, providers: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  try {
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())
    await setInputValue(
      document.querySelector('input[placeholder="https://api.example.com/v1"]'),
      'http://127.0.0.1:1234/v1',
    )
    await act(async () => {
      buttonByText('检测模型', { exact: true }).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const editor = document.querySelector('[data-modal-layer="nested"]')
    const editorMessage = document.querySelector('[data-model-provider-editor-message]')
    assert.ok(editor && editorMessage)
    assert.equal(editor.contains(editorMessage), true)
    assert.match(editorMessage.textContent, /不可用|连接|offline/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('switching cloud presets clears credentials, Headers, and stale model configuration', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, providers: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())
    await act(async () => buttonByText('OpenAI').click())

    await setInputValue(document.querySelector('input[type="password"]'), 'sk-must-not-cross-provider')
    await setInputValue(
      [...document.querySelectorAll('textarea')].find((input) => input.placeholder.includes('model-a')),
      'stale-openai-model',
    )
    await setInputValue(
      [...document.querySelectorAll('textarea')].find((input) => input.placeholder.includes('X-Custom-Header')),
      '{"Authorization":"Bearer stale-provider-secret"}',
    )

    await act(async () => buttonByText('Anthropic Claude').click())

    const baseUrlInput = document.querySelector('input[placeholder="https://api.example.com/v1"]')
    const apiKeyInput = document.querySelector('input[type="password"]')
    const modelsInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('model-a'))
    const headersInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('X-Custom-Header'))
    assert.equal(baseUrlInput.value, 'https://api.anthropic.com')
    assert.equal(apiKeyInput.value, '')
    assert.equal(headersInput.value, '')
    assert.equal(modelsInput.value, 'claude-opus-4-8\nclaude-sonnet-4-6\nclaude-haiku-4-5')
    assert.equal(buttonByText('保存', { exact: true }).disabled, true)
    assert.doesNotMatch(document.body.textContent, /stale-openai-model|stale-provider-secret/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a stale discovery response cannot overwrite a provider selected afterwards', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  let resolveDiscovery
  let markDiscoveryStarted
  const discoveryStarted = new Promise((resolve) => { markDiscoveryStarted = resolve })
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/model/providers/discover' && init.method === 'POST') {
      markDiscoveryStarted()
      return new Promise((resolve) => { resolveDiscovery = resolve })
    }
    if (url === '/api/model/providers') {
      return new Response(JSON.stringify({ ok: true, providers: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  try {
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())
    await act(async () => buttonByText('OpenAI').click())
    await setInputValue(document.querySelector('input[type="password"]'), 'sk-openai-discovery')

    await act(async () => {
      buttonByText('检测模型', { exact: true }).click()
      await discoveryStarted
    })
    await act(async () => buttonByText('DeepSeek').click())

    await act(async () => {
      resolveDiscovery(new Response(JSON.stringify({
        ok: true,
        models: ['late-openai-model'],
        kind: 'openai-compatible',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const baseUrlInput = document.querySelector('input[placeholder="https://api.example.com/v1"]')
    const apiKeyInput = document.querySelector('input[type="password"]')
    const modelsInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('model-a'))
    assert.equal(baseUrlInput.value, 'https://api.deepseek.com')
    assert.equal(apiKeyInput.value, '')
    assert.equal(modelsInput.value, 'deepseek-v4-flash\ndeepseek-v4-flash-0731\ndeepseek-v4-pro')
    assert.doesNotMatch(modelsInput.value, /late-openai-model/)
    assert.equal(buttonByText('保存', { exact: true }).disabled, true)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a saved provider still broadcasts catalog changes when the follow-up refresh fails', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  let getCount = 0
  let onChangedCount = 0
  let eventCount = 0
  window.addEventListener('model-providers:changed', () => { eventCount += 1 })
  globalThis.fetch = async (url, init = {}) => {
    if (url !== '/api/model/providers') throw new Error(`Unexpected request: ${url}`)
    if (init.method === 'POST') {
      const submitted = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, provider: { id: 'saved-provider', ...submitted } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    getCount += 1
    if (getCount === 1) {
      return new Response(JSON.stringify({ ok: true, providers: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: { message: 'refresh unavailable' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await act(async () => root.render(
      <I18nProvider><ModelProvidersPanel
        onChanged={() => { onChangedCount += 1 }}
      /></I18nProvider>,
    ))
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())
    await act(async () => buttonByText('OpenAI').click())
    await setInputValue(document.querySelector('input[type="password"]'), 'sk-save-before-refresh')

    await act(async () => {
      buttonByText('保存', { exact: true }).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(getCount, 2)
    assert.equal(onChangedCount, 1)
    assert.equal(eventCount, 1)
    assert.match(document.body.textContent, /已保存模型配置/)
    assert.match(document.body.textContent, /无法连接模型服务/)
    assert.match(document.body.textContent, /HTTP 503/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a return flow tests the saved default model and only signals ready after Agent readiness is persisted', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  const requestOrder = []
  let provider = null
  let testedBody = null
  let onReadyPayload = null
  const readiness = {
    configRevision: 1,
    checkedAt: Date.now(),
    chat: true,
    tools: true,
    agent: true,
    mode: 'agent',
  }
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/model/providers' && init.method === 'POST') {
      requestOrder.push('save')
      const submitted = JSON.parse(init.body)
      provider = {
        ...submitted,
        id: 'return-ready-provider',
        configRevision: 1,
        hasApiKey: true,
        headers: {},
        readiness: null,
        modelReadiness: {},
      }
      return new Response(JSON.stringify({ ok: true, provider }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === '/api/model/providers/return-ready-provider/test') {
      requestOrder.push('test')
      testedBody = JSON.parse(init.body)
      provider = {
        ...provider,
        readiness,
        modelReadiness: { [testedBody.modelName]: readiness },
      }
      return new Response(JSON.stringify({
        ok: true,
        modelName: testedBody.modelName,
        capabilities: readiness,
        readiness,
        provider,
        steps: [
          { name: 'completion', label: '模型可以正常回复', ok: true },
          { name: 'tools', label: '支持工具调用（Agent 任务需要）', ok: true },
        ],
        profile: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === '/api/model/providers') {
      return new Response(JSON.stringify({ ok: true, providers: provider ? [provider] : [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  try {
    await act(async () => root.render(
      <I18nProvider><ModelProvidersPanel onReady={(payload) => {
        requestOrder.push('ready')
        onReadyPayload = payload
      }} /></I18nProvider>,
    ))
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())
    await act(async () => buttonByText('OpenAI').click())
    await setInputValue(document.querySelector('input[type="password"]'), 'sk-return-ready')

    await act(async () => {
      buttonByText('保存', { exact: true }).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.deepEqual(requestOrder, ['save', 'test', 'ready'])
    assert.deepEqual(testedBody, { modelName: 'gpt-5.6-sol' })
    assert.equal(onReadyPayload?.provider?.id, 'return-ready-provider')
    assert.equal(onReadyPayload?.modelName, 'gpt-5.6-sol')
    assert.equal(onReadyPayload?.readiness?.mode, 'agent')
    assert.match(document.body.textContent, /已通过 Agent 就绪测试/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a return flow stays in model settings when the saved model is chat-only', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  let provider = null
  let onReadyCount = 0
  const readiness = {
    configRevision: 1,
    checkedAt: Date.now(),
    chat: true,
    tools: false,
    agent: false,
    mode: 'chat_only',
  }
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/model/providers' && init.method === 'POST') {
      const submitted = JSON.parse(init.body)
      provider = {
        ...submitted,
        id: 'return-chat-only-provider',
        configRevision: 1,
        hasApiKey: true,
        headers: {},
        readiness: null,
        modelReadiness: {},
      }
      return new Response(JSON.stringify({ ok: true, provider }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === '/api/model/providers/return-chat-only-provider/test') {
      const { modelName } = JSON.parse(init.body)
      provider = { ...provider, readiness, modelReadiness: { [modelName]: readiness } }
      return new Response(JSON.stringify({
        ok: true,
        modelName,
        capabilities: readiness,
        readiness,
        provider,
        steps: [
          { name: 'completion', label: '模型可以正常回复', ok: true },
          {
            name: 'tools',
            label: '支持工具调用（Agent 任务需要）',
            ok: false,
            advisory: true,
            hint: '当前模型不能可靠执行 Agent 工具。',
          },
        ],
        profile: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === '/api/model/providers') {
      return new Response(JSON.stringify({ ok: true, providers: provider ? [provider] : [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  try {
    await act(async () => root.render(
      <I18nProvider><ModelProvidersPanel onReady={() => { onReadyCount += 1 }} /></I18nProvider>,
    ))
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())
    await act(async () => buttonByText('OpenAI').click())
    await setInputValue(document.querySelector('input[type="password"]'), 'sk-return-chat-only')

    await act(async () => {
      buttonByText('保存', { exact: true }).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(onReadyCount, 0)
    assert.match(document.body.textContent, /文本回复可用，但不支持 Agent 所需的工具调用/)
    assert.match(document.body.textContent, /当前模型不能可靠执行 Agent 工具/)
    assert.match(document.body.textContent, /仅支持聊天/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a deleted provider still broadcasts catalog changes when the follow-up refresh fails', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  let getCount = 0
  let deleteCount = 0
  let onChangedCount = 0
  let onReadyCount = 0
  let eventCount = 0
  window.confirm = () => true
  window.addEventListener('model-providers:changed', () => { eventCount += 1 })
  const provider = {
    id: 'provider-to-delete',
    key: 'provider-to-delete',
    label: 'Provider To Delete',
    baseUrl: 'https://delete.example.test/v1',
    models: ['delete-model'],
    defaultModel: 'delete-model',
    enabled: true,
    isDefault: true,
  }
  globalThis.fetch = async (url, init = {}) => {
    if (url === `/api/model/providers/${provider.id}` && init.method === 'DELETE') {
      deleteCount += 1
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url !== '/api/model/providers') throw new Error(`Unexpected request: ${url}`)
    getCount += 1
    if (getCount === 1) {
      return new Response(JSON.stringify({ ok: true, providers: [provider] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: { message: 'refresh unavailable' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await act(async () => root.render(
      <I18nProvider><ModelProvidersPanel
        onChanged={() => { onChangedCount += 1 }}
        onReady={() => { onReadyCount += 1 }}
      /></I18nProvider>,
    ))
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      document.querySelector('button[aria-label="删除 Provider"]').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(deleteCount, 1)
    assert.equal(getCount, 2)
    assert.equal(onChangedCount, 1)
    assert.equal(onReadyCount, 0)
    assert.equal(eventCount, 1)
    assert.match(document.body.textContent, /无法连接模型服务/)
    assert.match(document.body.textContent, /HTTP 503/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('saved provider Headers show only masked keys and can be explicitly cleared', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const existing = {
    id: 'provider-private',
    key: 'private-provider',
    label: 'Private Provider',
    baseUrl: 'https://private.example.test/v1',
    models: ['private-model'],
    defaultModel: 'private-model',
    enabled: true,
    isDefault: true,
    hasApiKey: false,
    headers: { Authorization: 'Bearer should-never-render', 'X-Tenant': 'private-tenant' },
    kind: 'openai-compatible',
    contextWindow: null,
    modelProfiles: {},
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
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
    await act(async () => document.querySelector('button[aria-label="编辑 Provider"]').click())

    const savedHeaders = document.querySelector('[data-saved-provider-headers]')
    assert.ok(savedHeaders)
    assert.match(savedHeaders.textContent, /Authorization: ••••••••/)
    assert.match(savedHeaders.textContent, /X-Tenant: ••••••••/)
    assert.doesNotMatch(document.body.textContent, /should-never-render|private-tenant/)
    const headersInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('X-Custom-Header'))
    assert.ok(headersInput)
    assert.equal(headersInput.value, '')

    const clearHeaders = document.querySelector('input[aria-label="删除全部已保存的 Headers"]')
    assert.ok(clearHeaders)
    await act(async () => clearHeaders.click())
    assert.equal(clearHeaders.checked, true)

    const save = buttonByText('保存', { exact: true })
    assert.ok(save)
    assert.equal(save.disabled, false)
    await act(async () => save.click())

    assert.equal(Object.hasOwn(submitted, 'headers'), true)
    assert.deepEqual(submitted.headers, {})
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('editing a saved provider can remove one Header and submit updates without echoing stored secrets', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const existing = {
    id: 'provider-header-updates',
    key: 'header-updates',
    label: 'Header updates',
    baseUrl: 'https://headers.example.test/v1',
    models: ['header-model'],
    defaultModel: 'header-model',
    enabled: true,
    isDefault: true,
    hasApiKey: false,
    headers: { Authorization: '••••••', 'X-Tenant': '••••••' },
    kind: 'openai-compatible',
    contextWindow: null,
    modelProfiles: {},
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsPdf: false,
    firstTokenTimeoutMs: null,
    idleTimeoutMs: null,
    failoverEnabled: null,
    keepAlive: null,
  }
  let submitted = null
  let discoveryBody = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/api/model/providers/discover') {
      discoveryBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, models: ['header-model'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url !== '/api/model/providers') throw new Error(`Unexpected request: ${url}`)
    if (init.method === 'POST') {
      submitted = JSON.parse(init.body)
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
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => document.querySelector('button[aria-label="编辑 Provider"]').click())

    const headersInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('X-Custom-Header'))
    assert.ok(headersInput)
    assert.equal(headersInput.value, '')
    const removeAuthorization = document.querySelector('button[aria-label="删除已保存的 Header：Authorization"]')
    assert.ok(removeAuthorization)
    await act(async () => removeAuthorization.click())
    const restoreAuthorization = document.querySelector('button[aria-label="撤销删除 Header：Authorization"]')
    assert.ok(restoreAuthorization)
    await act(async () => restoreAuthorization.click())
    await act(async () => document.querySelector('button[aria-label="删除已保存的 Header：Authorization"]').click())
    await setInputValue(headersInput, '{"X-Tenant":"tenant-b","X-Trace":"trace-new"}')
    await act(async () => {
      buttonByText('检测模型', { exact: true }).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.deepEqual(discoveryBody.removeHeaderKeys, ['Authorization'])
    assert.deepEqual(discoveryBody.headers, {
      'X-Tenant': 'tenant-b',
      'X-Trace': 'trace-new',
    })
    await act(async () => buttonByText('保存', { exact: true }).click())

    assert.equal(Object.hasOwn(submitted, 'headers'), false)
    assert.deepEqual(submitted.removeHeaderKeys, ['Authorization'])
    assert.deepEqual(submitted.headerUpdates, {
      'X-Tenant': 'tenant-b',
      'X-Trace': 'trace-new',
    })
    assert.doesNotMatch(JSON.stringify(submitted), /stored-secret|tenant-a|••••••/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('provider editor blocks missing required fields and invalid Provider IDs', async () => {
  assert.equal(providerKeyError(''), 'required')
  assert.equal(providerKeyError('1-provider'), 'invalid')
  assert.equal(providerKeyError('valid-provider_1'), '')
  assert.equal(providerLabelError('  '), 'required')
  assert.equal(providerModelsError('\n,  '), 'required')

  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, providers: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await act(async () => {
      root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>)
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())

    const keyInput = document.querySelector('input[placeholder="my-provider"]')
    const labelInput = document.querySelector('input[placeholder="My Provider"]')
    const baseUrlInput = document.querySelector('input[placeholder="https://api.example.com/v1"]')
    const modelsInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('model-a'))
    assert.ok(keyInput && labelInput && baseUrlInput && modelsInput)
    assert.match(buttonByText('自定义接口', { exact: true }).className, /border-accent/)
    assert.equal(keyInput.getAttribute('aria-invalid'), 'true')
    assert.equal(labelInput.getAttribute('aria-invalid'), 'true')
    assert.equal(baseUrlInput.getAttribute('aria-invalid'), 'true')
    assert.equal(modelsInput.getAttribute('aria-invalid'), 'true')
    assert.equal(document.querySelectorAll('[role="alert"]').length, 4)
    assert.equal(buttonByText('保存', { exact: true }).disabled, true)

    await setInputValue(keyInput, '1-invalid')
    await setInputValue(labelInput, 'Valid Label')
    await setInputValue(baseUrlInput, 'https://valid.example.test/v1')
    await setInputValue(modelsInput, 'valid-model')
    assert.match(document.body.textContent, /Provider ID · a-z first/)
    assert.equal(buttonByText('保存', { exact: true }).disabled, true)

    await setInputValue(keyInput, 'valid-provider')
    assert.equal(keyInput.getAttribute('aria-invalid'), 'false')
    assert.equal(buttonByText('保存', { exact: true }).disabled, false)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('provider Headers validation classifies malformed JSON, non-objects, names, and line breaks', () => {
  assert.equal(providerHeadersError(''), '')
  assert.equal(providerHeadersError('{'), 'json')
  assert.equal(providerHeadersError('[]'), 'type')
  assert.equal(providerHeadersError('"Bearer token"'), 'type')
  assert.equal(providerHeadersError('null'), 'type')
  assert.equal(providerHeadersError(JSON.stringify({ 'Bad Header': 'value' })), 'name')
  assert.equal(providerHeadersError(JSON.stringify({ 'Bad:Header': 'value' })), 'name')
  assert.equal(providerHeadersError(JSON.stringify({ 'X-Test': 'line 1\nline 2' })), 'value')
  assert.equal(providerHeadersError(JSON.stringify({ 'X-Test': 'line 1\rline 2' })), 'value')
  assert.equal(providerHeadersError(JSON.stringify({ Authorization: 'Bearer token', 'X-Tenant_1': 'tenant' })), '')
})

test('credential readiness excludes saved Headers that are pending removal', () => {
  assert.equal(providerHasCredentials({
    savedHeaderKeys: ['Authorization'],
    removedHeaderKeys: ['authorization'],
  }), false)
  assert.equal(providerHasCredentials({
    savedHeaderKeys: ['Authorization', 'X-Tenant'],
    removedHeaderKeys: ['AUTHORIZATION'],
  }), true)
  assert.equal(providerHasCredentials({
    savedHeaderKeys: ['Authorization'],
    removedHeaderKeys: ['authorization'],
    headersText: '{"X-Replacement":"secret"}',
  }), true)
})

test('provider editor displays Headers errors and blocks save and discovery until fixed', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, providers: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())

    const keyInput = document.querySelector('input[placeholder="my-provider"]')
    const labelInput = document.querySelector('input[placeholder="My Provider"]')
    const baseUrlInput = document.querySelector('input[placeholder="https://api.example.com/v1"]')
    const modelsInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('model-a'))
    const headersInput = [...document.querySelectorAll('textarea')]
      .find((input) => input.placeholder.includes('X-Custom-Header'))
    assert.ok(keyInput && labelInput && baseUrlInput && modelsInput && headersInput)

    await setInputValue(keyInput, 'headers-validation')
    await setInputValue(labelInput, 'Headers Validation')
    await setInputValue(baseUrlInput, 'https://headers-validation.example.test/v1')
    await setInputValue(modelsInput, 'headers-model')

    const save = buttonByText('保存', { exact: true })
    const discover = buttonByText('检测模型', { exact: true })
    assert.equal(save.disabled, false)
    assert.equal(discover.disabled, false)

    for (const [value, message] of [
      ['{', /Headers 必须是有效的 JSON/],
      ['[]', /Headers 必须是 JSON 对象/],
      ['"Bearer token"', /Headers 必须是 JSON 对象/],
      ['null', /Headers 必须是 JSON 对象/],
      [JSON.stringify({ 'Bad Header': 'value' }), /Header 名称无效/],
      [JSON.stringify({ 'X-Test': 'line 1\nline 2' }), /Header 值不能包含换行/],
      [JSON.stringify({ 'X-Test': 'line 1\rline 2' }), /Header 值不能包含换行/],
    ]) {
      await setInputValue(headersInput, value)
      assert.equal(headersInput.getAttribute('aria-invalid'), 'true')
      assert.match(document.body.textContent, message)
      assert.equal(save.disabled, true)
      assert.equal(discover.disabled, true)
    }

    await setInputValue(headersInput, '{"Authorization":"Bearer token"}')
    assert.equal(headersInput.getAttribute('aria-invalid'), 'false')
    assert.equal(save.disabled, false)
    assert.equal(discover.disabled, false)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

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

test('provider Base URL validation blocks credentials, query parameters, and fragments in the editor', async () => {
  assert.equal(providerBaseUrlError('https://user:secret@example.com/v1'), 'credentials')
  assert.equal(providerBaseUrlError('https://@example.com/v1'), 'credentials')
  assert.equal(providerBaseUrlError('https://example.com/v1?token=secret'), 'query')
  assert.equal(providerBaseUrlError('https://example.com/v1#secret'), 'fragment')
  assert.equal(providerBaseUrlError('https://example.com/v1'), '')

  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, providers: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await act(async () => {
      root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>)
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => buttonByText('新增', { exact: true }).click())
    await act(async () => buttonByText('自定义接口', { exact: true }).click())

    const baseUrlInput = document.querySelector('input[placeholder="https://api.example.com/v1"]')
    assert.ok(baseUrlInput)
    await setInputValue(baseUrlInput, 'https://user:secret@example.com/v1')

    assert.equal(baseUrlInput.getAttribute('aria-invalid'), 'true')
    assert.match(document.body.textContent, /不能包含用户名或密码/)
    assert.equal(buttonByText('检测模型', { exact: true }).disabled, true)
    assert.equal(buttonByText('保存', { exact: true }).disabled, true)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('provider errors replace bare HTTP failures with actionable localized guidance', () => {
  const t = (key) => ({
    'modelProviders.errorUnavailable': '无法连接模型服务，请检查服务地址和运行状态。',
    'modelProviders.errorAuth': '模型服务拒绝了凭据。',
    'modelProviders.errorConfigMissing': '模型服务尚未配置。',
    'modelProviders.errorNotFound': '找不到模型端点或模型。',
    'modelProviders.errorTimeout': '连接模型服务超时。',
    'modelProviders.errorRateLimited': '模型服务请求过多。',
    'modelProviders.errorUnknown': '模型服务操作失败。',
  }[key] || key)

  assert.equal(
    formatProviderError(Object.assign(new Error('HTTP 502'), { status: 502 }), t),
    '无法连接模型服务，请检查服务地址和运行状态。 (HTTP 502)',
  )
  assert.equal(
    formatProviderError(Object.assign(new Error('request failed'), {
      status: 502,
      payload: { endpoint: { errorCode: 'MODEL_ENDPOINT_UNREACHABLE' } },
    }), t),
    '无法连接模型服务，请检查服务地址和运行状态。 (HTTP 502)',
  )
  assert.equal(
    formatProviderError(Object.assign(new Error('invalid secret'), {
      status: 502,
      payload: { steps: [{ ok: false, errorCode: 'PROVIDER_AUTH_FAILED' }] },
    }), t),
    '模型服务拒绝了凭据。 (HTTP 502)',
  )
})

test('provider readiness and saved API key controls render localized labels instead of internal keys', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  const readinessModes = ['agent', 'chat_only', 'unavailable', null]
  const providers = readinessModes.map((mode, index) => ({
    id: `provider-${index}`,
    key: `provider-${index}`,
    label: `Provider ${index}`,
    baseUrl: `https://provider-${index}.example/v1`,
    models: [`model-${index}`],
    defaultModel: `model-${index}`,
    enabled: true,
    isDefault: index === 0,
    hasApiKey: index === 0,
    headers: {},
    kind: 'openai-compatible',
    contextWindow: null,
    modelProfiles: {},
    supportsTools: true,
    supportsStreaming: true,
    supportsVision: false,
    supportsPdf: false,
    firstTokenTimeoutMs: null,
    idleTimeoutMs: null,
    failoverEnabled: null,
    keepAlive: null,
    readiness: mode ? { mode } : null,
  }))
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, providers }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await act(async () => {
      root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>)
    })
    await act(async () => { await Promise.resolve() })

    assert.match(document.body.textContent, /Agent 可用/)
    assert.match(document.body.textContent, /仅支持聊天/)
    assert.match(document.body.textContent, /不可用/)
    assert.match(document.body.textContent, /尚未测试/)
    assert.doesNotMatch(document.body.textContent, /readiness(?:Agent|ChatOnly|Unavailable|Untested)/)

    await act(async () => document.querySelector('button[aria-label="编辑 Provider"]').click())
    assert.match(document.body.textContent, /删除已保存的 API Key/)
    assert.match(document.body.textContent, /保存后会从本机服务端删除这个 Provider 的现有 API Key/)
    assert.doesNotMatch(document.body.textContent, /clearApiKey(?:Hint)?/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('provider diagnostics test the model selected in the provider row', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  const revision = 3
  const ready = { configRevision: revision, chat: true, tools: true, agent: true, mode: 'agent' }
  const chatOnly = { configRevision: revision, chat: true, tools: false, agent: false, mode: 'chat_only' }
  const provider = {
    id: 'provider-per-model-ui',
    key: 'per-model-ui',
    label: 'Per-model UI',
    baseUrl: 'https://per-model-ui.example/v1',
    models: ['default-model', 'target-model'],
    defaultModel: 'default-model',
    enabled: true,
    isDefault: true,
    hasApiKey: true,
    headers: {},
    configRevision: revision,
    readiness: ready,
    modelReadiness: { 'default-model': ready, 'target-model': chatOnly },
  }
  let testedBody = null
  globalThis.fetch = async (url, init = {}) => {
    if (url === `/api/model/providers/${provider.id}/test`) {
      testedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({
        ok: true,
        modelName: testedBody.modelName,
        steps: [],
        profile: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === '/api/model/providers') {
      return new Response(JSON.stringify({ ok: true, providers: [provider] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  try {
    await act(async () => {
      root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>)
    })
    await act(async () => { await Promise.resolve() })

    const modelSelect = document.querySelector('select[aria-label^="测试模型"]')
    assert.ok(modelSelect)
    assert.equal(modelSelect.value, 'default-model')
    await act(async () => {
      modelSelect.value = 'target-model'
      modelSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    assert.match(document.body.textContent, /仅支持聊天/)

    await act(async () => {
      buttonByText('测试', { exact: true }).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.deepEqual(testedBody, { modelName: 'target-model' })
    assert.match(document.body.textContent, /目标：target-model/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('provider numeric helpers reject lossy or unsafe values instead of normalizing them', () => {
  assert.equal(providerNumericFieldError('1023', 'contextWindow')?.reason, 'min')
  assert.equal(providerNumericFieldError('1024.5', 'contextWindow')?.reason, 'integer')
  assert.equal(providerNumericFieldError('999', 'firstTokenTimeoutMs')?.reason, 'min')
  assert.equal(providerNumericFieldError('9007199254740992', 'idleTimeoutMs')?.reason, 'safeInteger')
  assert.equal(providerNumericFieldError('1024', 'contextWindow'), null)
  assert.equal(numberOrNull(' 4096 ', 'contextWindow'), 4096)
  assert.throws(
    () => numberOrNull('1024.5', 'contextWindow'),
    (error) => error?.code === 'MODEL_PROVIDER_NUMERIC_FIELD_INVALID'
      && error?.field === 'contextWindow'
      && error?.reason === 'integer',
  )
})

test('provider editor blocks invalid numeric fields and submits corrected integer values', async () => {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  const originalFetch = globalThis.fetch
  const baseProvider = {
    baseUrl: 'https://numeric.example.test/v1',
    models: ['model-a', 'model-b'],
    defaultModel: 'model-a',
    enabled: true,
    isDefault: false,
    hasApiKey: false,
    headers: {},
    kind: 'openai-compatible',
  }
  const invalidProvider = {
    ...baseProvider,
    id: 'numeric-invalid',
    key: 'numeric-invalid',
    label: 'Numeric invalid',
    contextWindow: 1023,
    firstTokenTimeoutMs: 999,
    idleTimeoutMs: '9007199254740992',
    modelProfiles: { 'model-a': { contextWindow: 1023 }, 'model-b': { contextWindow: 1024.5 } },
  }
  const correctedProvider = {
    ...baseProvider,
    id: 'numeric-corrected',
    key: 'numeric-corrected',
    label: 'Numeric corrected',
    contextWindow: 4096,
    firstTokenTimeoutMs: 1000,
    idleTimeoutMs: 120000,
    modelProfiles: { 'model-a': { contextWindow: 2048 }, 'model-b': { contextWindow: 4096 } },
  }
  let submitted = null
  globalThis.fetch = async (url, init = {}) => {
    if (url !== '/api/model/providers') throw new Error(`Unexpected request: ${url}`)
    if (init.method === 'POST') {
      submitted = JSON.parse(init.body)
      return new Response(JSON.stringify({ ok: true, provider: submitted }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true, providers: [invalidProvider, correctedProvider] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
    await act(async () => { await Promise.resolve() })
    await act(async () => document.querySelectorAll('button[aria-label="编辑 Provider"]')[0].click())

    const invalidNumericInputs = [...document.querySelectorAll('input[type="number"]')]
    assert.equal(invalidNumericInputs.filter((input) => input.getAttribute('aria-invalid') === 'true').length, 5)
    assert.equal(buttonByText('保存', { exact: true }).disabled, true)

    const dialog = document.querySelector('[role="dialog"]')
    await act(async () => dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })))
    await act(async () => document.querySelectorAll('button[aria-label="编辑 Provider"]')[1].click())

    const correctedNumericInputs = [...document.querySelectorAll('input[type="number"]')]
    assert.equal(correctedNumericInputs.every((input) => input.getAttribute('aria-invalid') === 'false'), true)
    const save = buttonByText('保存', { exact: true })
    assert.equal(save.disabled, false)
    await act(async () => save.click())

    assert.equal(submitted.contextWindow, 4096)
    assert.equal(submitted.firstTokenTimeoutMs, 1000)
    assert.equal(submitted.idleTimeoutMs, 120000)
    assert.equal(submitted.modelProfiles['model-a'].contextWindow, 2048)
    assert.equal(submitted.modelProfiles['model-b'].contextWindow, 4096)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})
