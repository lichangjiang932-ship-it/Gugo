import { createRequire } from 'node:module'

import { isSafeExternalUrl, isTrustedNavigation } from './security.js'
import {
  BROWSER_VIEW_PARTITION,
  BROWSER_VIEW_WEB_PREFERENCES,
  clampBrowserBounds,
  isAllowedBrowserUrl,
} from './browserViewPolicy.js'

const UPDATED_CHANNEL = 'desktop:browser-updated'

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
