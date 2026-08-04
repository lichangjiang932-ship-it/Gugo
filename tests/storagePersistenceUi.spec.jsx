import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import StoragePersistenceNotice from '../src/components/StoragePersistenceNotice.jsx'
import SettingsDataExport from '../src/components/settings/SettingsDataExport.jsx'

function setupDom(pathname = '/') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://localhost${pathname}`,
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.confirm = () => true
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

test('StoragePersistenceNotice selects the matching i18n title and body for every persistence level', async () => {
  const expectedKeys = new Map([
    ['compact-metadata', 'compacted'],
    ['quota', 'quota'],
    ['unavailable', 'unavailable'],
    ['error', 'error'],
  ])

  for (const [level, key] of expectedKeys) {
    const dom = setupDom('/chat')
    const rootElement = dom.window.document.getElementById('root')
    const root = createRoot(rootElement)
    const translatedKeys = []
    globalThis.__YMA_STORAGE_NOTICE_CONTEXT__ = {
      state: { persistenceNotice: { level }, sessions: [] },
      dispatch: () => {},
    }
    globalThis.__YMA_STORAGE_NOTICE_TRANSLATE__ = (translationKey) => {
      translatedKeys.push(translationKey)
      return translationKey
    }

    try {
      await act(async () => {
        root.render(<StoragePersistenceNotice />)
      })

      assert.match(rootElement.textContent, new RegExp(`storageNotice\\.${key}Title`))
      assert.match(rootElement.textContent, new RegExp(`storageNotice\\.${key}Body`))
      assert.ok(translatedKeys.includes(`storageNotice.${key}Title`))
      assert.ok(translatedKeys.includes(`storageNotice.${key}Body`))
    } finally {
      await act(async () => root.unmount())
      dom.window.close()
    }
  }
})

test('SettingsDataExport waits for persisted storage clearing before dispatching CLEAR_ALL_DATA', async () => {
  const dom = setupDom('/settings')
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const clearing = deferred()
  const dispatched = []
  let storageChangedCalls = 0
  globalThis.__YMA_CLEAR_PERSISTED_STATE__ = () => clearing.promise

  try {
    await act(async () => {
      root.render(
        <SettingsDataExport
          state={{
            sessions: [],
            history: [],
            permissions: [],
            skillConfigs: {},
          }}
          dispatch={(action) => dispatched.push(action)}
          storageBytes={0}
          storageQuota={0}
          onStorageChanged={() => { storageChangedCalls += 1 }}
        />,
      )
    })

    const clearAllButton = [...rootElement.querySelectorAll('button')].at(-1)
    assert.ok(clearAllButton, 'expected the clear-all button to render')

    await act(async () => {
      clearAllButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await flush()
    })

    assert.deepEqual(dispatched, [], 'state must remain intact while IndexedDB clearing is pending')
    assert.equal(clearAllButton.disabled, true)

    await act(async () => {
      clearing.resolve({ ok: true, status: 'ok' })
      await clearing.promise
      await flush()
    })

    assert.deepEqual(dispatched, [{ type: 'CLEAR_ALL_DATA' }])
    assert.equal(storageChangedCalls, 1)
    assert.equal(clearAllButton.disabled, false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('SettingsDataExport retains in-memory state when persisted storage clearing fails', async () => {
  const dom = setupDom('/settings')
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const dispatched = []
  let storageChangedCalls = 0
  globalThis.__YMA_CLEAR_PERSISTED_STATE__ = async () => ({
    ok: false,
    status: 'unavailable',
    reason: 'storage-disabled',
  })

  try {
    await act(async () => {
      root.render(
        <SettingsDataExport
          state={{
            sessions: [{ id: 'session-to-keep' }],
            history: [{ id: 'history-to-keep' }],
            permissions: [],
            skillConfigs: {},
          }}
          dispatch={(action) => dispatched.push(action)}
          storageBytes={128}
          storageQuota={1024}
          onStorageChanged={() => { storageChangedCalls += 1 }}
        />,
      )
    })

    const clearAllButton = [...rootElement.querySelectorAll('button')].at(-1)
    assert.ok(clearAllButton, 'expected the clear-all button to render')
    await act(async () => {
      clearAllButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await flush()
    })

    assert.deepEqual(dispatched, [])
    assert.equal(storageChangedCalls, 1)
    assert.equal(clearAllButton.disabled, false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
