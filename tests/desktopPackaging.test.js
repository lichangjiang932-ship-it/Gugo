import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_DESKTOP_PET_LAYOUT,
  resolveDesktopPetLayout,
} from '../shared/desktopPetLayout.js'
import {
  createDesktopPetDragSession,
  resolveDesktopPetDragMove,
} from '../desktop/petDrag.js'
import {
  resolveLockedMediaSidecar,
  stageMediaSidecars,
  WINDOWS_MEDIA_SIDECARS,
} from '../scripts/prepare-media-sidecars.mjs'

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
  assert.match(main, /desktop:write-clipboard-text/)
  assert.match(main, /clipboard\.writeText/)
  assert.match(preload, /writeClipboardText/)
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
  assert.match(config, /^\s*-\s+desktop\/petDrag\.js\s*$/m)
  assert.match(config, /npmRebuild:\s*false/)
  assert.match(config, /asarUnpack:[\s\S]*node_modules\/sharp\/\*\*\/\*/)
  assert.match(config, /asarUnpack:[\s\S]*node_modules\/@img\/\*\*\/\*/)
  assert.match(config, /^\s*icon:\s*build\/icon\.ico\s*$/m)
  assert.match(config, /^\s*installerIcon:\s*build\/icon\.ico\s*$/m)
  assert.match(config, /^\s*uninstallerIcon:\s*build\/icon\.ico\s*$/m)
  const icon = fs.readFileSync(new URL('../build/icon.ico', import.meta.url))
  assert.deepEqual([...icon.subarray(0, 4)], [0, 0, 1, 0])
  assert.ok(icon.length > 1024)
  assert.match(main, /const appIconPath = path\.join\(__dirname, '\.\.', 'build', 'icon\.ico'\)/)
  assert.equal((main.match(/icon:\s*appIconPath/g) || []).length, 2)
  assert.match(main, /GUGO_SQLITE_DRIVER\s*=\s*'node'/)
  assert.match(config, /provider:\s*github/)
  assert.match(config, /repo:\s*Gugo/)
  assert.match(config, /channel:\s*latest/)
  assert.match(main, /sendUpdateStatus\('installing'\)/)
  assert.match(main, /bytesPerSecond:\s*Number\(progress\.bytesPerSecond/)
  assert.match(main, /transferred:\s*Number\(progress\.transferred/)
  assert.match(main, /total:\s*Number\(progress\.total/)
  assert.match(main, /autoUpdater\.allowPrerelease\s*=\s*false/)
  assert.match(main, /autoUpdater\.allowDowngrade\s*=\s*false/)
  assert.doesNotMatch(config, /publisherName|certificateFile|certificatePassword/)
  assert.doesNotMatch(config, /verifyUpdateCodeSignature:\s*false/)
  assert.doesNotMatch(main, /showMessageBox/)
})

test('desktop media sidecars are staged, packaged, and documented', () => {
  const config = read('electron-builder.yml')
  const main = read('desktop/main.js')
  const packageJson = JSON.parse(read('package.json'))
  const stagingScript = read('scripts/prepare-media-sidecars.mjs')
  const envExample = read('.env.example')
  const readme = read('README.md')
  const releaseGuide = read('docs/DESKTOP_RELEASES.md')
  const notices = read('THIRD_PARTY_NOTICES.md')
  const provenance = read('resources/licenses/FFMPEG-SIDECARS.md')
  const gpl = read('resources/licenses/GPL-3.0.txt')

  assert.match(config, /extraResources:[\s\S]*from:\s*resources\/bin/)
  assert.match(config, /extraResources:[\s\S]*to:\s*bin/)
  assert.match(config, /extraResources:[\s\S]*-\s*ffmpeg\.exe/)
  assert.match(config, /extraResources:[\s\S]*-\s*ffprobe\.exe/)
  assert.match(config, /extraResources:[\s\S]*from:\s*LICENSE[\s\S]*to:\s*LICENSE/)
  assert.match(config, /extraResources:[\s\S]*from:\s*THIRD_PARTY_NOTICES\.md/)
  assert.match(config, /extraResources:[\s\S]*from:\s*resources\/licenses[\s\S]*to:\s*licenses/)
  assert.match(packageJson.scripts['desktop:media-sidecars'], /prepare-media-sidecars\.mjs/)
  assert.match(packageJson.scripts['desktop:package'], /^npm run desktop:media-sidecars && electron-builder/)
  assert.match(packageJson.scripts['desktop:publish'], /npm run desktop:media-sidecars && electron-builder/)
  assert.equal(packageJson.devDependencies['@ffmpeg-installer/ffmpeg'], '1.1.0')
  assert.equal(packageJson.devDependencies['@ffprobe-installer/ffprobe'], '2.1.2')
  assert.match(main, /GUGO_FFMPEG_PATH\s*\|\|=\s*path\.join\(process\.resourcesPath, 'bin', 'ffmpeg\.exe'\)/)
  assert.match(main, /GUGO_FFPROBE_PATH\s*\|\|=\s*path\.join\(process\.resourcesPath, 'bin', 'ffprobe\.exe'\)/)
  assert.match(stagingScript, /GUGO_FFMPEG_PATH/)
  assert.match(stagingScript, /GUGO_FFPROBE_PATH/)
  assert.match(stagingScript, /@ffmpeg-installer\/ffmpeg/)
  assert.match(stagingScript, /@ffprobe-installer\/ffprobe/)
  assert.match(stagingScript, /wrapper\?\.path/)
  assert.match(stagingScript, /spawnSync\(candidate, \['-version'\]/)
  assert.equal(fs.existsSync(new URL('../resources/bin/README.md', import.meta.url)), true)
  assert.match(envExample, /GUGO_FFMPEG_PATH=.*ffmpeg\.exe/)
  assert.match(envExample, /GUGO_FFPROBE_PATH=.*ffprobe\.exe/)
  assert.match(readme, /GUGO_FFMPEG_PATH.*GUGO_FFPROBE_PATH/)
  assert.match(releaseGuide, /npm run desktop:media-sidecars/)
  assert.match(releaseGuide, /resources\/bin\/ffmpeg\.exe/)
  assert.match(releaseGuide, /resources\/bin\/ffprobe\.exe/)
  assert.match(notices, /N-92722-gf22fcd4483/)
  assert.match(notices, /2023-02-13-git-2296078397/)
  assert.match(notices, /GNU General Public License version 3/)
  assert.match(provenance, /@ffmpeg-installer\/win32-x64@4\.1\.0/)
  assert.match(provenance, /@ffprobe-installer\/win32-x64@5\.1\.0/)
  assert.match(provenance, /C8ABC49E7BE62DDE8E12972AF373959E0076A7B8DC8040EB45978E0608F8781E/)
  assert.match(provenance, /F28C4751E7367205267025AAF0FCFC921E34D9B7EDAA46BD9C8ABAF367FC9051/)
  assert.match(gpl, /GNU GENERAL PUBLIC LICENSE[\s\S]*Version 3, 29 June 2007/)

  assert.deepEqual(WINDOWS_MEDIA_SIDECARS.map(({ name, envName, fileName }) => ({
    name,
    envName,
    fileName,
  })), [
    { name: 'ffmpeg', envName: 'GUGO_FFMPEG_PATH', fileName: 'ffmpeg.exe' },
    { name: 'ffprobe', envName: 'GUGO_FFPROBE_PATH', fileName: 'ffprobe.exe' },
  ])
})

test('native image libraries ship cross-platform LGPL notices', () => {
  const config = read('electron-builder.yml')
  const dockerfile = read('Dockerfile')
  const notices = read('THIRD_PARTY_NOTICES.md')
  const licenseCheck = read('scripts/check-licenses.mjs')
  const lgpl = read('resources/licenses/LGPL-3.0.txt')

  assert.match(config, /extraResources:[\s\S]*from:\s*resources\/licenses[\s\S]*to:\s*licenses/)
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md \.\//)
  assert.match(dockerfile, /COPY resources\/licenses \.\/resources\/licenses/)
  assert.match(notices, /## Sharp and libvips[\s\S]*LGPL-3\.0-or-later/)
  assert.match(notices, /resources\/licenses\/LGPL-3\.0\.txt/)
  assert.match(licenseCheck, /'LGPL-3\.0-or-later'/)
  assert.match(lgpl, /GNU LESSER GENERAL PUBLIC LICENSE[\s\S]*Version 3, 29 June 2007/)
})

test('desktop media sidecar staging fails closed when a required binary is absent', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-sidecar-package-'))
  try {
    assert.throws(
      () => stageMediaSidecars({
        rootDir,
        platform: 'win32',
        env: { PATH: '', PATHEXT: '.EXE' },
        lockedResolver: null,
      }),
      /ffmpeg was not found in locked dependency.*GUGO_FFMPEG_PATH/,
    )
    assert.equal(fs.existsSync(path.join(rootDir, 'resources')), false)
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('desktop media sidecars stage from locked npm binaries with a clean PATH', {
  skip: process.platform !== 'win32' && 'locked Windows optional dependencies are installed only on Windows',
}, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-sidecar-locked-'))
  const copied = []
  const verified = []
  try {
    const staged = stageMediaSidecars({
      rootDir,
      platform: 'win32',
      env: { PATH: '', Path: '', PATHEXT: '.EXE' },
      verify(candidate, name) {
        assert.equal(fs.statSync(candidate).isFile(), true)
        verified.push({ candidate, name })
      },
      copy(source, target) {
        copied.push({ source, target })
        fs.writeFileSync(target, `staged from ${source}`, 'utf8')
      },
    })

    assert.equal(staged.length, 2)
    assert.equal(copied.length, 2)
    assert.equal(verified.length, 4)
    for (const item of staged) {
      assert.equal(item.sourceType, 'locked-dependency')
      const expected = resolveLockedMediaSidecar({
        packageName: item.packageName,
        platform: 'win32',
      })
      assert.ok(expected)
      assert.equal(path.resolve(item.source).toLowerCase(), path.resolve(expected).toLowerCase())
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('explicit media sidecar paths remain higher priority than the locked resolver', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-sidecar-explicit-'))
  const sourceDirectory = path.join(rootDir, 'configured')
  fs.mkdirSync(sourceDirectory, { recursive: true })
  const ffmpegPath = path.join(sourceDirectory, 'ffmpeg.exe')
  const ffprobePath = path.join(sourceDirectory, 'ffprobe.exe')
  fs.writeFileSync(ffmpegPath, 'configured ffmpeg')
  fs.writeFileSync(ffprobePath, 'configured ffprobe')
  try {
    const staged = stageMediaSidecars({
      rootDir,
      platform: 'win32',
      env: {
        PATH: '',
        PATHEXT: '.EXE',
        GUGO_FFMPEG_PATH: ffmpegPath,
        GUGO_FFPROBE_PATH: ffprobePath,
      },
      lockedResolver() {
        throw new Error('explicit paths must bypass the locked resolver')
      },
      verify() {},
      copy: fs.copyFileSync,
    })
    assert.deepEqual(staged.map(({ sourceType }) => sourceType), ['environment', 'environment'])
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
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
  assert.match(main, /window\.setMovable\(true\)/)
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
  const visibility = main.slice(main.indexOf('function applyPetVisibility'), main.indexOf('function assertTrustedIpc'))
  assert.match(visibility, /window\.destroy\(\)/, 'hiding must destroy a renderer that may still own pointer capture')
  assert.doesNotMatch(visibility, /petWindow\?\.hide\(\)/, 'a hidden captured renderer must never be reused')
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
  assert.match(main, /window\.setBounds\(move\.bounds, false\)/)
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
  assert.doesNotMatch(pointerDown, /captureActivePointer\(drag\)/, 'a click must not capture the OS pointer')
  const pointerMoveStart = renderer.indexOf('const handlePointerMove')
  const pointerMove = renderer.slice(pointerMoveStart, renderer.indexOf('const finishPointer', pointerMoveStart))
  assert.match(pointerMove, /captureActivePointer\(drag\)/, 'capture starts only after a real drag')
  assert.doesNotMatch(renderer, /onPointerLeave=/)
  assert.match(renderer, /data-reacting/)
  assert.doesNotMatch(renderer, /setFrame|pet-window-copy|pet-window-close/)
  assert.match(standaloneCss, /\.pet-window-root\s*\{[\s\S]*?padding:\s*0;/)
  assert.match(standaloneCss, /-webkit-app-region:\s*no-drag/)
  assert.doesNotMatch(standaloneCss, /drop-shadow|filter\s*:/)
})

test('desktop pet drag can cross monitor boundaries without being clamped', () => {
  const main = read('desktop/main.js')
  const start = main.indexOf('function handlePetDrag')
  const end = main.indexOf('function registerDesktopIpc', start)
  const dragHandler = main.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(dragHandler, /screen\.getCursorScreenPoint\(\)/)
  assert.match(dragHandler, /window\.setBounds\(move\.bounds, false\)/)
  assert.doesNotMatch(dragHandler, /clampPetBounds/, 'dragging must remain free across the virtual desktop')
})

test('desktop pet drag ignores synthetic movement and keeps a fixed hit area', () => {
  const session = createDesktopPetDragSession({
    senderId: 7,
    cursor: { x: 400, y: 300 },
    bounds: { x: 360, y: 260, width: 73, height: 79 },
  })
  assert.ok(session)

  const stationary = resolveDesktopPetDragMove(session, { x: 400, y: 300 })
  assert.equal(stationary.accepted, false)
  assert.equal(stationary.reason, 'stationary')

  const moved = resolveDesktopPetDragMove(session, { x: 460, y: 330 })
  assert.equal(moved.accepted, true)
  assert.deepEqual(moved.bounds, { x: 420, y: 290, width: 73, height: 79 })

  const returned = resolveDesktopPetDragMove(moved.session, { x: 400, y: 300 })
  assert.equal(returned.accepted, true)
  assert.deepEqual(returned.bounds, { x: 360, y: 260, width: 73, height: 79 })
})

test('version tags publish a Windows installer and updater metadata through GitHub Releases', () => {
  const workflow = read('.github/workflows/release.yml')
  assert.match(workflow, /runs-on:\s*windows-latest/)
  assert.match(workflow, /tags:\s*\n\s*- 'v\*\.\*\.\*'/)
  assert.match(workflow, /\.Extension -eq '\.exe'/)
  assert.match(workflow, /\.Name -eq 'latest\.yml'/)
  assert.match(workflow, /contents:\s*write/)
  assert.match(workflow, /- run:\s*npm ci[\s\S]*- name:\s*Package Windows desktop installer[\s\S]*npm run desktop:package/)
  assert.doesNotMatch(workflow, /choco\s+install\s+ffmpeg|winget\s+install\s+ffmpeg/i)
  assert.doesNotMatch(workflow, /GUGO_FFMPEG_PATH|GUGO_FFPROBE_PATH/)
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
