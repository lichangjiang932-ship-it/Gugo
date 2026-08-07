import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, screen, session, shell } from 'electron'
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
  waitForDesktopRuntimeFiles,
} from './runtime.js'
import {
  DEFAULT_DESKTOP_PET_LAYOUT,
  resolveDesktopPetLayout,
} from '../shared/desktopPetLayout.js'

const { autoUpdater } = updaterPackage
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const preloadPath = path.join(__dirname, 'preload.cjs')
const UPDATE_INTERVAL_MS = 15 * 60 * 1000

let mainWindow = null
let petWindow = null
let backendProcess = null
let backendServer = null
let applicationOrigin = null
let updateReady = false
let allowQuit = false
let shutdownPromise = null
let petState = { visible: false, status: { kind: 'idle', tool: '' } }
let petDragState = null

function clampPetBounds(bounds) {
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
    width: bounds.width,
    height: bounds.height,
  }
}

function sendPetState() {
  if (!petWindow || petWindow.isDestroyed()) return
  petWindow.webContents.send('desktop:pet-state', petState)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

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
  // A packaged app can be installed next to a source checkout. Never treat a
  // neighbouring developer .env as the desktop user's model configuration.
  process.env.GUGO_LOAD_DOTENV = '0'
  process.env.GUGO_SQLITE_DRIVER = 'node'
  process.env.SERVER_HOST = '127.0.0.1'
  process.env.SERVER_PORT = String(port)
  process.env.APP_DATA_DIR ||= paths.dataDir
  process.env.APP_DB_PATH ||= paths.database
  process.env.ARTIFACT_DIR ||= paths.artifacts
  if (pluginRoots.length) process.env.CODEX_PLUGIN_ROOTS = JSON.stringify(pluginRoots)
  return port
}

async function startInProcessBundledServer(origin, startupCause) {
  console.warn('[desktop] child server unavailable; using in-process fallback:', startupCause?.message)
  const { applyRuntimeConfig } = await import('../server/utils/runtimeEnv.js')
  applyRuntimeConfig()
  const { startAppServer } = await import('../server/appServer.js')
  const server = startAppServer()
  if (!server) {
    throw new Error('Gugo 应用服务无法启动，请重新安装或修复 Gugo。', { cause: startupCause })
  }

  backendServer = server
  let serverError = null
  const rememberServerError = (error) => { serverError = error }
  server.on('error', rememberServerError)

  try {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (serverError) throw serverError
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_500) })
        if (response.ok) {
          server.off('error', rememberServerError)
          return origin
        }
      } catch (error) {
        if (serverError) throw serverError
        if (error?.name !== 'TimeoutError' && error?.name !== 'TypeError') throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('Gugo 应用服务启动超时。')
  } catch (error) {
    server.off('error', rememberServerError)
    if (backendServer === server) backendServer = null
    try {
      const { gracefulShutdown } = await import('../server/core/lifecycle.js')
      await gracefulShutdown(server, { exit: false })
    } catch { /* preserve the original startup error */ }
    throw error
  }
}

async function startBundledServer() {
  const port = configureDesktopRuntime()
  const origin = `http://127.0.0.1:${port}`
  const appPath = app.getAppPath()
  const entry = path.join(appPath, 'server', 'start.js')
  try {
    await waitForDesktopRuntimeFiles({ executablePath: process.execPath, entryPath: entry })
  } catch (error) {
    const entryMissing = error?.missingPaths?.includes(entry)
    if (error?.code === 'ENOENT' && !entryMissing) return startInProcessBundledServer(origin, error)
    throw error
  }
  const child = spawn(process.execPath, [entry], {
    cwd: appPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backendProcess = child
  let startupError = ''
  let spawnError = null
  child.stderr?.on('data', (chunk) => {
    startupError = `${startupError}${String(chunk)}`.slice(-4_000)
  })
  // Spawn failures are emitted asynchronously. Keeping a listener attached
  // prevents updater ENOENT races from becoming uncaught Electron errors.
  child.on('error', (error) => {
    spawnError = error
    if (backendProcess === child) backendProcess = null
    if (applicationOrigin) {
      sendUpdateStatus('backend-error', { message: error?.message || '本地服务启动失败' })
    }
  })
  child.once('exit', (code, signal) => {
    if (backendProcess === child) backendProcess = null
    if (!allowQuit && applicationOrigin) {
      sendUpdateStatus('backend-error', { message: `本地服务已退出（${code ?? signal ?? 'unknown'}）` })
    }
  })

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (spawnError) {
      if (spawnError.code === 'ENOENT') return startInProcessBundledServer(origin, spawnError)
      throw spawnError
    }
    if (child.exitCode !== null) {
      throw new Error(startupError.trim() || `应用服务启动失败（退出码 ${child.exitCode}）`)
    }
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_500) })
      if (response.ok) return origin
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (child.exitCode === null && !spawnError) child.kill()
  throw new Error('应用服务启动超时。')
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
    backgroundColor: '#ffffff',
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

