import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session, shell } from 'electron'
import updaterPackage from 'electron-updater'
import {
  isSafeExternalUrl,
  isTrustedNavigation,
  resolveDesktopDevUrl,
} from './security.js'
import {
  ensureDesktopRuntimeConfigFile,
  probeDesktopRuntimeMode,
  resolveDesktopDataPaths,
  resolveDesktopPluginRoots,
  resolveDesktopPort,
  waitForDesktopRuntimeFiles,
} from './runtime.js'
import {
  DEFAULT_DESKTOP_PET_LAYOUT,
  resolveDesktopPetLayout,
} from '../shared/desktopPetLayout.js'
import {
  createDesktopPetDragSession,
  resolveDesktopPetDragMove,
} from './petDrag.js'
import { createDesktopUpdateRuntime } from './updateRuntime.js'

const { autoUpdater } = updaterPackage
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const preloadPath = path.join(__dirname, 'preload.cjs')
const appIconPath = path.join(__dirname, '..', 'build', 'icon.ico')

let mainWindow = null
let petWindow = null
let backendProcess = null
let backendServer = null
let applicationOrigin = null
let updateReady = false
let desktopUpdateRuntime = null
let allowQuit = false
let shutdownPromise = null
let petState = { visible: false, status: { kind: 'idle', tool: '' } }
let petDragState = null

function cancelPetDrag({ notifyRenderer = true } = {}) {
  const drag = petDragState
  petDragState = null
  if (!drag || !notifyRenderer || !petWindow || petWindow.isDestroyed()) return
  petWindow.webContents.send('desktop:pet-drag-cancel')
}

function hideDesktopPet() {
  applyPetVisibility(false)
  mainWindow?.webContents.send('desktop:pet-visibility', false)
}

function desktopPetCloseLabel(locale = app.getLocale()) {
  const language = String(locale || '').toLowerCase()
  if (language.startsWith('zh')) return '关闭宠物'
  if (language.startsWith('ja')) return 'ペットを閉じる'
  if (language.startsWith('ko')) return '펫 닫기'
  return 'Close pet'
}

function showDesktopPetMenu() {
  const window = petWindow
  if (!window || window.isDestroyed() || !window.isVisible()) return false
  cancelPetDrag()
  Menu.buildFromTemplate([{
    label: desktopPetCloseLabel(),
    click: hideDesktopPet,
  }]).popup({ window })
  return true
}

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
  const defaultWorkspaceRoot = path.join(app.getPath('documents'), 'Gugo')
  mkdirSync(defaultWorkspaceRoot, { recursive: true })
  process.env.WORKSPACE_ROOT ||= defaultWorkspaceRoot
  process.env.GUGO_FFMPEG_PATH ||= path.join(process.resourcesPath, 'bin', 'ffmpeg.exe')
  process.env.GUGO_FFPROBE_PATH ||= path.join(process.resourcesPath, 'bin', 'ffprobe.exe')
  if (pluginRoots.length) process.env.CODEX_PLUGIN_ROOTS = JSON.stringify(pluginRoots)
  return port
}

async function startInProcessBundledServer(origin, startupCause) {
  console.warn('[desktop] child server unavailable; using in-process fallback:', startupCause?.message)
  const { startRuntimeServer } = await import(
    '../server/services/runtimeServerStartup.js'
  )
  const cwd = app.getAppPath()
  const env = process.env
  const server = await startRuntimeServer({ cwd, env })
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
        if (await probeDesktopRuntimeMode(origin)) {
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
      if (await probeDesktopRuntimeMode(origin)) return origin
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
    focusable: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    icon: appIconPath,
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
  window.setMovable(true)
  secureWebContents(window.webContents)
  window.on('blur', () => cancelPetDrag())
  window.on('hide', () => cancelPetDrag())
  window.on('moved', () => {
    const next = window.getBounds()
    void import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(stored, 'pet-window.json'), JSON.stringify({ x: next.x, y: next.y }))).catch(() => {})
  })
  window.on('closed', () => {
    cancelPetDrag({ notifyRenderer: false })
    if (petWindow === window) petWindow = null
  })
  window.webContents.on('render-process-gone', () => cancelPetDrag({ notifyRenderer: false }))
  window.webContents.on('destroyed', () => cancelPetDrag({ notifyRenderer: false }))
  window.webContents.on('did-finish-load', sendPetState)
  petWindow = window
  void window.loadURL(`${applicationOrigin}/?gugoPet=1`)
  return window
}

