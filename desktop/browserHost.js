import { createRequire } from 'node:module'

import { isSafeExternalUrl, isTrustedNavigation } from './security.js'
import {
  BROWSER_VIEW_PARTITION,
  BROWSER_VIEW_WEB_PREFERENCES,
  clampBrowserBounds,
  isAllowedBrowserUrl,
} from './browserViewPolicy.js'

const UPDATED_CHANNEL = 'desktop:browser-updated'

// Page facts the preview asks for: a screenshot, what a script evaluated to, and
// what the page logged. Every one of them is bounded, because all three are read
// by whoever asked and a page can produce an unbounded amount of each.
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_EVALUATE_CHARS = 64 * 1024
const CONSOLE_LIMIT = 200
const CONSOLE_MESSAGE_CHARS = 2_000

/** Electron reports console levels as numbers below 32 and as names from 32 on. */
function consoleLevelName(level) {
  if (typeof level === 'string') return level
  return ({ 0: 'debug', 1: 'info', 2: 'warning', 3: 'error' })[level] || 'info'
}

function readConsoleEntry(...args) {
  // Electron hands the page's message either as an event object or as positional
  // arguments depending on its version; both shapes end up the same here.
  const event = args[0]
  const shaped = event && typeof event === 'object' && 'message' in event
    ? { level: event.level, message: event.message, line: event.lineNumber, source: event.sourceId }
    : { level: args[0], message: args[1], line: args[2], source: args[3] }
  return {
    level: consoleLevelName(shaped.level),
    message: String(shaped.message ?? '').slice(0, CONSOLE_MESSAGE_CHARS),
    line: Number(shaped.line) || 0,
    source: String(shaped.source || '').slice(0, 300),
    at: Date.now(),
  }
}

function clampEvaluated(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text === undefined) text = String(value)
  const truncated = text.length > MAX_EVALUATE_CHARS
  return { text: truncated ? text.slice(0, MAX_EVALUATE_CHARS) : text, truncated }
}

/**
 * Electron is required lazily, on the first real use.
 *
 * `import { WebContentsView } from 'electron'` resolves only inside Electron's own
 * loader, so a static import would make this module impossible to load — and
 * therefore impossible to test — anywhere else. Deferring it keeps every decision
 * this file makes testable in plain Node, while the shipped app still reaches the
 * real Electron API. The createView/session/openExternal seams below are what the
 * tests substitute; in the app they are the defaults.
 */
let electronModule = null
function electron() {
  if (!electronModule) electronModule = createRequire(import.meta.url)('electron')
  return electronModule
}

function defaultCreateView() {
  const { WebContentsView } = electron()
  return new WebContentsView({ webPreferences: BROWSER_VIEW_WEB_PREFERENCES })
}

/**
 * Hand a vetted URL to the operating system. The caller has already decided the
 * URL may leave the app, so this only has to survive a window that has gone away
 * by the time a late link arrives.
 */
function defaultOpenExternal(url) {
  try {
    void electron().shell.openExternal(url).catch(() => {})
  } catch {
    // Nothing to do: the shell is unavailable, and the link is simply dropped.
  }
}

/**
 * Give the docked browser its own storage partition and no permissions at all.
 *
 * The view browses the open internet, so it must not share the app's session, and
 * it must never answer a camera, microphone, geolocation or notification prompt on
 * the reader's behalf. Denying outright is the only answer that cannot be wrong: a
 * granted permission would persist for every site the view later visits.
 */
export function hardenBrowserPartition(session = null) {
  const partition = (session || electron().session).fromPartition(BROWSER_VIEW_PARTITION)
  partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  return partition
}

/**
 * Owns the native Chromium view docked over the sidebar.
 *
 * The renderer never touches the view; it reports where its panel is and asks for
 * a URL. That keeps every decision — is this sender trusted, is this URL allowed,
 * is this rectangle usable — in the main process, where a page loaded in the view
 * cannot reach it.
 *
 * The view is created on first use and torn down with the window. Switching panel
 * tabs only hides it, so the page keeps its scroll position and its session
 * instead of reloading every time the reader looks away.
 */
