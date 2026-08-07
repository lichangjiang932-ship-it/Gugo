import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

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

test('desktop pet uses an independent transparent always-on-top window', () => {
  const main = read('desktop/main.js')
  const preload = read('desktop/preload.cjs')
  assert.match(main, /function createPetWindow/)
  assert.match(main, /transparent:\s*true/)
  assert.match(main, /alwaysOnTop:\s*true/)
  assert.match(main, /skipTaskbar:\s*true/)
  assert.match(main, /frame:\s*false/)
  assert.match(main, /setAlwaysOnTop\(true, 'floating'\)/)
  assert.match(main, /if \(!mainWindow && applicationOrigin\)/)
  assert.match(preload, /setPetVisible/)
  assert.match(preload, /updatePetStatus/)
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
  const updateNotice = rail.indexOf('<DesktopUpdateCard />', accountRegion)
  const accountButton = rail.indexOf('aria-expanded={accountMenuOpen}', accountRegion)

  assert.ok(accountRegion >= 0)
  assert.ok(updateNotice > accountRegion)
  assert.ok(accountButton > updateNotice)
  assert.match(card, /data-desktop-update-notice="primary"/)
  assert.match(card, /border-ember\/35 bg-ember\/10/)
})
