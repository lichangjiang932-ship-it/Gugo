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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function buttonByText(text, { exact = false } = {}) {
  return [...document.querySelectorAll('button')].find((button) => (
    exact ? button.textContent.trim() === text : button.textContent.includes(text)
  )) || null
}

function byAriaLabel(elements, label) {
  return [...elements].find((element) => element.getAttribute('aria-label') === label) || null
}

function knowledgeBase() {
  return document.querySelector('[data-testid="provider-knowledge-base"]')
}

function knowledgeBaseStatus() {
  return document.querySelector('[data-testid="provider-knowledge-base-status"]')
}

function catalogueModelRows() {
  return [...(knowledgeBase()?.querySelectorAll('li') || [])]
}

function knowledgeBaseButton(text) {
  return buttonByTextIn(knowledgeBase(), text)
}

function buttonByTextIn(scope, text) {
  return [...scope.querySelectorAll('button')].find((button) => button.textContent.includes(text)) || null
}

async function renderPanel() {
  const dom = setupDom()
  const root = createRoot(document.getElementById('root'))
  await act(async () => root.render(<I18nProvider><ModelProvidersPanel /></I18nProvider>))
  await act(async () => { await Promise.resolve() })
  return { dom, root }
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

async function click(element) {
  assert.ok(element, 'the control to click exists')
  await act(async () => {
    element.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const BUNDLED_STATUS = {
  available: true,
  source: 'bundled',
  providers: 226,
  models: 8154,
  generatedAt: '2026-10-07',
  refreshedAt: 0,
  error: '',
}

const BEDROCK_MODELS = [
  { id: 'global.anthropic.claude-opus-4-8', name: 'Claude Opus 4.8 (Global)', context: 200000, output: 32000, tools: true, vision: true, pdf: false, reasoning: false },
  { id: 'global.openai.gpt-6.1-sol', name: 'GPT-6.1 Sol (Global)', context: 1050000, output: 128000, tools: true, vision: false, pdf: false, reasoning: true },
  { id: 'legacy.titan-text', name: 'Titan Text', context: 8000, output: 2000, tools: false, vision: false, pdf: false, reasoning: false, deprecated: true },
]

/**
 * Every test answers the two calls the panel makes on its own.
 *
 * Routes are matched on the path alone: the provider index is requested with a
 * query string (`?providers=1`), so matching the full URL would make every test
 * that does not care about the index fail as an unexpected request.
 */
function panelFetch(routes) {
  return async (url, init = {}) => {
    const path = String(url).split('?')[0]
    const handler = routes[path]
    if (!handler) throw new Error(`Unexpected request: ${init.method || 'GET'} ${url}`)
    return handler(init, String(url))
  }
}

test('the picker shows where the knowledge base comes from and what it holds', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = panelFetch({
    '/api/model/catalog': () => jsonResponse({ ok: true, catalog: BUNDLED_STATUS }),
    '/api/model/providers': () => jsonResponse({ ok: true, providers: [] }),
  })
  const { dom, root } = await renderPanel()

  try {
    await click(buttonByText('新增', { exact: true }))

    const status = knowledgeBaseStatus()
    assert.ok(status, 'the picker reports the knowledge base it reads from')
    assert.equal(status.querySelector('[data-catalog-source]').getAttribute('data-catalog-source'), 'bundled')
    assert.match(status.textContent, /随应用发布的快照/)
    assert.match(status.textContent, /226 个供应商 · 8154 个模型/)
    assert.match(status.textContent, /2026-10-07/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a provider the bundled presets never had can be chosen, given an endpoint and key, and saved', async () => {
  const originalFetch = globalThis.fetch
  let submitted = null
  let savedProvider = null
  let catalogueRequests = 0
  globalThis.fetch = panelFetch({
    '/api/model/catalog': () => jsonResponse({ ok: true, catalog: BUNDLED_STATUS }),
    '/api/model/catalog/amazon-bedrock': () => {
      catalogueRequests += 1
      return jsonResponse({
        ok: true,
        provider: { id: 'amazon-bedrock', name: 'Amazon Bedrock' },
        models: BEDROCK_MODELS,
        catalog: BUNDLED_STATUS,
      })
    },
    '/api/model/providers': (init) => {
      if (init.method !== 'POST') return jsonResponse({ ok: true, providers: savedProvider ? [savedProvider] : [] })
      submitted = JSON.parse(init.body)
      savedProvider = { id: 'provider-bedrock', configRevision: 1, ...submitted }
      return jsonResponse({ ok: true, provider: savedProvider })
    },
    '/api/model/providers/provider-bedrock/test': () => jsonResponse({ ok: true, modelName: submitted?.defaultModel, steps: [], profile: null }),
  })
  const { dom, root } = await renderPanel()

  try {
    await click(buttonByText('新增', { exact: true }))
    // amazon-bedrock has no bundled preset: before the knowledge base, the
    // settings screen could not offer this provider at all.
    const search = document.querySelector('input[placeholder="输入供应商 ID"]')
    assert.ok(search, 'the picker searches the knowledge base by provider ID')
    await setInputValue(search, 'amazon-bedrock')
    await click(buttonByText('使用供应商 ID：amazon-bedrock'))

    assert.equal(knowledgeBaseStatus(), null, 'choosing a provider closes the picker')
    assert.equal(knowledgeBase().querySelector('[data-catalog-provider-id]').textContent, 'amazon-bedrock')
    assert.equal(document.querySelector('input[placeholder="my-provider"]').value, 'amazon-bedrock')
    // Typed in by hand, so the display name stays the id the reader chose.
    assert.equal(document.querySelector('input[placeholder="My Provider"]').value, 'amazon-bedrock')

    // Bedrock authenticates differently from every bundled preset, so its endpoint
    // is asked for rather than guessed, and save stays blocked until it is valid.
    const baseUrl = document.querySelector('input[placeholder="https://api.example.com/v1"]')
    assert.ok(baseUrl, 'a catalogue-only provider asks for its service URL')
    const save = buttonByText('保存', { exact: true })
    assert.equal(save.disabled, true)

    // Opening the provider already asked the knowledge base for its models.
    assert.equal(catalogueRequests, 1)
    assert.equal(catalogueModelRows().length, 3)
    const rows = catalogueModelRows()
    assert.match(rows[0].textContent, /global\.anthropic\.claude-opus-4-8/)
    assert.match(rows[0].textContent, /上下文 200K/)
    assert.match(rows[0].textContent, /图片/)
    assert.match(rows[0].textContent, /工具/)
    assert.match(rows[1].textContent, /上下文 1\.1M/)
    assert.match(rows[2].textContent, /已废弃/, 'a retired id is still listed, clearly flagged')

    await click(byAriaLabel(knowledgeBase().querySelectorAll('button'), '把 legacy.titan-text 加入模型列表'))
    await click(knowledgeBaseButton('加入其余 2 个模型'))
    assert.match(document.querySelector('[data-model-provider-catalog-message]').textContent, /已加入 2 个模型/)

    // Manual entry keeps working beside the fetched list.
    const manual = byAriaLabel(knowledgeBase().querySelectorAll('input'), '添加模型')
    await setInputValue(manual, 'bedrock-manual-model')
    await click(knowledgeBaseButton('添加模型'))

    await setInputValue(baseUrl, 'https://bedrock-runtime.us-east-1.amazonaws.com/v1')
    await setInputValue(document.querySelector('input[type="password"]'), 'bedrock-test-key')

    assert.equal(save.disabled, false)
    await click(save)

    assert.equal(submitted.key, 'amazon-bedrock')
    // The reader typed the id, so the display name is the id they typed; the
    // catalogue's own name is used when a provider is picked from the list.
    assert.equal(submitted.label, 'amazon-bedrock')
    assert.equal(submitted.baseUrl, 'https://bedrock-runtime.us-east-1.amazonaws.com/v1')
    assert.equal(submitted.apiKey, 'bedrock-test-key')
    assert.deepEqual(submitted.models, [
      'legacy.titan-text',
      'global.anthropic.claude-opus-4-8',
      'global.openai.gpt-6.1-sol',
      'bedrock-manual-model',
    ])
    assert.equal(submitted.defaultModel, 'legacy.titan-text')
    // The knowledge-base selection is screen state, not provider configuration.
    assert.equal('catalogProviderId' in submitted, false)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a failed refresh reports why and leaves the provider picker fully usable', async () => {
  const originalFetch = globalThis.fetch
  let refreshes = 0
  globalThis.fetch = panelFetch({
    '/api/model/catalog': () => jsonResponse({ ok: true, catalog: BUNDLED_STATUS }),
    '/api/model/catalog/refresh': () => {
      refreshes += 1
      return jsonResponse({ ok: true, catalog: { ...BUNDLED_STATUS, error: 'models.dev responded 503' } })
    },
    '/api/model/providers': () => jsonResponse({ ok: true, providers: [] }),
  })
  const { dom, root } = await renderPanel()

  try {
    await click(buttonByText('新增', { exact: true }))
    await click(buttonByText('从 models.dev 刷新模型知识库'))

    assert.equal(refreshes, 1)
    const failure = document.querySelector('[data-catalog-refresh-error]')
    assert.ok(failure, 'the refresh failure is shown')
    assert.match(failure.textContent, /刷新失败：models.dev responded 503/)
    assert.equal(
      knowledgeBaseStatus().querySelector('[data-catalog-source]').getAttribute('data-catalog-source'),
      'bundled',
      'a failed refresh leaves the list in use exactly where it was',
    )

    // A refresh that failed must not take the picker down with it.
    await setInputValue(document.querySelector('input[placeholder="输入供应商 ID"]'), 'amazon-bedrock')
    await click(buttonByText('使用供应商 ID：amazon-bedrock'))
    assert.equal(knowledgeBase().querySelector('[data-catalog-provider-id]').textContent, 'amazon-bedrock')
    assert.equal(buttonByText('保存', { exact: true }).disabled, true)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a successful refresh switches the reported provenance to models.dev', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = panelFetch({
    '/api/model/catalog': () => jsonResponse({ ok: true, catalog: BUNDLED_STATUS }),
    '/api/model/catalog/refresh': () => jsonResponse({
      ok: true,
      catalog: { ...BUNDLED_STATUS, source: 'models.dev', refreshedAt: 1_800_000_000_000, providers: 240, models: 9000 },
    }),
    '/api/model/providers': () => jsonResponse({ ok: true, providers: [] }),
  })
  const { dom, root } = await renderPanel()

  try {
    await click(buttonByText('新增', { exact: true }))
    await click(buttonByText('从 models.dev 刷新模型知识库'))

    const source = knowledgeBaseStatus().querySelector('[data-catalog-source]')
    assert.equal(source.getAttribute('data-catalog-source'), 'models.dev')
    assert.match(source.textContent, /models\.dev（已刷新）/)
    assert.match(knowledgeBaseStatus().textContent, /240 个供应商 · 9000 个模型/)
    assert.equal(document.querySelector('[data-catalog-refresh-error]'), null)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('a provider the knowledge base does not know is reported without blocking the custom path', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = panelFetch({
    '/api/model/catalog': () => jsonResponse({ ok: true, catalog: BUNDLED_STATUS }),
    '/api/model/catalog/not-in-the-catalogue': () => jsonResponse({
      ok: false,
      error: { code: 'CATALOG_PROVIDER_UNKNOWN', message: '模型知识库中没有这个供应商' },
      catalog: BUNDLED_STATUS,
    }, 404),
    '/api/model/providers': () => jsonResponse({ ok: true, providers: [] }),
  })
  const { dom, root } = await renderPanel()

  try {
    await click(buttonByText('新增', { exact: true }))
    // A wrong id still has to be usable: it is reported, not fatal.
    await setInputValue(document.querySelector('input[placeholder="输入供应商 ID"]'), 'not-in-the-catalogue')
    await click(buttonByText('使用供应商 ID：not-in-the-catalogue'))

    await setInputValue(document.querySelector('input[placeholder="https://api.example.com/v1"]'), 'https://unknown.example.test/v1')
    assert.match(knowledgeBase().querySelector('[role="alert"]').textContent, /知识库中没有这个供应商/)
    assert.equal(catalogueModelRows().length, 0)
    // The provider still needs a model to save, exactly as any custom endpoint does,
    // and one typed by hand is enough.
    assert.equal(buttonByText('保存', { exact: true }).disabled, true)
    const manual = byAriaLabel(knowledgeBase().querySelectorAll('input'), '添加模型')
    await setInputValue(manual, 'unknown-model')
    await click(knowledgeBaseButton('添加模型'))
    assert.equal(buttonByText('保存', { exact: true }).disabled, false, 'the reader can still save the endpoint they typed')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('the knowledge base list can be re-read on demand and a model can be dropped again', async () => {
  const originalFetch = globalThis.fetch
  let catalogueRequests = 0
  globalThis.fetch = panelFetch({
    '/api/model/catalog': () => jsonResponse({ ok: true, catalog: BUNDLED_STATUS }),
    '/api/model/catalog/cerebras': () => {
      catalogueRequests += 1
      return jsonResponse({
        ok: true,
        provider: { id: 'cerebras', name: 'Cerebras' },
        models: BEDROCK_MODELS,
        catalog: BUNDLED_STATUS,
      })
    },
    '/api/model/providers': () => jsonResponse({ ok: true, providers: [] }),
  })
  const { dom, root } = await renderPanel()

  try {
    await click(buttonByText('新增', { exact: true }))
    await setInputValue(document.querySelector('input[placeholder="输入供应商 ID"]'), 'cerebras')
    await click(buttonByText('使用供应商 ID：cerebras'))

    // A provider whose OpenAI-compatible endpoint is documented comes prefilled.
    assert.equal(document.querySelector('input[placeholder="https://api.example.com/v1"]').value, 'https://api.cerebras.ai/v1')
    assert.equal(catalogueRequests, 1)

    await click(knowledgeBaseButton('读取知识库模型'))
    assert.equal(catalogueRequests, 2, 'the list can be re-read without reopening the editor')

    await click(byAriaLabel(knowledgeBase().querySelectorAll('button'), '把 global.openai.gpt-6.1-sol 加入模型列表'))
    assert.equal(catalogueModelRows()[1].textContent.includes('✓'), true)
    // A single id renders the plain default-model box, and it must already point
    // at the model that was just added rather than at an empty string.
    const chosen = [...document.querySelectorAll('input')].find((input) => input.placeholder === 'model-name')
    assert.equal(chosen.value, 'global.openai.gpt-6.1-sol')
    await click(byAriaLabel(knowledgeBase().querySelectorAll('button'), '把 global.openai.gpt-6.1-sol 从模型列表移除'))
    assert.equal(catalogueModelRows()[1].textContent.includes('✓'), false)
    // Dropping the last id leaves an empty list, never a default pointing at a
    // model that is no longer there.
    assert.equal([...document.querySelectorAll('input')].find((input) => input.placeholder === 'model-name').value, '')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})