function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) return petWindow
  const stored = app.getPath('userData')
  const defaultBounds = {
    x: 80,
    y: 80,
    width: DEFAULT_DESKTOP_PET_LAYOUT.windowWidth,
    height: DEFAULT_DESKTOP_PET_LAYOUT.windowHeight,
  }
  let bounds = defaultBounds
  try {
    const saved = JSON.parse(readFileSync(path.join(stored, 'pet-window.json'), 'utf8'))
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) bounds = { ...defaultBounds, x: saved.x, y: saved.y }
  } catch { /* use the safe default */ }
  bounds = clampPetBounds(bounds)

  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  })
  window.setAlwaysOnTop(true, 'floating')
  secureWebContents(window.webContents)
  window.on('moved', () => {
    const next = clampPetBounds(window.getBounds())
    if (next.x !== window.getBounds().x || next.y !== window.getBounds().y) window.setBounds(next)
    void import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(stored, 'pet-window.json'), JSON.stringify({ x: next.x, y: next.y }))).catch(() => {})
  })
  window.on('closed', () => { if (petWindow === window) petWindow = null })
  window.webContents.on('did-finish-load', sendPetState)
  petWindow = window
  void window.loadURL(`${applicationOrigin}/?gugoPet=1`)
  return window
}

function applyPetVisibility(visible) {
  petState = { ...petState, visible: visible === true }
  if (!petState.visible) {
    petWindow?.hide()
    return
  }
  const window = createPetWindow()
  if (window.webContents.isLoading()) window.once('ready-to-show', () => window.showInactive())
  else window.showInactive()
  sendPetState()
}

function assertTrustedIpc(event) {
  const sourceUrl = event.senderFrame?.url || event.sender?.getURL()
  if (!isTrustedNavigation(sourceUrl, applicationOrigin)) throw new Error('untrusted desktop IPC sender')
}

function handlePetDrag(event, payload = {}) {
  assertTrustedIpc(event)
  const window = petWindow
  if (!window || window.isDestroyed()) return
  const phase = String(payload?.phase || '')
  const screenX = Number(payload?.screenX)
  const screenY = Number(payload?.screenY)

  if (phase === 'end') {
    petDragState = null
    return
  }
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return
  if (phase === 'start') {
    petDragState = {
      senderId: event.sender.id,
      startX: screenX,
      startY: screenY,
      origin: window.getBounds(),
    }
    return
  }
  const drag = petDragState
  if (phase !== 'move' || !drag || drag.senderId !== event.sender.id) return
  const next = clampPetBounds({
    ...drag.origin,
    x: Math.round(drag.origin.x + screenX - drag.startX),
    y: Math.round(drag.origin.y + screenY - drag.startY),
  })
  window.setPosition(next.x, next.y, false)
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
  ipcMain.handle('desktop:install-update', async (event) => {
    assertTrustedIpc(event)
    if (!updateReady) return { ready: false }
    sendUpdateStatus('installing')
    try {
      await stopBackend()
      allowQuit = true
      setImmediate(() => {
        try {
          autoUpdater.quitAndInstall(false, false)
        } catch (error) {
          allowQuit = false
          sendUpdateStatus('error', { message: error?.message || '更新安装失败' })
        }
      })
    } catch (error) {
      sendUpdateStatus('error', { message: error?.message || '无法停止本地服务' })
      return { ready: false, error: error?.message || 'backend shutdown failed' }
    }
    return { ready: true }
  })
  ipcMain.handle('desktop:set-pet-visible', (event, visible) => {
    assertTrustedIpc(event)
    applyPetVisibility(visible)
    return { visible: petState.visible }
  })
  ipcMain.on('desktop:pet-drag', handlePetDrag)
  ipcMain.handle('desktop:resize-pet-window', (event, preferences) => {
    assertTrustedIpc(event)
    const layout = resolveDesktopPetLayout(preferences)
    const window = petWindow
    if (!window || window.isDestroyed()) return layout
    const current = window.getBounds()
    if (current.width === layout.windowWidth && current.height === layout.windowHeight) return layout
    const next = clampPetBounds({
      x: Math.round(current.x + (current.width - layout.windowWidth) / 2),
      y: current.y + current.height - layout.windowHeight,
      width: layout.windowWidth,
      height: layout.windowHeight,
    })
    window.setBounds(next)
    return layout
  })
  ipcMain.handle('desktop:update-pet-status', (event, status) => {
    assertTrustedIpc(event)
    const kind = ['idle', 'thinking', 'tool', 'completed', 'failed'].includes(status?.kind) ? status.kind : 'idle'
    const tool = kind === 'tool' ? String(status?.tool || '').slice(0, 80) : ''
    if (petState.status.kind === kind && petState.status.tool === tool) return petState.status
    petState = { ...petState, status: { kind, tool } }
    sendPetState()
    return petState.status
  })
  ipcMain.handle('desktop:get-pet-state', (event) => {
    assertTrustedIpc(event)
    return petState
  })
  ipcMain.handle('desktop:hide-pet', (event) => {
    assertTrustedIpc(event)
    applyPetVisibility(false)
    mainWindow?.webContents.send('desktop:pet-visibility', false)
    return { visible: false }
  })
}

function configureAutoUpdates() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }))
  autoUpdater.on('update-not-available', () => sendUpdateStatus('current'))
  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus('downloading', {
      percent: Number(progress.percent || 0),
      bytesPerSecond: Number(progress.bytesPerSecond || 0),
      transferred: Number(progress.transferred || 0),
      total: Number(progress.total || 0),
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true
    sendUpdateStatus('ready', { version: info.version })
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
  const child = backendProcess
  const server = backendServer
  backendProcess = null
  backendServer = null

  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([
      once(child, 'exit').catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
  }

  if (server) {
    const { gracefulShutdown } = await import('../server/core/lifecycle.js')
    await gracefulShutdown(server, { exit: false })
  }
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
    if (!mainWindow && applicationOrigin) {
      mainWindow = createMainWindow()
      void mainWindow.loadURL(applicationOrigin)
    }
  })

  app.on('before-quit', (event) => {
    if (allowQuit || (!backendProcess && !backendServer)) return
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
