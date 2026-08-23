import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import SettingsSideEffectRecoveryPanel from '../../src/components/settings/SettingsSideEffectRecoveryPanel.jsx'
import { translations } from '../../src/i18n/translations.js'
import { setAuthToken } from '../../src/lib/accountClient.js'

let act
let createRoot

async function loadReactRuntime() {
  const [react, reactDom] = await Promise.all([
    import('react'),
    import('react-dom/client'),
  ])
  act = react.act
  createRoot = reactDom.createRoot
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings?tab=recovery',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Event = dom.window.Event
  globalThis.InputEvent = dom.window.InputEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function t(key, values = {}) {
  const translated = Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    key,
  )
  const unusedValues = Object.entries(values)
    .filter(([name]) => !key.includes(`{${name}}`))
    .map(([, value]) => String(value))
  return [translated, ...unusedValues].join(' ')
}

async function waitFor(predicate, context = '') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  }
  assert.fail(`timed out waiting for UI state${context ? `: ${context}` : ''}`)
}

async function click(element) {
  await act(async () => {
    element.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function enterTextarea(dom, element, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, data: value }))
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

function buttonWithText(rootElement, text) {
  return [...rootElement.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === text)
}

test('unknown side-effect recovery requires verified evidence and records an authenticated decision', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  await loadReactRuntime()
  setAuthToken('recovery-ui-token')
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (String(url).startsWith('/api/side-effects/history')) {
      return json({ ok: true, records: [], nextCursor: null })
    }
    if (String(url) === '/api/side-effects/unknown?limit=50') {
      return json({
        ok: true,
        records: [{
          scopeKind: 'job',
          scopeKey: '["job","job-1","step-1"]',
          jobId: 'job-1',
          stepId: 'step-1',
          toolCallId: 'call-1',
          toolName: 'write_file',
          argsDigest: 'a'.repeat(64),
          status: 'unknown',
          updatedAt: 1_750_000_000_000,
          evidence: {
            targetSummary: ['/tmp/report.txt'],
            changedPaths: ['/tmp/report.txt'],
            verifiedOutputs: [{ path: '/tmp/report.txt', sha256: 'b'.repeat(64) }],
            artifactIds: ['artifact-report'],
          },
        }],
      })
    }
    if (String(url) === '/api/side-effects/resolve' && init.method === 'POST') {
      return json({
        ok: true,
        record: { scopeKind: 'job', jobId: 'job-1', stepId: 'step-1', status: 'committed' },
        resume: { kind: 'job', jobId: 'job-1', stepId: 'step-1' },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const opened = []
  try {
    await act(async () => {
      root.render(<SettingsSideEffectRecoveryPanel lang="en" onOpenOriginalTask={(target) => opened.push(target)} t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => rootElement.querySelector('[data-testid="side-effect-recovery-record"]'))

    assert.match(rootElement.textContent, /sideEffectRecovery\.safetyWarning/)
    assert.match(rootElement.textContent, /call-1/)
    assert.match(rootElement.textContent, new RegExp('a'.repeat(64)))
    assert.match(rootElement.textContent, /\/tmp\/report\.txt/)
    assert.match(rootElement.textContent, /artifact-report/)
    assert.equal(rootElement.querySelectorAll('input[type="radio"]').length, 2)
    const submit = buttonWithText(rootElement, 'sideEffectRecovery.submitDecision')
    assert.equal(submit.disabled, true)

    await click(rootElement.querySelector('input[type="radio"][value="committed"]'))
    assert.equal(submit.disabled, true, 'a decision alone must not bypass external verification')
    await click(rootElement.querySelector('input[type="checkbox"]:not([data-testid])'))
    assert.equal(submit.disabled, true, 'external verification is distinct from permanent confirmation')
    await click(rootElement.querySelector('[data-testid="side-effect-recovery-permanent-confirmation"]'))
    assert.equal(submit.disabled, false)
    await enterTextarea(dom, rootElement.querySelector('textarea'), '  Verified in the target file.  ')
    await click(submit)
    await waitFor(() => rootElement.textContent.includes('sideEffectRecovery.committedRecorded'))

    const continueButton = rootElement.querySelector('[data-testid="side-effect-recovery-continue"]')
    assert.equal(continueButton?.textContent, 'sideEffectRecovery.continueOriginalTask')
    await click(continueButton)
    assert.deepEqual(opened[0].resume, { kind: 'job', jobId: 'job-1', stepId: 'step-1' })

    assert.equal(rootElement.querySelector('[data-testid="side-effect-recovery-record"]'), null)
    assert.match(rootElement.textContent, /sideEffectRecovery\.empty/)
    const unknownRequest = requests.find((request) => request.url.startsWith('/api/side-effects/unknown'))
    const historyRequest = requests.find((request) => request.url.startsWith('/api/side-effects/history'))
    const resolveRequest = requests.find((request) => request.url === '/api/side-effects/resolve')
    assert.equal(unknownRequest.init.headers.Authorization, 'Bearer recovery-ui-token')
    assert.equal(historyRequest.init.headers.Authorization, 'Bearer recovery-ui-token')
    assert.equal(resolveRequest.init.headers.Authorization, 'Bearer recovery-ui-token')
    assert.deepEqual(JSON.parse(resolveRequest.init.body), {
      scopeKey: '["job","job-1","step-1"]',
      toolCallId: 'call-1',
      verificationConfirmed: true,
      confirmToolCallId: 'call-1',
      resolution: 'committed',
      note: 'Verified in the target file.',
    })
    assert.equal(Object.hasOwn(JSON.parse(resolveRequest.init.body), 'userId'), false)
  } finally {
    await act(async () => root.unmount())
    setAuthToken('')
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('unknown side-effect recovery exposes load error, retry, loading, and empty states', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  await loadReactRuntime()
  let requestCount = 0
  let releaseFirstRequest
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/side-effects/history')) {
      return json({ ok: true, records: [], nextCursor: null })
    }
    requestCount += 1
    if (requestCount === 1) {
      await new Promise((resolve) => { releaseFirstRequest = resolve })
      return json({ error: { code: 'TEMPORARY', message: 'offline' } }, 503)
    }
    return json({ ok: true, records: [] })
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsSideEffectRecoveryPanel lang="zh" t={t} />)
      await Promise.resolve()
    })
    assert.match(rootElement.textContent, /sideEffectRecovery\.loading/)
    await act(async () => releaseFirstRequest())
    await waitFor(() => rootElement.textContent.includes('sideEffectRecovery.loadFailed'))
    assert.match(rootElement.textContent, /offline/)

    await click(buttonWithText(rootElement, 'sideEffectRecovery.retry'))
    await waitFor(() => rootElement.textContent.includes('sideEffectRecovery.empty'))
    assert.equal(requestCount, 2)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('unknown side-effect recovery records an explicitly verified failed outcome without inventing a note', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  await loadReactRuntime()
  let resolutionBody = null
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('/api/side-effects/history')) {
      return json({ ok: true, records: [], nextCursor: null })
    }
    if (String(url).startsWith('/api/side-effects/unknown')) {
      return json({
        ok: true,
        records: [{
          scopeKind: 'turn',
          scopeKey: '["turn","turn-2"]',
          turnId: 'turn-2',
          toolCallId: 'call-2',
          toolName: 'send_message',
          argsDigest: 'b'.repeat(64),
          status: 'unknown',
          updatedAt: 1_750_000_000_000,
          evidence: {
            targetSummary: [],
            changedPaths: [],
            verifiedOutputs: [],
            artifactIds: [],
          },
        }],
      })
    }
    if (String(url) === '/api/side-effects/resolve') {
      resolutionBody = JSON.parse(init.body)
      return json({ ok: true, record: { status: 'failed' } })
    }
    throw new Error(`unexpected request: ${url}`)
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsSideEffectRecoveryPanel lang="en" t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => rootElement.querySelector('input[type="radio"][value="failed"]'))
    await click(rootElement.querySelector('input[type="radio"][value="failed"]'))
    await click(rootElement.querySelector('input[type="checkbox"]:not([data-testid])'))
    await click(rootElement.querySelector('[data-testid="side-effect-recovery-permanent-confirmation"]'))
    await click(buttonWithText(rootElement, 'sideEffectRecovery.submitDecision'))
    await waitFor(() => rootElement.textContent.includes('sideEffectRecovery.failedRecorded'))

    assert.deepEqual(resolutionBody, {
      scopeKey: '["turn","turn-2"]',
      toolCallId: 'call-2',
      verificationConfirmed: true,
      confirmToolCallId: 'call-2',
      resolution: 'failed',
    })
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('unknown side-effect recovery distinguishes same-tool calls and tolerates out-of-range timestamps', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  await loadReactRuntime()
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/api/side-effects/history')) {
      return json({ ok: true, records: [], nextCursor: null })
    }
    return json({
      ok: true,
      records: [
      {
        scopeKind: 'job',
        scopeKey: '["job","same-job","step-a"]',
        jobId: 'same-job',
        stepId: 'step-a',
        toolCallId: 'same-tool-call-a',
        toolName: 'write_file',
        argsDigest: 'c'.repeat(64),
        status: 'unknown',
        updatedAt: Number.MAX_VALUE,
        evidence: { targetSummary: ['/tmp/a.txt'], changedPaths: [], verifiedOutputs: [], artifactIds: [] },
      },
      {
        scopeKind: 'job',
        scopeKey: '["job","same-job","step-b"]',
        jobId: 'same-job',
        stepId: 'step-b',
        toolCallId: 'same-tool-call-b',
        toolName: 'write_file',
        argsDigest: 'd'.repeat(64),
        status: 'unknown',
        updatedAt: 1_750_000_000_000,
        evidence: { targetSummary: ['/tmp/b.txt'], changedPaths: [], verifiedOutputs: [], artifactIds: [] },
      },
      ],
    })
  }

  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(<SettingsSideEffectRecoveryPanel lang="en" t={t} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => rootElement.querySelectorAll('[data-testid="side-effect-recovery-record"]').length === 2)
    assert.match(rootElement.textContent, /same-tool-call-a/)
    assert.match(rootElement.textContent, /same-tool-call-b/)
    assert.match(rootElement.textContent, new RegExp('c'.repeat(64)))
    assert.match(rootElement.textContent, new RegExp('d'.repeat(64)))
    const firstTime = rootElement.querySelector('time')
    assert.equal(firstTime.textContent, 'sideEffectRecovery.unknownTime')
    assert.equal(firstTime.hasAttribute('datetime'), false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('unknown side-effect recovery safety copy is complete in every supported language', () => {
  for (const language of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    const copy = translations[language].sideEffectRecovery
    assert.equal(typeof copy.navTitle, 'string')
    assert.equal(typeof copy.safetyWarning, 'string')
    assert.equal(typeof copy.confirmCommitted, 'string')
    assert.equal(typeof copy.confirmFailed, 'string')
    assert.equal(typeof copy.verificationRequired, 'string')
    assert.equal(typeof copy.toolCallIdLabel, 'string')
    assert.equal(typeof copy.argsDigestLabel, 'string')
    assert.equal(typeof copy.permanentDecisionWarning, 'string')
    assert.equal(typeof copy.permanentDecisionRequired, 'string')
    assert.equal(typeof copy.loadMore, 'string')
    assert.equal(typeof copy.historyTitle, 'string')
    assert.equal(typeof copy.historyLoadFailed, 'string')
    assert.equal(typeof copy.historyCommitted, 'string')
    assert.equal(typeof copy.historyFailed, 'string')
    assert.ok(copy.safetyWarning.length >= 60)
  }
})
