import assert from 'node:assert/strict'
import test from 'node:test'

import { createDesktopBrowserHost, hardenBrowserPartition } from '../desktop/browserHost.js'
import {
  BROWSER_VIEW_PARTITION,
  BROWSER_VIEW_WEB_PREFERENCES,
  clampBrowserBounds,
  isAllowedBrowserUrl,
  MAX_BROWSER_URL_LENGTH,
} from '../desktop/browserViewPolicy.js'

const ORIGIN = 'http://127.0.0.1:5180'

class FakeWebContents {
  constructor() {
    this.destroyed = false
    this.handlers = new Map()
    this.url = ''
    this.title = ''
    this.loading = false
    this.windowOpenHandler = null
    this.loaded = []
    this.reloads = 0
    this.stops = 0
    this.closed = false
    this.navigationHistory = {
      canGoBack: () => this.backAvailable === true,
      canGoForward: () => this.forwardAvailable === true,
      goBack: () => { this.wentBack = (this.wentBack || 0) + 1 },
      goForward: () => { this.wentForward = (this.wentForward || 0) + 1 },
    }
  }

  on(name, handler) {
    const list = this.handlers.get(name) || []
    list.push(handler)
    this.handlers.set(name, list)
    return this
  }

  fire(name, ...args) {
    for (const handler of this.handlers.get(name) || []) handler(...args)
  }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler }
  isDestroyed() { return this.destroyed }
  getURL() { return this.url }
  getTitle() { return this.title }
  isLoading() { return this.loading }
  loadURL(url) { this.loaded.push(url); this.url = url; return Promise.resolve() }
  reload() { this.reloads += 1 }
  stop() { this.stops += 1 }
  close() { this.destroyed = true; this.closed = true }
}

class FakeView {
  constructor() {
    this.webContents = new FakeWebContents()
    this.bounds = null
    this.visible = false
    this.removed = false
  }

  setBounds(bounds) { this.bounds = bounds }
  setVisible(visible) { this.visible = visible }
}

function harness({ contentSize = [1000, 800] } = {}) {
  const created = []
  const added = []
  const sent = []
  const windowHandlers = new Map()
  const mainWindow = {
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    contentView: {
      addChildView: (view) => added.push(view),
      removeChildView: (view) => { view.removed = true },
    },
    getContentSize: () => contentSize,
    isDestroyed: () => false,
    on: (name, handler) => { windowHandlers.set(name, handler) },
  }
  const handlers = new Map()
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler) }
  const opened = []
  const partitions = []
  const host = createDesktopBrowserHost({
    ipcMain,
    getApplicationOrigin: () => ORIGIN,
    getMainWindow: () => mainWindow,
    createView: () => { const view = new FakeView(); created.push(view); return view },
    session: {
      fromPartition: (name) => {
        const entry = {
          name,
          requestHandler: null,
          checkHandler: null,
          setPermissionRequestHandler(handler) { entry.requestHandler = handler },
          setPermissionCheckHandler(handler) { entry.checkHandler = handler },
        }
        partitions.push(entry)
        return entry
      },
    },
    openExternalUrl: (url) => opened.push(url),
  })
  host.register()

  const call = (channel, payload, overrides = {}) => handlers.get(channel)({
    sender: mainWindow.webContents,
    senderFrame: { url: `${ORIGIN}/` },
    ...overrides,
  }, payload)

  return {
    added, call, created, host, mainWindow, opened, partitions, sent, windowHandlers,
    get view() { return created.at(-1) },
  }
}

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

test('only a plain http(s) address is allowed to load in the docked view', () => {
  assert.equal(isAllowedBrowserUrl('https://example.com/a?b=1#c'), true)
  assert.equal(isAllowedBrowserUrl('http://127.0.0.1:5173/'), true)
  // Every other scheme a page could ask for is refused rather than guessed at.
  for (const refused of [
    'file:///C:/Windows/System32/config/SAM',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'chrome://settings',
    'about:blank',
    '',
    '   ',
    'not a url',
  ]) {
    assert.equal(isAllowedBrowserUrl(refused), false, refused)
  }
  // Credentials are refused rather than stripped: the reader must not believe
  // they are looking at an address the view is not actually on.
  assert.equal(isAllowedBrowserUrl('https://user:secret@example.com'), false)
  assert.equal(isAllowedBrowserUrl('https://user@example.com'), false)
  assert.equal(isAllowedBrowserUrl(`https://example.com/${'a'.repeat(MAX_BROWSER_URL_LENGTH)}`), false)
})

