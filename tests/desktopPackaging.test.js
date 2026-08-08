import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_DESKTOP_PET_LAYOUT,
  resolveDesktopPetLayout,
} from '../shared/desktopPetLayout.js'

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

test('desktop package keeps Electron isolated from renderer content', () => {
  const main = read('desktop/main.js')
  const appServer = read('server/appServer.js')
  const preload = read('desktop/preload.cjs')
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /webviewTag:\s*false/)
  assert.match(main, /assertTrustedIpc/)
  assert.match(appServer, /process\.argv\[1\]\s*&&/)
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/)
})

test('NSIS package includes server runtime dependencies and updater metadata', () => {
  const config = read('electron-builder.yml')
  const main = read('desktop/main.js')
  assert.match(config, /target:\s*nsis/)
  assert.match(config, /productName:\s*Gugo/)
  assert.match(config, /src\/data\.js/)
  assert.match(config, /^\s*-\s+src\/data\/\*\*\/\*\s*$/m)
  assert.equal(fs.existsSync(new URL('../src/data/skillCatalog.js', import.meta.url)), true)
  assert.match(config, /src\/lib\/pptCore\.js/)
  assert.match(config, /src\/lib\/presentationPlanner\.js/)
  assert.match(config, /npmRebuild:\s*false/)
  assert.match(main, /GUGO_SQLITE_DRIVER\s*=\s*'node'/)
  assert.match(config, /provider:\s*github/)
  assert.match(config, /repo:\s*Gugo/)
  assert.match(config, /channel:\s*latest/)
  assert.match(main, /sendUpdateStatus\('installing'\)/)
  assert.match(main, /bytesPerSecond:\s*Number\(progress\.bytesPerSecond/)
  assert.match(main, /transferred:\s*Number\(progress\.transferred/)
  assert.match(main, /total:\s*Number\(progress\.total/)
  assert.doesNotMatch(main, /showMessageBox/)
})

test('desktop backend startup survives installer ENOENT races and child spawn errors', () => {
  const main = read('desktop/main.js')
  const start = main.indexOf('async function startBundledServer()')
  const end = main.indexOf('async function resolveApplicationUrl()', start)
  const startup = main.slice(start, end)
  const pathGuard = startup.indexOf('await waitForDesktopRuntimeFiles(')
  const spawnCall = startup.indexOf('spawn(')

  assert.ok(start >= 0 && end > start, 'startBundledServer should remain inspectable')
  assert.ok(pathGuard >= 0, 'installed runtime files must be checked before spawning')
  assert.ok(spawnCall > pathGuard, 'spawn must run only after the installer replacement window closes')
  assert.match(startup, /child\.on\('error',[\s\S]*spawnError\s*=\s*error/)
  assert.match(startup, /if \(spawnError\)[\s\S]*spawnError\.code === 'ENOENT'[\s\S]*startInProcessBundledServer/)
})

test('desktop update stops the backend before handing control to NSIS', () => {
  const main = read('desktop/main.js')
  const start = main.indexOf("ipcMain.handle('desktop:install-update'")
  const end = main.indexOf("ipcMain.handle('desktop:set-pet-visible'", start)
  const handler = main.slice(start, end)
  const stopBackend = handler.indexOf('await stopBackend()')
  const allowQuit = handler.indexOf('allowQuit = true')
  const install = handler.indexOf('autoUpdater.quitAndInstall(false, false)')

  assert.ok(start >= 0 && end > start, 'desktop update handler should remain inspectable')
  assert.match(handler, /async\s*\(event\)/)
  assert.ok(stopBackend >= 0, 'the backend must be stopped explicitly')
  assert.ok(allowQuit > stopBackend, 'quit bypass can only be enabled after backend shutdown')
  assert.ok(install > allowQuit, 'NSIS can start only after shutdown state is committed')
  assert.doesNotMatch(main, /quitAndInstall\(false,\s*true\)/)
})

test('desktop shuts down the in-process fallback server before quitting', () => {
  const main = read('desktop/main.js')
  const start = main.indexOf('async function stopBackend()')
  const end = main.indexOf('if (hasSingleInstanceLock)', start)
  const stop = main.slice(start, end)

  assert.match(main, /backendServer\s*=\s*server/)
  assert.match(stop, /const server = backendServer/)
  assert.match(stop, /gracefulShutdown\(server, \{ exit: false \}\)/)
  assert.match(main, /if \(allowQuit \|\| \(!backendProcess && !backendServer\)\) return/)
})

test('desktop pet uses an independent transparent always-on-top window', () => {
  const main = read('desktop/main.js')
  const preload = read('desktop/preload.cjs')
  assert.match(main, /function createPetWindow/)
  assert.match(main, /transparent:\s*true/)
  assert.match(main, /alwaysOnTop:\s*true/)
  assert.match(main, /skipTaskbar:\s*true/)
  assert.match(main, /focusable:\s*false/)
  assert.match(main, /frame:\s*false/)
  assert.match(main, /setAlwaysOnTop\(true, 'floating'\)/)
  assert.match(main, /if \(!mainWindow && applicationOrigin\)/)
  assert.match(preload, /setPetVisible/)
  assert.match(preload, /resizePetWindow/)
  assert.match(preload, /dragPetWindow/)
  assert.match(preload, /updatePetStatus/)
  assert.match(preload, /showPetMenu/)
  assert.match(preload, /onPetDragCancel/)
  assert.match(main, /Menu\.buildFromTemplate/)
  assert.match(main, /desktop:show-pet-menu/)
  assert.match(main, /mainWindow\?\.webContents\.send\('desktop:pet-visibility', false\)/)
  const hidePet = main.slice(main.indexOf('function hideDesktopPet()'), main.indexOf('function desktopPetCloseLabel'))
  assert.doesNotMatch(hidePet, /app\.quit|mainWindow\?\.close|mainWindow\.close/)
})

test('desktop pet window hugs the visible sprite and scales with custom pets', () => {
  assert.deepEqual(DEFAULT_DESKTOP_PET_LAYOUT, {
    contentWidth: 73,
    contentHeight: 79,
    windowWidth: 73,
    windowHeight: 79,
    scale: 1,
  })
  assert.deepEqual(resolveDesktopPetLayout({ scale: 0.1 }), {
    contentWidth: 44,
    contentHeight: 47,
    windowWidth: 44,
    windowHeight: 47,
    scale: 0.6,
  })
  assert.deepEqual(resolveDesktopPetLayout({ customImage: true, scale: 9 }), {
    contentWidth: 173,
    contentHeight: 173,
    windowWidth: 173,
    windowHeight: 173,
    scale: 1.8,
  })
})

test('desktop pet animation updates one sprite layer without full React repaint flicker', () => {
  const main = read('desktop/main.js')
  const preload = read('desktop/preload.cjs')
  const renderer = read('src/pages/ChatSplit/DesktopPetWindow.jsx')
  const css = read('src/index.css')
  const standaloneCss = css.slice(css.indexOf('html:has(.pet-window-root)'))

  assert.match(main, /desktop:resize-pet-window/)
  assert.match(main, /desktop:pet-drag/)
  assert.match(main, /window\.setPosition\(next\.x, next\.y, false\)/)
  assert.match(main, /DEFAULT_DESKTOP_PET_LAYOUT\.windowWidth/)
  assert.match(main, /petState\.status\.kind === kind && petState\.status\.tool === tool/)
  assert.match(preload, /desktop:resize-pet-window/)
  assert.match(renderer, /spriteRef\.current/)
  assert.match(renderer, /sprite\.style\.backgroundPositionX/)
  assert.match(renderer, /playInteraction/)
  assert.match(renderer, /dragPetWindow/)
  assert.match(renderer, /onLostPointerCapture=\{handleLostPointerCapture\}/)
  assert.match(renderer, /addEventListener\('blur', cancel\)/)
  assert.match(renderer, /onPetDragCancel/)
  const pointerDown = renderer.slice(renderer.indexOf('const handlePointerDown'), renderer.indexOf('const handlePointerMove'))
  assert.match(pointerDown, /captureActivePointer\(drag\)/)
  assert.doesNotMatch(renderer, /onPointerLeave=/)
  assert.match(renderer, /data-reacting/)
  assert.doesNotMatch(renderer, /setFrame|pet-window-copy|pet-window-close/)
  assert.match(standaloneCss, /\.pet-window-root\s*\{[\s\S]*?padding:\s*0;/)
  assert.match(standaloneCss, /-webkit-app-region:\s*no-drag/)
  assert.doesNotMatch(standaloneCss, /drop-shadow|filter\s*:/)
})

test('version tags publish a Windows installer and updater metadata through GitHub Releases', () => {
  const workflow = read('.github/workflows/release.yml')
  assert.match(workflow, /runs-on:\s*windows-latest/)
  assert.match(workflow, /tags:\s*\n\s*- 'v\*\.\*\.\*'/)
  assert.match(workflow, /\.Extension -eq '\.exe'/)
  assert.match(workflow, /\.Name -eq 'latest\.yml'/)
  assert.match(workflow, /contents:\s*write/)
})

test('desktop update notice is the primary message directly above the account card', () => {
  const rail = read('src/components/leftRail/AccountArea.jsx')
  const card = read('src/components/DesktopUpdateCard.jsx')
  const accountRegion = rail.indexOf('ref={accountMenuRef}')
  const updateNotice = rail.indexOf('<DesktopUpdateCard compact={compact} />', accountRegion)
  const accountButton = rail.indexOf('aria-expanded={accountMenuOpen}', accountRegion)

  assert.ok(accountRegion >= 0)
  assert.ok(updateNotice > accountRegion)
  assert.ok(accountButton > updateNotice)
  assert.match(card, /data-desktop-update-notice="primary"/)
  assert.match(card, /border-ember\/35 bg-ember\/10/)
})
