import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

// React reads `window` once when react-dom is first evaluated and falls back to
// a legacy input-event path when it is missing, which silently drops every
// onChange. Install the DOM before importing react-dom, not inside the tests.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/access',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.SVGElement = dom.window.SVGElement
globalThis.Event = dom.window.Event
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.InputEvent = dom.window.InputEvent
globalThis.localStorage = dom.window.localStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: AccessConnectModal } = await import('../src/components/AccessConnectModal.jsx')

const CONNECTOR = { provider: 'trello', label: 'Trello', hintKey: 'access.trelloHint', oauth: false }

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function recordRequests(handler) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method || 'GET').toUpperCase(),
      body: init.body ? JSON.parse(init.body) : null,
    }
    calls.push(call)
    return handler(call)
  }
  return calls
}

// The modal renders its overlay on document.body, outside the React root.
function inputByLabel(label) {
  const field = [...document.querySelectorAll('label')]
    .find((element) => element.querySelector('span')?.textContent === label)
  return field?.querySelector('input') || null
}

function setInputValue(dom, input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new dom.window.InputEvent('input', {
    bubbles: true,
    cancelable: true,
    data: value,
    inputType: 'insertText',
  }))
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

async function submitCredentialForm({ probeOk }) {
  // The modal renders outside the React root, so start from a clean document.
  dom.window.document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(dom.window.document.getElementById('root'))
  const calls = recordRequests((call) => {
    if (call.url === '/api/integrations') {
      return jsonResponse({ ok: true, integration: { id: 'int-1', provider: 'trello' } })
    }
    if (call.url === '/api/integrations/int-1/test') {
      return jsonResponse({ ok: true, result: { ok: probeOk, message: 'Trello rejected the token' } })
    }
    if (call.url === '/api/integrations/int-1/enabled') {
      return jsonResponse({ ok: true, integration: { id: 'int-1', provider: 'trello', enabled: true } })
    }
    throw new Error(`unexpected request: ${call.url}`)
  })
  const connected = []
  const t = (key) => ({
    'access.apiKey': 'API key',
    'access.token': 'Token',
    'access.saveAndTest': 'Save and test',
    'access.connectError': 'Connection failed',
  })[key] || key

  try {
    await act(async () => {
      root.render(
        <AccessConnectModal
          connector={CONNECTOR}
          integration={undefined}
          onClose={() => {}}
          onConnected={(integration) => connected.push(integration)}
          t={t}
        />,
      )
    })
    const apiKeyInput = inputByLabel('API key')
    const tokenInput = inputByLabel('Token')
    assert.ok(apiKeyInput, 'the manual credential form exposes an API key field')
    assert.ok(tokenInput, 'the manual credential form exposes a token field')
    await act(async () => {
      setInputValue(dom, apiKeyInput, 'trello-api-key')
      setInputValue(dom, tokenInput, 'trello-token')
    })
    const form = dom.window.document.querySelector('form')
    await act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    })
    // Read the text now: the finally block unmounts the portal and empties it.
    return { calls, connected, text: dom.window.document.body.textContent }
  } finally {
    await act(async () => root.unmount())
  }
}

test('a credential is saved disabled, probed, and only then enabled', async () => {
  const { calls, connected } = await submitCredentialForm({ probeOk: true })

  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'POST /api/integrations',
    'POST /api/integrations/int-1/test',
    'POST /api/integrations/int-1/enabled',
  ])
  assert.equal(calls[0].body.enabled, false)
  assert.deepEqual(calls[0].body.secret, { token: 'trello-token' })
  assert.deepEqual(calls[0].body.config, { apiKey: 'trello-api-key' })
  assert.deepEqual(calls[2].body, { enabled: true })
  assert.deepEqual(connected, [{ id: 'int-1', provider: 'trello', enabled: true }])
})

test('a failed probe never enables the credential and surfaces the reason', async () => {
  const { calls, connected, text } = await submitCredentialForm({ probeOk: false })

  assert.deepEqual(calls.map((call) => call.url), [
    '/api/integrations',
    '/api/integrations/int-1/test',
  ])
  assert.equal(
    calls.some((call) => call.url.endsWith('/enabled')),
    false,
    'a credential whose probe failed must not be enabled',
  )
  assert.deepEqual(connected, [])
  assert.match(text, /Trello rejected the token/u)
})
