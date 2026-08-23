import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import StoragePersistenceNotice from '../src/components/StoragePersistenceNotice.jsx'
import SettingsDataExport from '../src/components/settings/SettingsDataExport.jsx'
import { USER_DATA_CLEAR_CONFIRMATION } from '../src/lib/runtimeConfigClient.js'

let act
let createRoot

async function loadReactRuntime() {
  if (act && createRoot) return
  const [react, reactDom] = await Promise.all([
    import('react'),
    import('react-dom/client'),
  ])
  act = react.act
  createRoot = reactDom.createRoot
}

function setupDom(pathname = '/') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://localhost${pathname}`,
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Event = dom.window.Event
  globalThis.InputEvent = dom.window.InputEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  globalThis.confirm = () => true
  globalThis.__YMA_STORAGE_NOTICE_TRANSLATE__ = (translationKey) => translationKey
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

async function enterValue(dom, input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    input.focus()
    setter.call(input, value)
    input.dispatchEvent(new dom.window.InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: 'insertText',
    }))
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await flush()
  })
}

async function loadFullDataPreview(dom, rootElement) {
  const button = rootElement.querySelector('[data-testid="full-local-data-preview"]')
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
}

function clearPreview() {
  return {
    token: 'preview-token',
    canClear: true,
    blockers: {},
    databaseRows: { total: 2, categories: { conversations: 2 } },
    managedFiles: { removable: 1, removableBytes: 12 },
  }
}

function dataExportState() {
  return {
    sessions: [],
    history: [],
    permissions: [],
    skillConfigs: {},
  }
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
    await loadReactRuntime()
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
  await loadReactRuntime()
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
  await loadReactRuntime()
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

test('SettingsDataExport uses the injected complete-data downloader and exposes its pending state', async () => {
  const dom = setupDom('/settings')
  await loadReactRuntime()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const download = deferred()
  let calls = 0

  try {
    await act(async () => {
      root.render(
        <SettingsDataExport
          state={dataExportState()}
          dispatch={() => {}}
          storageBytes={0}
          storageQuota={0}
          onStorageChanged={() => {}}
          downloadFullData={() => {
            calls += 1
            return download.promise
          }}
        />,
      )
    })

    const exportButton = rootElement.querySelector('[data-testid="full-local-data-export"]')
    await act(async () => {
      exportButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await flush()
    })
    assert.equal(calls, 1)
    assert.equal(exportButton.disabled, true)

    await act(async () => {
      download.resolve({ downloaded: true })
      await download.promise
      await flush()
    })
    assert.equal(exportButton.disabled, false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('SettingsDataExport requires the exact destructive confirmation phrase', async () => {
  const dom = setupDom('/settings')
  await loadReactRuntime()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)

  try {
    await act(async () => {
      root.render(
        <SettingsDataExport
          state={dataExportState()}
          dispatch={() => {}}
          storageBytes={0}
          storageQuota={0}
          onStorageChanged={() => {}}
          clearFullData={async () => ({ ok: true })}
          previewFullData={async () => clearPreview()}
        />,
      )
    })

    const input = rootElement.querySelector('[data-testid="full-local-data-confirmation"]')
    const clearButton = rootElement.querySelector('[data-testid="full-local-data-clear"]')
    assert.equal(clearButton.disabled, true)

    await enterValue(dom, input, 'DELETE ALL MY DATA')
    assert.equal(clearButton.disabled, true)

    await enterValue(dom, input, USER_DATA_CLEAR_CONFIRMATION)
    assert.equal(clearButton.disabled, true)

    await loadFullDataPreview(dom, rootElement)
    assert.equal(clearButton.disabled, false)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('SettingsDataExport clears browser state only after the backend clear succeeds', async () => {
  const dom = setupDom('/settings')
  await loadReactRuntime()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const backendClear = deferred()
  const browserClear = deferred()
  const dispatched = []
  const confirmations = []
  let browserClearCalls = 0
  let storageChangedCalls = 0
  globalThis.__YMA_CLEAR_PERSISTED_STATE__ = () => {
    browserClearCalls += 1
    return browserClear.promise
  }

  try {
    await act(async () => {
      root.render(
        <SettingsDataExport
          state={dataExportState()}
          dispatch={(action) => dispatched.push(action)}
          storageBytes={0}
          storageQuota={0}
          onStorageChanged={() => { storageChangedCalls += 1 }}
          previewFullData={async () => clearPreview()}
          clearFullData={({ confirmation, previewToken }) => {
            confirmations.push({ confirmation, previewToken })
            return backendClear.promise
          }}
        />,
      )
    })

    const input = rootElement.querySelector('[data-testid="full-local-data-confirmation"]')
    const clearButton = rootElement.querySelector('[data-testid="full-local-data-clear"]')
    await loadFullDataPreview(dom, rootElement)
    await enterValue(dom, input, USER_DATA_CLEAR_CONFIRMATION)
    await act(async () => {
      clearButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await flush()
    })

    assert.deepEqual(confirmations, [{
      confirmation: USER_DATA_CLEAR_CONFIRMATION,
      previewToken: 'preview-token',
    }])
    assert.equal(browserClearCalls, 0)
    assert.deepEqual(dispatched, [])
    assert.equal(clearButton.disabled, true)

    await act(async () => {
      backendClear.resolve({ ok: true })
      await backendClear.promise
      await flush()
    })
    assert.equal(browserClearCalls, 1)
    assert.deepEqual(dispatched, [])

    await act(async () => {
      browserClear.resolve({ ok: true })
      await browserClear.promise
      await flush()
    })
    assert.deepEqual(dispatched, [{ type: 'CLEAR_ALL_DATA' }])
    assert.equal(storageChangedCalls, 1)
    assert.equal(input.value, '')
    assert.equal(clearButton.disabled, true)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('SettingsDataExport preserves browser state when the backend clear fails', async () => {
  const dom = setupDom('/settings')
  await loadReactRuntime()
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  const dispatched = []
  let browserClearCalls = 0
  let storageChangedCalls = 0
  globalThis.__YMA_CLEAR_PERSISTED_STATE__ = async () => {
    browserClearCalls += 1
    return { ok: true }
  }

  try {
    await act(async () => {
      root.render(
        <SettingsDataExport
          state={dataExportState()}
          dispatch={(action) => dispatched.push(action)}
          storageBytes={0}
          storageQuota={0}
          onStorageChanged={() => { storageChangedCalls += 1 }}
          previewFullData={async () => clearPreview()}
          clearFullData={async () => { throw new Error('server clear failed') }}
        />,
      )
    })

    const input = rootElement.querySelector('[data-testid="full-local-data-confirmation"]')
    const clearButton = rootElement.querySelector('[data-testid="full-local-data-clear"]')
    await loadFullDataPreview(dom, rootElement)
    await enterValue(dom, input, USER_DATA_CLEAR_CONFIRMATION)
    await act(async () => {
      clearButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await flush()
    })

    assert.equal(browserClearCalls, 0)
    assert.deepEqual(dispatched, [])
    assert.equal(storageChangedCalls, 0)
    assert.equal(input.value, USER_DATA_CLEAR_CONFIRMATION)
    assert.equal(clearButton.disabled, true)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
