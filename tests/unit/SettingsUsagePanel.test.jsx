import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import SettingsUsagePanel from '../../src/components/settings/SettingsUsagePanel.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/settings?tab=usage',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const t = (key, values = {}) => Object.entries(values)
  .reduce((text, [name, value]) => `${text}:${name}=${value}`, key)

const USAGE = { promptTokens: 1_000, completionTokens: 200, cacheHitTokens: 60, cacheMissTokens: 40 }

function makeReport(overrides = {}) {
  return {
    window: { since: null, sessionId: '', truncated: false, eventCount: 5 },
    turns: { total: 3, completed: 2, stopped: 1, byType: {} },
    totals: { ...USAGE, totalTokens: 1_200 },
    phaseTotals: { ...USAGE, totalTokens: 1_200 },
    cacheHitRatePercent: 60,
    byModel: [{ key: 'claude-sonnet-5', modelPhases: 2, totalTokens: 1_200, usage: USAGE, cacheHitRatePercent: 60 }],
    bySession: [{ key: 'session-abc', turns: 3, modelPhases: 2, totalTokens: 1_200, usage: USAGE, cacheHitRatePercent: 60 }],
    perModelPhases: 2,
    ...overrides,
  }
}

function sinceOf(request) {
  return new URL(request.url, 'http://localhost').searchParams.get('since')
}

