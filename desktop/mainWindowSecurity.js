import { BrowserWindow, session, shell } from 'electron'

import { isSafeExternalUrl, isTrustedNavigation } from './security.js'

function openExternalUrl(url) {
  if (!isSafeExternalUrl(url)) return
  void shell.openExternal(url).catch(() => {})
}

export function secureDesktopWebContents(webContents, { applicationOrigin }) {
  webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  const guardNavigation = (event, url) => {
    if (isTrustedNavigation(url, applicationOrigin)) return
    event.preventDefault()
    openExternalUrl(url)
  }

  webContents.on('will-navigate', guardNavigation)
  webContents.on('will-redirect', guardNavigation)
  webContents.on('will-attach-webview', (event) => event.preventDefault())
}

export function configureDesktopMainWindowPermissions({ applicationOrigin }) {
  const allowed = new Set(['media', 'notifications'])
  const isAllowed = (webContents, permission, requestingUrl) => allowed.has(permission)
    && isTrustedNavigation(requestingUrl || webContents?.getURL(), applicationOrigin)

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isAllowed(webContents, permission, details.requestingUrl))
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
    isAllowed(webContents, permission, requestingOrigin)
  ))
}

export function createDesktopMainWindow({ applicationOrigin, appIconPath, preloadPath }) {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: appIconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  })

  secureDesktopWebContents(window.webContents, { applicationOrigin })
  window.once('ready-to-show', () => window.show())
  return window
}
