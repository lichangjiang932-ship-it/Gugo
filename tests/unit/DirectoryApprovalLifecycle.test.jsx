import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import useDirectoryApproval from '../../src/pages/ChatSplit/useDirectoryApproval.js'

const translate = (key) => key
const toastEvents = []
const toast = {
  success: (event) => toastEvents.push(event),
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

function createDeferredFetch() {
  const requests = []
  const fetch = (url, init = {}) => new Promise((resolve, reject) => {
    requests.push({ url, init, signal: init.signal, resolve, reject })
  })
  return { fetch, requests }
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function grantResponse(path) {
  return jsonResponse({
    ok: true,
    grant: { path, accessMode: 'read_only', resourceType: 'directory' },
  })
}

function renderDirectoryApprovalHook(root) {
  let latest
  function Harness() {
    latest = useDirectoryApproval({ lang: 'zh-CN', t: translate, toast })
    return null
  }
  root.render(<Harness />)
  return () => latest
}

test('cancelling a busy directory picker aborts its request and rejects the approval', async () => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  const originalFetch = globalThis.fetch
  const deferred = createDeferredFetch()
  globalThis.fetch = deferred.fetch
  toastEvents.length = 0

  let getLatest
  let decisionPromise
  let authorizationPromise
  try {
    await act(async () => {
      getLatest = renderDirectoryApprovalHook(root)
    })
    await act(async () => {
      decisionPromise = getLatest().requestDirectoryApproval({ path: 'D:\\first' })
    })
    await act(async () => {
      authorizationPromise = getLatest().authorizeDirectory({
        path: '',
        accessMode: 'read_only',
        usePicker: true,
      })
    })

    assert.equal(deferred.requests.length, 1)
    assert.equal(deferred.requests[0].url, '/api/local-files/pick-directory')
    assert.equal(deferred.requests[0].signal.aborted, false)
    assert.equal(getLatest().directoryApproval.busy, 'picker')

    await act(async () => {
      getLatest().cancelDirectoryApproval()
    })

    assert.deepEqual(await decisionPromise, { approved: false })
    assert.equal(deferred.requests[0].signal.aborted, true)
    assert.equal(getLatest().directoryApproval.open, false)

    await act(async () => {
      deferred.requests[0].resolve(jsonResponse({ ok: true, path: 'D:\\ignored' }))
      await authorizationPromise
    })
    assert.equal(deferred.requests.length, 1)
    assert.equal(toastEvents.length, 0)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})

test('a replacement approval aborts and rejects the old request without accepting its late result', async () => {
  const dom = setupDom()
  const root = createRoot(dom.window.document.getElementById('root'))
  const originalFetch = globalThis.fetch
  const deferred = createDeferredFetch()
  globalThis.fetch = deferred.fetch
  toastEvents.length = 0

  let getLatest
  let firstDecisionPromise
  let secondDecisionPromise
  let firstAuthorizationPromise
  let secondAuthorizationPromise
  try {
    await act(async () => {
      getLatest = renderDirectoryApprovalHook(root)
    })
    await act(async () => {
      firstDecisionPromise = getLatest().requestDirectoryApproval({ path: 'D:\\first' })
    })
    const firstRequestId = getLatest().directoryApproval.requestId
    await act(async () => {
      firstAuthorizationPromise = getLatest().authorizeDirectory({
        path: 'D:\\first',
        accessMode: 'read_only',
        usePicker: false,
      })
    })

    await act(async () => {
      secondDecisionPromise = getLatest().requestDirectoryApproval({ path: 'D:\\second' })
    })

    assert.deepEqual(await firstDecisionPromise, { approved: false })
    assert.equal(deferred.requests[0].signal.aborted, true)
    assert.equal(getLatest().directoryApproval.request.path, 'D:\\second')
    assert.ok(getLatest().directoryApproval.requestId > firstRequestId)

    let secondSettled = false
    secondDecisionPromise.then(() => { secondSettled = true })
    await act(async () => {
      deferred.requests[0].resolve(grantResponse('D:\\first'))
      await firstAuthorizationPromise
    })
    await Promise.resolve()

    assert.equal(secondSettled, false)
    assert.equal(getLatest().directoryApproval.open, true)
    assert.equal(toastEvents.length, 0)

    await act(async () => {
      secondAuthorizationPromise = getLatest().authorizeDirectory({
        path: 'D:\\second',
        accessMode: 'read_only',
        usePicker: false,
      })
    })
    assert.equal(deferred.requests.length, 2)
    await act(async () => {
      deferred.requests[1].resolve(grantResponse('D:\\second'))
      await secondAuthorizationPromise
    })

    assert.deepEqual(await secondDecisionPromise, {
      approved: true,
      path: 'D:\\second',
      accessMode: 'read_only',
      resourceType: 'directory',
      workspaceConfigTrusted: false,
    })
    assert.equal(getLatest().directoryApproval.open, false)
    assert.equal(toastEvents.length, 1)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    dom.window.close()
  }
})
