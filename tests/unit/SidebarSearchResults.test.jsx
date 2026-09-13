import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { setAuthToken } from '../../src/lib/accountClient.js'
import useSessionSearchResults from '../../src/components/leftRail/useSessionSearchResults.js'

const t = (key) => key
const EMPTY = []
function SearchProbe({ query, open = true, localResults = EMPTY }) {
  const result = useSessionSearchResults({ open, query, localResults, t })
  return <output>{JSON.stringify(result)}</output>
}

async function withSearch(check) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/chat' })
  const old = Object.fromEntries(['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
    .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const timeout = dom.window.setTimeout.bind(dom.window)
  dom.window.setTimeout = (callback, delay, ...args) => timeout(callback, Math.min(delay || 0, 5), ...args)
  setAuthToken('sidebar-search-test-only')
  const requests = []
  globalThis.fetch = (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject }))
  const element = dom.window.document.getElementById('root')
  const root = createRoot(element)
  const render = async (props) => {
    await act(async () => root.render(<SearchProbe {...props} />))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)) })
  }
  const settle = async (request, results) => {
    await act(async () => request.resolve({ ok: true, json: async () => ({ results }) }))
  }
  try { await check({ render, settle, requests, state: () => JSON.parse(element.textContent) }) }
  finally {
    await act(async () => root.unmount())
    setAuthToken('')
    dom.window.close()
    for (const [key, descriptor] of Object.entries(old)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
}

test('a slow old search cannot overwrite a newer query result or clear its loading state', async () => {
  await withSearch(async ({ render, settle, requests, state }) => {
    await render({ query: 'old' })
    await render({ query: 'new' })
    assert.equal(requests.length, 2)
    assert.match(requests[0].url, /q=old/)
    assert.match(requests[1].url, /q=new/)
    await settle(requests[0], [{ sessionId: 'stale', messageId: 'old' }])
    assert.equal(state().loading, true)
    assert.deepEqual(state().results, [])
    await settle(requests[1], [{ sessionId: 'current', messageId: 'new' }])
    assert.deepEqual(state().results, [{ sessionId: 'current', messageId: 'new' }])
    assert.equal(state().loading, false)
  })
})

test('closing then reopening search ignores old failures and keeps current results', async () => {
  await withSearch(async ({ render, settle, requests, state }) => {
    await render({ query: 'old' })
    await render({ query: 'old', open: false })
    await render({ query: 'fresh' })
    await settle(requests[1], [{ sessionId: 'fresh', messageId: 'fresh' }])
    await act(async () => requests[0].reject(new Error('stale failure')))
    assert.equal(state().error, '')
    assert.deepEqual(state().results, [{ sessionId: 'fresh', messageId: 'fresh' }])
  })
})

test('clearing the query prevents a late response from repopulating the search dialog', async () => {
  await withSearch(async ({ render, settle, requests, state }) => {
    await render({ query: 'old' })
    await render({ query: '' })
    await settle(requests[0], [{ sessionId: 'stale', messageId: 'old' }])
    assert.deepEqual(state(), { results: [], loading: false, error: '' })
    assert.equal(requests.length, 1)
  })
})

test('current search failures keep local fallback and successful searches deduplicate local/server matches', async () => {
  await withSearch(async ({ render, settle, requests, state }) => {
    const local = [{ sessionId: 'local', messageId: 'local' }]
    await render({ query: 'failed', localResults: local })
    await act(async () => requests[0].reject(new Error('offline')))
    assert.deepEqual(state(), { results: local, loading: false, error: 'offline' })
    await render({ query: 'success', localResults: local })
    await settle(requests[1], [{ sessionId: 'remote', messageId: 'remote' }, ...local])
    assert.equal(state().results.length, 2)
    assert.equal(state().error, '')
  })
})