// Mirrors the panel's own local-calendar-date helper; the point of the assertion
// is that the value is a *local* date, never an ISO/UTC instant.
function localDateDaysAgo(days) {
  const date = new Date(Date.now() - days * 86_400_000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

async function renderPanel(report) {
  const requests = []
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    if (report instanceof Error) throw report
    return report instanceof Response ? report : jsonResponse(report)
  }
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  await act(async () => {
    root.render(<SettingsUsagePanel t={t} />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { requests, root, rootElement }
}

test('the usage panel renders the persisted totals, per-model and per-session rows', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  try {
    const { requests, root, rootElement } = await renderPanel({ ok: true, report: makeReport() })

    assert.equal(sinceOf(requests[0]), localDateDaysAgo(30))
    assert.match(rootElement.textContent, /claude-sonnet-5/)
    assert.match(rootElement.textContent, /session-abc/)
    assert.match(rootElement.textContent, /60%/)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('the window presets re-read the report and all-time drops the since filter', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  try {
    const { requests, root, rootElement } = await renderPanel({ ok: true, report: makeReport() })

    await act(async () => {
      rootElement.querySelector('[data-testid="settings-usage-window-7"]').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(sinceOf(requests.at(-1)), localDateDaysAgo(7))
    assert.equal(rootElement.querySelector('[data-testid="settings-usage-window-7"]').getAttribute('aria-pressed'), 'true')

    await act(async () => {
      rootElement.querySelector('[data-testid="settings-usage-window-all"]').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(sinceOf(requests.at(-1)), null)

    await act(async () => {
      rootElement.querySelector('[data-testid="settings-usage-refresh"]').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(requests.length, 4)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('switching ranges removes old totals while the replacement is still pending', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  let rendered
  let complete
  try {
    rendered = await renderPanel({ ok: true, report: makeReport() })
    globalThis.fetch = () => new Promise((resolve) => { complete = resolve })
    await act(async () => rendered.rootElement.querySelector('[data-testid="settings-usage-window-7"]').click())
    assert.equal(Boolean(rendered.rootElement.querySelector('[data-testid="settings-usage-table"]')), false)
    assert.match(rendered.rootElement.textContent, /usage.loading/)
    await act(async () => complete(jsonResponse({ ok: true, report: makeReport() })))
  } finally {
    if (rendered) await act(async () => rendered.root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('a slow earlier response cannot overwrite the range the reader is looking at', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  try {
    // Hold every request open so the two can be answered out of order.
    const pending = []
    globalThis.fetch = (url) => new Promise((resolve) => {
      pending.push({ url: String(url), resolve })
    })
    const rootElement = document.getElementById('root')
    const root = createRoot(rootElement)
    await act(async () => { root.render(<SettingsUsagePanel t={t} />) })
    // The mount read (30 days) is still in flight when the reader switches.
    await act(async () => {
      rootElement.querySelector('[data-testid="settings-usage-window-7"]').click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.equal(pending.length, 2)
    assert.equal(sinceOf({ url: pending[0].url }), localDateDaysAgo(30))
    assert.equal(sinceOf({ url: pending[1].url }), localDateDaysAgo(7))

    const rowFor = (key) => makeReport({
      byModel: [{ key, modelPhases: 2, totalTokens: 1_200, usage: USAGE, cacheHitRatePercent: 60 }],
    })
    // The range the reader asked for answers first...
    await act(async () => {
      pending[1].resolve(jsonResponse({ ok: true, report: rowFor('range-seven') }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // ...and the abandoned one lands afterwards. It must be discarded.
    await act(async () => {
      pending[0].resolve(jsonResponse({ ok: true, report: rowFor('range-thirty') }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.match(rootElement.textContent, /range-seven/)
    assert.doesNotMatch(rootElement.textContent, /range-thirty/)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('a failed read shows the error copy instead of stale numbers', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  try {
    const { root, rootElement } = await renderPanel(jsonResponse({ ok: false, error: 'database is locked' }, 500))

    const alert = rootElement.querySelector('[data-testid="settings-usage-error"]')
    assert.ok(alert)
    assert.match(alert.textContent, /database is locked/)
    assert.equal(rootElement.querySelector('[data-testid="settings-usage-table"]'), null)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('a range with no recorded usage says so rather than showing empty tables', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  try {
    const empty = makeReport({
      turns: { total: 0, completed: 0, stopped: 0, byType: {} },
      totals: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0 },
      phaseTotals: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0 },
      cacheHitRatePercent: null,
      byModel: [],
      bySession: [],
      perModelPhases: 0,
    })
    const { root, rootElement } = await renderPanel({ ok: true, report: empty })

    assert.ok(rootElement.querySelector('[data-testid="settings-usage-empty"]'))
    assert.equal(rootElement.querySelector('[data-testid="settings-usage-table"]'), null)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('a report that never measured the cache says the rate was not reported', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  try {
    const unmeasured = makeReport({
      totals: { promptTokens: 1_000, completionTokens: 200, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 1_200 },
      cacheHitRatePercent: null,
      byModel: [{ key: 'claude-sonnet-5', modelPhases: 2, totalTokens: 1_200, usage: USAGE, cacheHitRatePercent: null }],
    })
    const { root, rootElement } = await renderPanel({ ok: true, report: unmeasured })

    assert.match(rootElement.textContent, /usage.cacheNotReported/)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('the panel names which way the per-model breakdown disagrees with the turn total', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  try {
    const smaller = makeReport({ phaseTotals: { ...USAGE, totalTokens: 900 } })
    const first = await renderPanel({ ok: true, report: smaller })
    assert.match(first.rootElement.querySelector('[data-testid="settings-usage-note"]').textContent, /usage.breakdownSmaller/)
    await act(async () => first.root.unmount())

    const larger = makeReport({ phaseTotals: { ...USAGE, totalTokens: 1_500 } })
    const second = await renderPanel({ ok: true, report: larger })
    assert.match(second.rootElement.querySelector('[data-testid="settings-usage-note"]').textContent, /usage.breakdownLarger/)
    await act(async () => second.root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('coverage and writes stay separate, and the displayed rate uses measured inputs only', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  let rendered
  try {
    rendered = await renderPanel({ ok: true, report: makeReport({ cacheHitRatePercent: 50,
      cacheCoverage: { requests: 3, readReported: 2, readUnknown: 1, writeReported: 1,
        cacheCreationTokens: 30, hitRatePercent: 10 } }) })
    const coverage = rendered.rootElement.querySelector('[data-testid="settings-usage-cache-coverage"]')
    assert.ok(coverage)
    assert.match(coverage.textContent, /2 \/ 3/)
    assert.match(coverage.textContent, /30/)
    assert.match(rendered.rootElement.textContent, /10%/)
    assert.doesNotMatch(rendered.rootElement.textContent, /50%/)
    await act(async () => rendered.root.unmount())
    rendered = await renderPanel({ ok: true, report: makeReport({ cacheHitRatePercent: 100,
      cacheCoverage: { requests: 0, readReported: 0, readUnknown: 0, cacheCreationTokens: null, hitRatePercent: null } }) })
    assert.doesNotMatch(rendered.rootElement.textContent, /100%/, 'legacy aggregate rates cannot masquerade as request observations')
  } finally {
    if (rendered) await act(async () => rendered.root.unmount())
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})

test('the cache waste the server already computed is shown, and only when there is some', async () => {
  const originalFetch = globalThis.fetch
  const dom = setupDom()
  try {
    const wasteful = await renderPanel({ ok: true, report: makeReport({
      cacheWaste: { missedTokens: 12_345, missedCost: 0, missCount: 3 },
    }) })
    const line = wasteful.rootElement.querySelector('[data-testid="settings-usage-cache-waste"]')
    assert.ok(line, 'waste that was computed is worth showing')
    assert.match(line.textContent, /12,345/)
    assert.match(line.textContent, /count=3/)
    await act(async () => wasteful.root.unmount())

    const clean = await renderPanel({ ok: true, report: makeReport({
      cacheWaste: { missedTokens: 0, missedCost: 0, missCount: 0 },
    }) })
    assert.equal(clean.rootElement.querySelector('[data-testid="settings-usage-cache-waste"]'), null,
      'nothing to say when nothing was re-billed')
    await act(async () => clean.root.unmount())
  } finally {
    dom.window.close()
    globalThis.fetch = originalFetch
  }
})