export function createDesktopBrowserHost({
  ipcMain,
  getApplicationOrigin,
  getMainWindow,
  createView = defaultCreateView,
  session = null,
  openExternalUrl = defaultOpenExternal,
} = {}) {
  let view = null
  let dockedBounds = null
  let hardened = false
  let listenedWindow = null
  let consoleEntries = []

  function liveContents() {
    const current = view
    if (!current) return null
    const contents = current.webContents
    if (!contents || contents.isDestroyed?.()) return null
    return contents
  }

  function stateOf() {
    const contents = liveContents()
    if (!contents) return { url: '', title: '', canGoBack: false, canGoForward: false, loading: false }
    const history = contents.navigationHistory
    return {
      url: contents.getURL?.() || '',
      title: contents.getTitle?.() || '',
      canGoBack: history?.canGoBack?.() ?? contents.canGoBack?.() ?? false,
      canGoForward: history?.canGoForward?.() ?? contents.canGoForward?.() ?? false,
      loading: contents.isLoading?.() === true,
    }
  }

  function emit() {
    const window = getMainWindow?.()
    if (!window || window.isDestroyed?.()) return
    window.webContents.send(UPDATED_CHANNEL, stateOf())
  }

  function assertTrusted(event) {
    const sourceUrl = event.senderFrame?.url || event.sender?.getURL?.() || ''
    const origin = getApplicationOrigin?.() || ''
    if (!origin || !isTrustedNavigation(sourceUrl, origin)) {
      throw new Error('untrusted desktop IPC sender')
    }
    const window = getMainWindow?.()
    if (!window || window.isDestroyed?.() || event.sender !== window.webContents) {
      throw new Error('the docked browser is only available to the main window')
    }
  }

  function destroy() {
    const current = view
    view = null
    dockedBounds = null
    listenedWindow = null
    consoleEntries = []
    if (!current) return
    const window = getMainWindow?.()
    try {
      if (window && !window.isDestroyed?.()) window.contentView.removeChildView(current)
    } catch {
      // The window may already be gone; the view still has to be closed.
    }
    const contents = current.webContents
    if (contents && !contents.isDestroyed?.()) contents.close()
  }

  function ensureView() {
    const window = getMainWindow?.()
    if (!window || window.isDestroyed?.()) return null
    if (liveContents()) return view
    if (!hardened) {
      hardenBrowserPartition(session)
      hardened = true
    }

    const created = createView()
    const contents = created.webContents
    contents.setWindowOpenHandler(({ url }) => {
      // A link that wants a new window belongs in the reader's own browser: the
      // docked view is one panel, and stacking popups inside it would be a
      // second, unnamed browser wearing the app's chrome. The vetted-URL rule is
      // applied here rather than inside the opener, so the guarantee holds however
      // the app chooses to open links.
      if (isSafeExternalUrl(url)) openExternalUrl(url)
      return { action: 'deny' }
    })
    for (const name of [
      'did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page',
      'page-title-updated', 'did-fail-load',
    ]) {
      contents.on(name, emit)
    }
    // Every page's console, kept only as the tail: the preview's job is to tell
    // the agent what went wrong, and that answer is at the end of the log.
    consoleEntries = []
    contents.on('console-message', (...args) => {
      consoleEntries.push(readConsoleEntry(...args))
      if (consoleEntries.length > CONSOLE_LIMIT) consoleEntries.shift()
    })

    window.contentView.addChildView(created)
    // It must not paint until it has been given a real rectangle.
    created.setVisible?.(false)
    view = created
    dockedBounds = null

    if (listenedWindow !== window) {
      listenedWindow = window
      window.on('closed', destroy)
    }
    return view
  }

  function applyBounds(rect) {
    const current = view
    if (!current) return null
    const window = getMainWindow?.()
    if (!window || window.isDestroyed?.()) return null
    const [contentWidth, contentHeight] = window.getContentSize?.() || []
    const bounds = clampBrowserBounds(rect, { contentWidth, contentHeight })
    if (!bounds) {
      // Not merely invisible: the view is a native surface above the page, so an
      // unusable rectangle must actually hide it or it keeps painting over
      // whatever the reader switched to.
      dockedBounds = null
      current.setVisible?.(false)
      return null
    }
    dockedBounds = bounds
    current.setBounds(bounds)
    current.setVisible?.(true)
    return bounds
  }

  function register() {
    ipcMain.handle('desktop:browser-navigate', (event, url) => {
      assertTrusted(event)
      if (!isAllowedBrowserUrl(url)) return { ok: false, reason: 'url' }
      const created = ensureView()
      const contents = created?.webContents
      if (!contents) return { ok: false, reason: 'window' }
      if (dockedBounds) applyBounds(dockedBounds)
      void contents.loadURL(String(url)).catch(() => {})
      return { ok: true }
    })
    ipcMain.handle('desktop:browser-action', (event, action) => {
      assertTrusted(event)
      const contents = liveContents()
      if (!contents) return { ok: false }
      const history = contents.navigationHistory
      if (action === 'back') {
        if (history?.canGoBack?.()) history.goBack()
        else contents.goBack?.()
      } else if (action === 'forward') {
        if (history?.canGoForward?.()) history.goForward()
        else contents.goForward?.()
      } else if (action === 'reload') contents.reload?.()
      else if (action === 'stop') contents.stop?.()
      else return { ok: false, reason: 'action' }
      return { ok: true }
    })
    ipcMain.handle('desktop:browser-set-bounds', (event, rect) => {
      assertTrusted(event)
      // A rectangle arriving before anything was navigated is the renderer saying
      // its panel moved, so the view is created to have something to place.
      if (!view && rect) ensureView()
      return { ok: true, bounds: applyBounds(rect) }
    })
    ipcMain.handle('desktop:browser-state', (event) => {
      assertTrusted(event)
      // A panel that is remounted has an empty address bar of its own, while the
      // page it left behind is still loaded. Asking is how it picks the page back
      // up instead of showing a blank panel over a live view.
      return { ok: true, state: stateOf() }
    })
    /**
     * Page facts, for the preview and for the agent verifying through it.
     *
     * The sender is the app's own window, which relays what the backend asked
     * for — the same trust path the browser controls already use. The page itself
     * cannot reach these channels: it is a sandboxed view with no preload, so the
     * only way in is through the renderer that is already allowed to drive the
     * panel.
     */
    ipcMain.handle('desktop:preview-capture', async (event) => {
      assertTrusted(event)
      const contents = liveContents()
      if (!contents) return { ok: false, reason: 'no-view' }
      try {
        const image = await contents.capturePage()
        const size = image?.getSize?.() || {}
        const png = image?.toPNG?.()
        if (!png?.length) return { ok: false, reason: 'empty' }
        // A whole-screen page can exceed what an IPC message should carry; better
        // to say so than to make the main process allocate it.
        if (png.length > MAX_CAPTURE_BYTES) return { ok: false, reason: 'too-large', bytes: png.length }
        return {
          ok: true,
          width: Number(size.width) || 0,
          height: Number(size.height) || 0,
          dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
        }
      } catch (error) {
        return { ok: false, reason: 'capture-failed', message: error?.message || String(error) }
      }
    })
    ipcMain.handle('desktop:preview-evaluate', async (event, script) => {
      assertTrusted(event)
      const contents = liveContents()
      if (!contents) return { ok: false, reason: 'no-view' }
      if (typeof script !== 'string' || !script.trim()) return { ok: false, reason: 'script' }
      try {
        // userGesture=false: reading the page must not let it take actions only a
        // real click should allow.
        const value = await contents.executeJavaScript(script, false)
        const { text, truncated } = clampEvaluated(value)
        return { ok: true, result: text, truncated }
      } catch (error) {
        return { ok: false, reason: 'evaluate-failed', message: error?.message || String(error) }
      }
    })
    ipcMain.handle('desktop:preview-console', (event, options) => {
      assertTrusted(event)
      const entries = consoleEntries.slice()
      if (options?.clear === true) consoleEntries = []
      return { ok: true, entries }
    })
    ipcMain.handle('desktop:browser-hide', (event) => {
      assertTrusted(event)
      view?.setVisible?.(false)
      return { ok: true }
    })
    ipcMain.handle('desktop:browser-destroy', (event) => {
      assertTrusted(event)
      destroy()
      return { ok: true }
    })
  }

  return { destroy, register }
}
