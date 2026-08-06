import path from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import updaterPackage from 'electron-updater'
import {
  isSafeExternalUrl,
  isTrustedNavigation,
  resolveDesktopDevUrl,
} from './security.js'
import {
  resolveDesktopDataPaths,
  resolveDesktopPluginRoots,
  resolveDesktopPort,
} from './runtime.js'

const { autoUpdater } = updaterPackage
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const preloadPath = path.join(__dirname, 'preload.cjs')
const UPDATE_INTERVAL_MS = 15 * 60 * 1000
const UPDATE_COPY = {
  zh: { title: 'Gugo 更新已就绪', detail: '新版本 {version} 已下载。是否立即重启并完成更新？', install: '立即重启更新', later: '稍后' },
  en: { title: 'Gugo update ready', detail: 'Version {version} is downloaded. Restart now to finish updating?', install: 'Restart and update', later: 'Later' },
  ja: { title: 'Gugo の更新準備が完了しました', detail: 'バージョン {version} をダウンロードしました。今すぐ再起動して更新しますか？', install: '再起動して更新', later: '後で' },
  ko: { title: 'Gugo 업데이트 준비 완료', detail: '버전 {version} 다운로드가 완료되었습니다. 지금 다시 시작하여 업데이트할까요?', install: '다시 시작 및 업데이트', later: '나중에' },
  'zh-TW': { title: 'Gugo 更新已就緒', detail: '新版本 {version} 已下載。是否立即重新啟動並完成更新？', install: '立即重啟更新', later: '稍後' },
}

let mainWindow = null
let backendServer = null
let gracefulShutdown = null
let applicationOrigin = null
let updateReady = false
let updatePromptOpen = false
let allowQuit = false
let shutdownPromise = null

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

function localizedUpdateCopy() {
  const locale = String(app.getLocale() || 'zh').toLowerCase()
  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk')) return UPDATE_COPY['zh-TW']
  if (locale.startsWith('ja')) return UPDATE_COPY.ja
  if (locale.startsWith('ko')) return UPDATE_COPY.ko
  if (locale.startsWith('en')) return UPDATE_COPY.en
  return UPDATE_COPY.zh
}

function sendUpdateStatus(status, details = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('desktop:update-status', { status, ...details })
}

function openExternalUrl(url) {
  if (!isSafeExternalUrl(url)) return
  void shell.openExternal(url).catch(() => {})
}

function secureWebContents(webContents) {
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

function configureDesktopRuntime() {
  const paths = resolveDesktopDataPaths(app.getPath('userData'))
  const port = resolveDesktopPort(process.env.GUGO_DESKTOP_PORT)
  const pluginRoots = resolveDesktopPluginRoots({
    configured: process.env.CODEX_PLUGIN_ROOTS,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    homeDir: app.getPath('home'),
    documentsDir: app.getPath('documents'),
  })

  process.env.NODE_ENV = 'production'
  process.env.GUGO_SQLITE_DRIVER = 'node'
  process.env.SERVER_HOST = '127.0.0.1'
  process.env.SERVER_PORT = String(port)
  process.env.APP_DATA_DIR ||= paths.dataDir
  process.env.APP_DB_PATH ||= paths.database
  process.env.ARTIFACT_DIR ||= paths.artifacts
  if (pluginRoots.length) process.env.CODEX_PLUGIN_ROOTS = JSON.stringify(pluginRoots)
  return port
}

async function startBundledServer() {
  const port = configureDesktopRuntime()
  const [{ startAppServer }, lifecycle] = await Promise.all([
    import('../server/appServer.js'),
    import('../server/core/lifecycle.js'),
  ])
  const server = startAppServer()
  if (!server) throw new Error('应用服务启动失败：缺少前端构建产物。')

  if (!server.listening) {
    await Promise.race([
      once(server, 'listening'),
      once(server, 'error').then(([error]) => Promise.reject(error)),
    ])
  }

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('应用服务未返回有效的本地端口。')
  }

  backendServer = server
  gracefulShutdown = lifecycle.gracefulShutdown
  return `http://127.0.0.1:${port}`
}

async function resolveApplicationUrl() {
  const devUrl = resolveDesktopDevUrl(process.env.YMA_DESKTOP_DEV_URL)
  if (devUrl) return devUrl
  return startBundledServer()
}

function configurePermissions() {
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

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#111111',
    autoHideMenuBar: true,
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

  secureWebContents(window.webContents)
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  return window
}

function assertTrustedIpc(event) {
  const sourceUrl = event.senderFrame?.url || event.sender?.getURL()
  if (!isTrustedNavigation(sourceUrl, applicationOrigin)) throw new Error('untrusted desktop IPC sender')
}

function registerDesktopIpc() {
  ipcMain.handle('desktop:get-version', (event) => {
    assertTrustedIpc(event)
    return app.getVersion()
  })
  ipcMain.handle('desktop:check-for-updates', async (event) => {
    assertTrustedIpc(event)
    if (!app.isPackaged) return { supported: false }
    await autoUpdater.checkForUpdates()
    return { supported: true }
  })
  ipcMain.handle('desktop:install-update', (event) => {
    assertTrustedIpc(event)
    if (!updateReady) return { ready: false }
    autoUpdater.quitAndInstall(false, true)
    return { ready: true }
  })
}

async function promptForDownloadedUpdate(info) {
  if (updatePromptOpen || !mainWindow || mainWindow.isDestroyed()) return
  updatePromptOpen = true
  const copy = localizedUpdateCopy()
  try {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: copy.title,
      message: copy.title,
      detail: copy.detail.replace('{version}', info.version || ''),
      buttons: [copy.install, copy.later],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (result.response === 0) autoUpdater.quitAndInstall(false, true)
  } finally {
    updatePromptOpen = false
  }
}

function configureAutoUpdates() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }))
  autoUpdater.on('update-not-available', () => sendUpdateStatus('current'))
  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus('downloading', { percent: Math.round(progress.percent || 0) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true
    sendUpdateStatus('ready', { version: info.version })
    void promptForDownloadedUpdate(info)
  })
  autoUpdater.on('error', (error) => sendUpdateStatus('error', { message: error?.message || 'update failed' }))

  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 10_000).unref()
  setInterval(check, UPDATE_INTERVAL_MS).unref()
}

async function launch() {
  applicationOrigin = await resolveApplicationUrl()
  configurePermissions()
  mainWindow = createMainWindow()
  await mainWindow.loadURL(applicationOrigin)
  configureAutoUpdates()
}

async function stopBackend() {
  const server = backendServer
  backendServer = null
  if (!server || !gracefulShutdown) return
  await gracefulShutdown(server, { silent: true, exit: false })
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.gugo.atelier')
    registerDesktopIpc()
    try {
      await launch()
    } catch (error) {
      dialog.showErrorBox('Gugo 无法启动', error?.message || '桌面应用启动失败')
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && applicationOrigin) {
      mainWindow = createMainWindow()
      void mainWindow.loadURL(applicationOrigin)
    }
  })

  app.on('before-quit', (event) => {
    if (allowQuit || !backendServer) return
    event.preventDefault()
    if (!shutdownPromise) {
      shutdownPromise = stopBackend().finally(() => {
        allowQuit = true
        app.quit()
      })
    }
  })

  app.on('window-all-closed', () => app.quit())
}