test('a docking rectangle that cannot be painted into resolves to nothing', () => {
  const window = { contentWidth: 1000, contentHeight: 800 }
  assert.deepEqual(clampBrowserBounds({ x: 12, y: 40, width: 320, height: 600 }, window), { x: 12, y: 40, width: 320, height: 600 })
  assert.deepEqual(clampBrowserBounds({ x: 12.6, y: 40.2, width: 319.4, height: 600.6 }, window), { x: 13, y: 40, width: 319, height: 601 })
  // A rectangle running past the window is trimmed, not carried over the edge.
  assert.deepEqual(clampBrowserBounds({ x: 900, y: 700, width: 320, height: 600 }, window), { x: 900, y: 700, width: 100, height: 100 })
  // A negative origin is pulled back to zero instead of painting outside.
  assert.deepEqual(clampBrowserBounds({ x: -50, y: -50, width: 100, height: 100 }, window), { x: 0, y: 0, width: 100, height: 100 })
  for (const unusable of [
    null,
    undefined,
    {},
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 0, y: 0, width: 10, height: 0 },
    { x: 1000, y: 0, width: 10, height: 10 },
    { x: 0, y: 800, width: 10, height: 10 },
  ]) {
    assert.equal(clampBrowserBounds(unusable, window), null, JSON.stringify(unusable))
  }
})

test('the docked view gets the app window’s isolation and a partition of its own', () => {
  assert.equal(BROWSER_VIEW_WEB_PREFERENCES.contextIsolation, true)
  assert.equal(BROWSER_VIEW_WEB_PREFERENCES.nodeIntegration, false)
  assert.equal(BROWSER_VIEW_WEB_PREFERENCES.sandbox, true)
  assert.equal(BROWSER_VIEW_WEB_PREFERENCES.webSecurity, true)
  assert.equal(BROWSER_VIEW_WEB_PREFERENCES.allowRunningInsecureContent, false)
  assert.equal(BROWSER_VIEW_WEB_PREFERENCES.webviewTag, false)
  // A partition of its own is what keeps the browsed site out of the app's session.
  assert.equal(BROWSER_VIEW_WEB_PREFERENCES.partition, BROWSER_VIEW_PARTITION)
  assert.match(BROWSER_VIEW_PARTITION, /^persist:/u)
})

test('the browser partition answers no permission prompt at all', () => {
  const partition = { setPermissionRequestHandler: (fn) => { partition.request = fn }, setPermissionCheckHandler: (fn) => { partition.check = fn } }
  hardenBrowserPartition({ fromPartition: (name) => { assert.equal(name, BROWSER_VIEW_PARTITION); return partition } })

  const answers = []
  partition.request(null, 'media', (allowed) => answers.push(allowed))
  partition.request(null, 'geolocation', (allowed) => answers.push(allowed))
  assert.deepEqual(answers, [false, false])
  assert.equal(partition.check(null, 'notifications', 'https://example.com'), false)
})

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

test('a navigation creates one view, docks it, and reuses it afterwards', () => {
  const app = harness()
  assert.deepEqual(app.call('desktop:browser-navigate', 'https://example.com/'), { ok: true })

  assert.equal(app.created.length, 1)
  assert.deepEqual(app.added, [app.view], 'the view is attached to the window it is docked over')
  assert.deepEqual(app.view.webContents.loaded, ['https://example.com/'])
  // It must not be visible before it has a rectangle to paint into.
  assert.equal(app.view.visible, false)

  app.call('desktop:browser-set-bounds', { x: 8, y: 48, width: 320, height: 700 })
  assert.deepEqual(app.view.bounds, { x: 8, y: 48, width: 320, height: 700 })
  assert.equal(app.view.visible, true)

  // A second navigation keeps the same view, so the page's session and history
  // survive instead of being thrown away and reloaded.
  app.call('desktop:browser-navigate', 'https://example.org/')
  assert.equal(app.created.length, 1)
  assert.deepEqual(app.view.webContents.loaded, ['https://example.com/', 'https://example.org/'])
})