function applyPetVisibility(visible) {
  petState = { ...petState, visible: visible === true }
  if (!petState.visible) {
    const window = petWindow
    cancelPetDrag({ notifyRenderer: false })
    // A hidden Chromium window can retain pointer capture on Windows. Reusing
    // that renderer makes the next pet impossible to drag and can swallow
    // clicks intended for other applications. Destroying the tiny independent
    // window releases the OS capture deterministically; the next show creates
    // a fresh renderer while preserving the saved desktop position.
    if (window && !window.isDestroyed()) window.destroy()
    return
  }
  cancelPetDrag({ notifyRenderer: false })
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
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return
  const phase = String(payload?.phase || '')

  if (phase === 'end') {
    cancelPetDrag({ notifyRenderer: false })
    return
  }
  if (phase === 'start') {
    petDragState = createDesktopPetDragSession({
      senderId: event.sender.id,
      cursor: screen.getCursorScreenPoint(),
      bounds: window.getBounds(),
    })
    return
  }
  const drag = petDragState
  if (phase !== 'move' || !drag || drag.senderId !== event.sender.id) return
  const move = resolveDesktopPetDragMove(drag, screen.getCursorScreenPoint())
  if (!move.accepted) {
    // The renderer can receive synthetic pointer movement when its transparent
    // BrowserWindow is composited. If the OS cursor never moved, end the pending
    // gesture so it cannot acquire a global pointer capture and swallow clicks.
    if (!drag.moved && move.reason === 'stationary') cancelPetDrag()
    return
  }
  petDragState = move.session
  // Do not clamp while the user is dragging. Clamping against the display
  // currently containing the window pins it to that monitor and prevents the
  // cursor from ever crossing onto an adjacent display. Reapplying the frozen
  // width and height also prevents a resize/drag feedback loop from expanding
  // the transparent hit area.
  window.setBounds(move.bounds, false)
}

function registerDesktopIpc() {
  ipcMain.handle('desktop:write-clipboard-text', (event, value) => {
    assertTrustedIpc(event)
    clipboard.writeText(String(value ?? ''))
    return { copied: true }
  })
  ipcMain.handle('desktop:select-directory', async (event, payload = {}) => {
    assertTrustedIpc(event)
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error('desktop directory picker is only available to the main window')
    }
    const requestedDefaultPath = String(payload?.defaultPath || '').trim().slice(0, 2048)
    const defaultPath = requestedDefaultPath && path.isAbsolute(requestedDefaultPath)
      ? path.normalize(requestedDefaultPath)
      : null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目根目录',
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate', 'dontAddToRecent'],
    })
    const selectedPath = result.canceled ? '' : String(result.filePaths?.[0] || '').trim()
    return selectedPath
      ? { canceled: false, path: path.normalize(selectedPath) }
      : { canceled: true, path: '' }
  })
  ipcMain.handle('desktop:get-version', (event) => {
    assertTrustedIpc(event)
    return app.getVersion()
  })
  ipcMain.handle('desktop:open-config-file', async (event) => {
    assertTrustedIpc(event)
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error('desktop runtime config is only available to the main window')
    }
    const configPath = ensureDesktopRuntimeConfigFile({ userData: app.getPath('userData') })
    const openError = await shell.openPath(configPath)
    if (openError) throw new Error(`unable to open desktop runtime config: ${openError}`)
    return { opened: true }
  })
  ipcMain.handle('desktop:check-for-updates', async (event) => {
    assertTrustedIpc(event)
    if (!app.isPackaged || !desktopUpdateRuntime) return { supported: false }
    await desktopUpdateRuntime.checkForUpdates()
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
  ipcMain.handle('desktop:show-pet-menu', (event) => {
    assertTrustedIpc(event)
    if (!petWindow || petWindow.isDestroyed() || event.sender !== petWindow.webContents) return { shown: false }
    return { shown: showDesktopPetMenu() }
  })
  ipcMain.handle('desktop:resize-pet-window', (event, preferences) => {
    assertTrustedIpc(event)
    const layout = resolveDesktopPetLayout(preferences)
    const window = petWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return layout
    cancelPetDrag()
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
    hideDesktopPet()
    return { visible: false }
  })
}

function configureDesktopUpdates() {
  if (!app.isPackaged) return

  // The built-in downloader discards a stalled differential transfer and then
  // starts the whole installer again. Keep electron-updater for release checks
  // and NSIS installation, while the desktop runtime owns resumable downloads.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // Community builds are currently unsigned: keep publisherName absent so the updater
  // uses GitHub HTTPS plus latest.yml SHA-512 integrity checks without a false signer claim.
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  try {
    desktopUpdateRuntime = createDesktopUpdateRuntime({
      updater: autoUpdater,
      updateBaseUrl: process.env.GUGO_UPDATE_BASE_URL,
      onStatus(payload = {}) {
        const { status, ...details } = payload
        if (status) sendUpdateStatus(status, details)
      },
    })
  } catch (error) {
    sendUpdateStatus('error', { message: error?.message || 'update runtime configuration failed' })
    return
  }
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }))
  autoUpdater.on('update-not-available', () => sendUpdateStatus('current'))
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true
    sendUpdateStatus('ready', { version: info.version })
  })
  autoUpdater.on('error', (error) => sendUpdateStatus('error', { message: error?.message || 'update failed' }))

  // Local-first default: configuring the updater must not contact a release
  // server. The only check entry point is the trusted IPC handler above,
  // invoked after the user explicitly chooses "check and download".
}

async function launch() {
  applicationOrigin = await resolveApplicationUrl()
  configurePermissions()
  mainWindow = createMainWindow()
  await mainWindow.loadURL(applicationOrigin)
  configureDesktopUpdates()
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