test('a refused address never reaches the browser and never creates a view', () => {
  const app = harness()
  for (const refused of ['file:///C:/secret.txt', 'javascript:alert(1)', 'https://user:pw@example.com', '']) {
    assert.deepEqual(app.call('desktop:browser-navigate', refused), { ok: false, reason: 'url' }, refused)
  }
  assert.equal(app.created.length, 0, 'nothing was created for a refused address')
  assert.equal(app.added.length, 0)
})

test('hiding a panel hides the view without unloading the page', () => {
  const app = harness()
  app.call('desktop:browser-navigate', 'https://example.com/')
  const contents = app.view.webContents
  app.call('desktop:browser-set-bounds', { x: 0, y: 0, width: 320, height: 600 })
  assert.equal(app.view.visible, true)

  // What a tab switch does: the panel reports no usable rectangle.
  assert.deepEqual(app.call('desktop:browser-set-bounds', null), { ok: true, bounds: null })
  assert.equal(app.view.visible, false)
  app.call('desktop:browser-hide')
  assert.equal(app.view.visible, false)

  // A native view left painting would cover whatever the reader switched to, so
  // hiding has to be a real hide and not a zero-size rectangle.
  assert.equal(app.view.bounds === null || app.view.bounds.width > 0, true)
  assert.equal(app.view.webContents, contents, 'the page is the same one, not a reload')
  assert.deepEqual(contents.loaded, ['https://example.com/'])
})

test('switching back re-docks the same view at the new rectangle', () => {
  const app = harness()
  app.call('desktop:browser-navigate', 'https://example.com/')
  app.call('desktop:browser-set-bounds', { x: 0, y: 0, width: 320, height: 600 })
  app.call('desktop:browser-set-bounds', null)
  assert.equal(app.view.visible, false)

  // Coming back to the tab reports the panel's rectangle again.
  app.call('desktop:browser-set-bounds', { x: 0, y: 0, width: 400, height: 500 })
  assert.equal(app.view.visible, true)
  assert.deepEqual(app.view.bounds, { x: 0, y: 0, width: 400, height: 500 })
  assert.equal(app.created.length, 1)
})

test('back, forward, reload and stop reach the live page and nothing else', () => {
  const app = harness()
  app.call('desktop:browser-navigate', 'https://example.com/')
  const contents = app.view.webContents

  // Nowhere to go yet: the request is accepted but the history decides.
  assert.deepEqual(app.call('desktop:browser-action', 'back'), { ok: true })
  assert.equal(contents.wentBack, undefined)
  contents.backAvailable = true
  contents.forwardAvailable = true
  app.call('desktop:browser-action', 'back')
  assert.equal(contents.wentBack, 1)
  app.call('desktop:browser-action', 'forward')
  assert.equal(contents.wentForward, 1)

  app.call('desktop:browser-action', 'reload')
  assert.equal(contents.reloads, 1)
  app.call('desktop:browser-action', 'stop')
  assert.equal(contents.stops, 1)
  assert.deepEqual(app.call('desktop:browser-action', 'teleport'), { ok: false, reason: 'action' })
})

test('an action before anything was navigated is a no-op, not a crash', () => {
  const app = harness()
  assert.deepEqual(app.call('desktop:browser-action', 'reload'), { ok: false })
  assert.deepEqual(app.call('desktop:browser-hide'), { ok: true })
})

test('a page that wants a new window is refused and handed to the real browser', () => {
  const app = harness()
  app.call('desktop:browser-navigate', 'https://example.com/')
  const decision = app.view.webContents.windowOpenHandler({ url: 'https://elsewhere.example/doc' })
  assert.deepEqual(decision, { action: 'deny' })
  assert.deepEqual(app.opened, ['https://elsewhere.example/doc'])
})

test('a new window pointing at a local or script URL is refused outright', () => {
  const app = harness()
  app.call('desktop:browser-navigate', 'https://example.com/')
  for (const url of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'ms-settings:', 'vscode://x']) {
    assert.deepEqual(app.view.webContents.windowOpenHandler({ url }), { action: 'deny' })
  }
  assert.deepEqual(app.opened, [], 'nothing unsafe reached the operating system')
})

test('page state is reported to the renderer as it changes', () => {
  const app = harness()
  app.call('desktop:browser-navigate', 'https://example.com/')
  const contents = app.view.webContents
  contents.title = 'Example'
  contents.loading = true
  contents.fire('did-start-loading')

  assert.equal(app.sent.length, 1)
  assert.equal(app.sent[0].channel, 'desktop:browser-updated')
  assert.deepEqual(app.sent[0].payload, {
    url: 'https://example.com/', title: 'Example', canGoBack: false, canGoForward: false, loading: true,
  })

  contents.loading = false
  contents.fire('did-stop-loading')
  assert.equal(app.sent.length, 2)
  assert.equal(app.sent[1].payload.loading, false)
})

test('a remounted panel can ask which page the live view is on', () => {
  const app = harness()
  // Nothing has been navigated yet, so there is nothing to report.
  assert.deepEqual(app.call('desktop:browser-state'), {
    ok: true,
    state: { url: '', title: '', canGoBack: false, canGoForward: false, loading: false },
  })

  app.call('desktop:browser-navigate', 'https://example.com/doc')
  const contents = app.view.webContents
  contents.title = 'Doc'
  assert.deepEqual(app.call('desktop:browser-state').state, {
    url: 'https://example.com/doc', title: 'Doc', canGoBack: false, canGoForward: false, loading: false,
  })

  // The view is hidden but still alive: the panel it belonged to went away, and
  // the page must still be there for the panel that replaces it.
  app.call('desktop:browser-hide')
  assert.equal(app.view.visible, false)
  assert.equal(app.call('desktop:browser-state').state.url, 'https://example.com/doc')
})

test('the browser IPC answers only the trusted app frame of the main window', () => {
  const app = harness()
  const otherSender = { getURL: () => `${ORIGIN}/` }
  // A different frame inside the app window, an outside origin, and a foreign
  // sender are all refused before any of them can drive the browser.
  for (const overrides of [
    { sender: otherSender },
    { senderFrame: { url: 'https://evil.example/' } },
    { senderFrame: { url: 'about:blank' } },
    { senderFrame: {} },
  ]) {
    // Every channel is gated, not just the one that loads a page.
    for (const [channel, payload] of [
      ['desktop:browser-navigate', 'https://example.com/'],
      ['desktop:browser-action', 'reload'],
      ['desktop:browser-set-bounds', { x: 0, y: 0, width: 100, height: 100 }],
      ['desktop:browser-state', undefined],
      ['desktop:browser-hide', undefined],
      ['desktop:browser-destroy', undefined],
    ]) {
      assert.throws(
        () => app.call(channel, payload, overrides),
        /untrusted desktop IPC sender|only available to the main window/u,
        `${channel} ${JSON.stringify(overrides)}`,
      )
    }
  }
  assert.equal(app.created.length, 0)
})

test('destroying the host detaches and closes the view so no native surface is left', () => {
  const app = harness()
  app.call('desktop:browser-navigate', 'https://example.com/')
  const view = app.view
  assert.deepEqual(app.call('desktop:browser-destroy'), { ok: true })

  assert.equal(view.removed, true, 'the view is taken off the window')
  assert.equal(view.webContents.closed, true, 'and its renderer is closed')
  // With nothing left, later requests are safe no-ops rather than calls into a
  // destroyed renderer.
  assert.deepEqual(app.call('desktop:browser-action', 'reload'), { ok: false })
  assert.deepEqual(app.call('desktop:browser-navigate', 'https://example.com/'), { ok: true })
  assert.equal(app.created.length, 2, 'a fresh view is created only when asked again')
})

test('closing the window tears the view down with it', () => {
  const app = harness()
  app.call('desktop:browser-navigate', 'https://example.com/')
  const view = app.view
  app.windowHandlers.get('closed')()
  assert.equal(view.removed, true)
  assert.equal(view.webContents.closed, true)
})
